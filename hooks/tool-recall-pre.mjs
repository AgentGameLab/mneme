#!/usr/bin/env node
// ============================================================
// hooks/tool-recall-pre.mjs — mneme PreToolUse auto-recall
// ============================================================
// Optional Claude Code hook that fires before Bash / Grep / Read / Glob calls.
// Pulls a short query out of the tool arguments, runs a mneme recall, and if
// there are hits, injects them as `hookSpecificOutput.additionalContext` so
// the agent sees relevant prior context before running the tool.
//
// Wire it in ~/.claude/settings.json:
//
//   {
//     "hooks": {
//       "PreToolUse": [{
//         "matcher": "Bash|Grep|Read|Glob",
//         "hooks": [{
//           "type": "command",
//           "command": "node /abs/path/to/mneme/hooks/tool-recall-pre.mjs",
//           "timeout": 5
//         }]
//       }]
//     }
//   }
//
// Configuration — same env vars as prompt-recall.mjs, with these tunables:
//   MNEME_TOOL_MIN_IMPORTANCE   default 6
//   MNEME_TOOL_LEVEL            default 'meta_knowledge,semi_abstract'
//   MNEME_TOOL_LIMIT            default 4
//   MNEME_TOOL_QUERY_LEN        max chars of tool arg to use as query (default 120)
//
// Design notes:
//   - DETECTION ONLY. Any error → exit 0 silently.
//   - Session-scoped dedup shared with prompt-recall via a separate file.

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOME = process.env.USERPROFILE || process.env.HOME || __dirname

// Parse a positive integer env var, silently falling back on bad input.
// See the identical helper in prompt-recall.mjs — kept duplicated because
// these two hooks are meant to be individually copyable.
function intEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

const CFG = {
  indexPath: process.env.MNEME_INDEX_PATH || resolve(__dirname, '..', 'index.mjs'),
  minImportance: intEnv('MNEME_TOOL_MIN_IMPORTANCE', 6),
  level: process.env.MNEME_TOOL_LEVEL || 'meta_knowledge,semi_abstract',
  limit: intEnv('MNEME_TOOL_LIMIT', 4),
  queryLen: intEnv('MNEME_TOOL_QUERY_LEN', 120),
  stateDir: process.env.MNEME_STATE_DIR || resolve(HOME, '.claude', 'hooks'),
  timeoutMs: intEnv('MNEME_TIMEOUT_MS', 2800),
  // v2.8: alias cache — how long to reuse the last --list-paths snapshot
  // instead of re-spawning the CLI. Kept short so cross-session updates land
  // fast, but non-zero so back-to-back tool calls don't each spawn a probe.
  aliasCacheTtlMs: intEnv('MNEME_ALIAS_CACHE_TTL_MS', 5 * 60 * 1000),
}

// Extract a short recall query from tool arguments.
// - Bash: the first significant token(s) from the command line
// - Grep: the search pattern (already a query)
// - Read: the file basename (path itself is noisy — basename is the concept)
// - Glob: the pattern (skip if it's just `**/*.ext`)
function extractQuery(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return ''
  switch (toolName) {
    case 'Bash': {
      const cmd = String(toolInput.command || '').trim()
      if (!cmd) return ''
      // First 3-4 tokens usually carry the "what am I doing" signal
      const head = cmd.split(/\s+/).slice(0, 4).join(' ')
      return head.slice(0, CFG.queryLen)
    }
    case 'Grep': {
      const p = String(toolInput.pattern || '').trim()
      return p.slice(0, CFG.queryLen)
    }
    case 'Read': {
      const path = String(toolInput.file_path || '').trim()
      if (!path) return ''
      // Strip ALL trailing extensions, not just the last one — `foo.test.mjs`
      // and `user.service.spec.ts` should both reduce to the actual concept.
      const bare = basename(path).replace(/(\.[A-Za-z0-9]+)+$/, '')
      return bare.slice(0, CFG.queryLen)
    }
    case 'Glob': {
      const pattern = String(toolInput.pattern || '').trim()
      if (!pattern) return ''
      // Strip glob metachars / separators / dots and see what stem is left.
      // We accept stems ≥ 2 chars as long as they contain at least one letter,
      // so `src/*` and `lib/*` survive while `**/*.mjs` (stem "mjs" — all
      // letters but ext-shaped) still passes; `**/*.js` (stem "js" — 2 chars)
      // will pass too, that's fine — the recall itself is cheap.
      const stem = pattern.replace(/[*?/\\.]+/g, ' ').replace(/\s+/g, ' ').trim()
      if (stem.length < 3 || !/[A-Za-z一-鿿]/.test(stem)) return ''
      return stem.slice(0, CFG.queryLen)
    }
    default:
      return ''
  }
}

function stateFilePath(sessionId) {
  const safe = (sessionId || 'unknown').replace(/[^\w-]/g, '_').slice(0, 36)
  return resolve(CFG.stateDir, `.mneme-tool-recall-injected-${safe}.json`)
}

function loadInjected(sessionId) {
  try {
    const p = stateFilePath(sessionId)
    if (!existsSync(p)) return new Set()
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    return new Set(Array.isArray(data.ids) ? data.ids : [])
  } catch { return new Set() }
}

function saveInjected(sessionId, idSet) {
  try {
    if (!existsSync(CFG.stateDir)) mkdirSync(CFG.stateDir, { recursive: true })
    const p = stateFilePath(sessionId)
    const tmp = p + '.tmp-' + process.pid
    const ids = Array.from(idSet).slice(-200)
    // Atomic write: write to temp then rename. A kill between write and
    // rename leaves the previous state file intact instead of a truncated
    // JSON that would evaporate session dedup on the next load.
    writeFileSync(tmp, JSON.stringify({ ids, ts: Date.now() }))
    renameSync(tmp, p)
  } catch { /* best-effort */ }
}

function passThroughDbEnv() {
  const env = { ...process.env }
  if (env.MNEME_DB_PATH && !env.TOKENMEM_DB_PATH) {
    env.TOKENMEM_DB_PATH = env.MNEME_DB_PATH
  }
  return env
}

function runRecall(query, sessionId) {
  const args = [
    CFG.indexPath,
    '--recall', query,
    '--format', 'json',
    '--min-importance', String(CFG.minImportance),
    '--level', CFG.level,
    '--limit', String(CFG.limit),
    '--source', 'mneme-tool-recall',
    '--session-id', sessionId,
  ]
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf-8',
    timeout: CFG.timeoutMs,
    env: passThroughDbEnv(),
  })
  if (r.status !== 0 || r.error) return null
  const lines = (r.stdout || '').split('\n').filter(Boolean)
  for (const line of lines) {
    if (line.startsWith('{')) {
      try { return JSON.parse(line) } catch {}
    }
  }
  return null
}

function formatHit(h) {
  const tags = h.tags?.length ? ` #${h.tags.slice(0, 3).join(' #')}` : ''
  const sum = h.summary ? `\n  📌 ${h.summary}` : ''
  const body = (h.content || '').slice(0, 240).replace(/\n+/g, ' ')
  const trailer = (h.content || '').length > 240 ? '...' : ''
  return `[id:${h.id} ★${h.importance}]${tags}${sum}\n  ${body}${trailer}`
}

// ── v2.8 alias layer ─────────────────────────────────────────
// A session-scoped cache of `--list-paths --format json`. On tool fire we
// pull short identifier-shaped tokens out of the tool arguments and check
// them against known names / aliases; matches inject a definite path
// alongside (not instead of) the FTS+vec recall — the alias tells you WHERE
// the thing is; the memory tells you WHY it exists.

// Key the cache path by a hash of the resolved DB path + index path so that
// two mneme installs (or two databases under the same state dir) don't
// leak locations across each other. `resolved-db` is the env-visible DB
// the CLI would open; `index-path` is which mneme codebase this hook wires
// to. Different pairs → different cache files.
function fingerprintForCache() {
  const dbEnv = process.env.MNEME_DB_PATH || process.env.TOKENMEM_DB_PATH || ''
  const h = createHash('sha256').update(dbEnv + '\0' + CFG.indexPath).digest('hex').slice(0, 12)
  return h
}
const ALIAS_CACHE_PATH = resolve(CFG.stateDir, `.mneme-locations-cache-${fingerprintForCache()}.json`)

function loadAliasCache() {
  try {
    if (!existsSync(ALIAS_CACHE_PATH)) return null
    const data = JSON.parse(readFileSync(ALIAS_CACHE_PATH, 'utf-8'))
    if (!Array.isArray(data.locations)) return null
    if (typeof data.ts !== 'number' || Date.now() - data.ts > CFG.aliasCacheTtlMs) return null
    return data.locations
  } catch { return null }
}

function refreshAliasCache() {
  const args = [CFG.indexPath, '--list-paths', '--format', 'json']
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf-8',
    timeout: Math.min(CFG.timeoutMs, 1500),
    env: passThroughDbEnv(),
  })
  if (r.status !== 0 || r.error) return null
  // The CLI prints startup logs to stderr; stdout is one JSON array. Walk
  // stdout for the first `[` at the start of a line — resistant to any prefix
  // a future release might emit before the payload.
  const stdout = r.stdout || ''
  let locations = null
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('[')) {
      try { locations = JSON.parse(line + stdout.slice(stdout.indexOf(line) + line.length)) } catch {}
      if (locations !== null) break
    }
  }
  if (!Array.isArray(locations)) {
    // Fallback: the JSON might straddle newlines. Try from the first '[' char.
    const idx = stdout.indexOf('[')
    if (idx === -1) return null
    try { locations = JSON.parse(stdout.slice(idx)) } catch { return null }
    if (!Array.isArray(locations)) return null
  }
  try {
    if (!existsSync(CFG.stateDir)) mkdirSync(CFG.stateDir, { recursive: true })
    const tmp = ALIAS_CACHE_PATH + '.tmp-' + process.pid
    writeFileSync(tmp, JSON.stringify({ locations, ts: Date.now() }))
    renameSync(tmp, ALIAS_CACHE_PATH)
  } catch { /* cache write is best-effort */ }
  return locations
}

function ensureAliasCache() {
  return loadAliasCache() ?? refreshAliasCache()
}

// Pull identifier-shaped tokens out of the tool arguments. We want strings
// that could plausibly be a registered alias (short, no slashes, no dots),
// and reject the obviously-not (long code, file paths, etc.).
function extractAliasCandidates(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return []
  let source = ''
  switch (toolName) {
    case 'Bash':
      source = String(toolInput.command || '')
      break
    case 'Grep':
      source = [toolInput.pattern, toolInput.path, toolInput.glob].filter(Boolean).join(' ')
      break
    case 'Read':
      source = String(toolInput.file_path || '')
      break
    case 'Glob':
      source = [toolInput.pattern, toolInput.path].filter(Boolean).join(' ')
      break
    default:
      return []
  }
  if (!source) return []
  // Split on whitespace + path separators. Keep tokens matching the alias shape:
  // 2-40 chars, alphanumeric plus _-, plus CJK; exclude anything with a dot
  // (looks like extension) or that is a common shell keyword.
  const SHELL_STOP = new Set([
    'cd', 'ls', 'cat', 'echo', 'node', 'npm', 'npx', 'git', 'grep', 'sed', 'awk',
    'if', 'then', 'else', 'fi', 'for', 'do', 'done', 'while', 'exit', 'return',
    'sudo', 'pwd', 'export', 'source', 'env', 'set',
  ])
  const seen = new Set()
  const out = []
  for (const token of source.split(/[\s/\\:]+/)) {
    const t = token.trim()
    if (!t) continue
    if (t.includes('.')) continue
    if (t.length < 2 || t.length > 40) continue
    if (!/^[A-Za-z0-9_\-一-鿿]+$/.test(t)) continue
    if (SHELL_STOP.has(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= 8) break
  }
  return out
}

function matchAliases(candidates, locations) {
  if (!candidates || candidates.length === 0 || !locations || locations.length === 0) return []
  const nameMap = new Map()
  const aliasMap = new Map()
  for (const row of locations) {
    nameMap.set(row.name, row)
    for (const a of row.aliases || []) {
      if (!aliasMap.has(a)) aliasMap.set(a, row)
    }
  }
  const hits = []
  const seenRow = new Set()
  for (const c of candidates) {
    const row = nameMap.get(c) || aliasMap.get(c)
    if (row && !seenRow.has(row.name)) {
      seenRow.add(row.name)
      hits.push({ matched: c, ...row })
    }
  }
  return hits
}

function formatAliasBanner(hits) {
  const lines = hits.map(h => {
    const via = h.matched === h.name ? '' : ` (via alias "${h.matched}")`
    const notes = h.notes ? ` — ${h.notes}` : ''
    return `  ${h.name} → ${h.path}  [${h.kind}]${via}${notes}`
  })
  return `📍 [mneme locations] ${hits.length} known path${hits.length > 1 ? 's' : ''} in this call — resolve to the registered path instead of guessing or globbing:\n${lines.join('\n')}`
}

// ── main ─────────────────────────────────────────────────
let input = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', d => input += d)
process.stdin.on('end', () => {
  let payload = {}
  try { payload = JSON.parse(input || '{}') } catch { process.exit(0) }

  const sessionId = payload.session_id || payload.sessionId || 'unknown'
  const toolName = payload.tool_name || ''
  const toolInput = payload.tool_input || {}

  // v2.8: alias front-load. Cheap and definite — if any candidate token
  // matches a registered location, emit the resolution banner. This does
  // not block or replace the FTS+vec recall below; the two compose.
  const aliasBanners = []
  try {
    const candidates = extractAliasCandidates(toolName, toolInput)
    if (candidates.length > 0) {
      const cache = ensureAliasCache()
      if (cache && cache.length > 0) {
        const hits = matchAliases(candidates, cache)
        if (hits.length > 0) aliasBanners.push(formatAliasBanner(hits))
      }
    }
  } catch { /* alias front-load is best-effort */ }

  const query = extractQuery(toolName, toolInput)
  let recallSection = ''
  if (query && query.length >= 3) {
    const recalled = runRecall(query, sessionId)
    const hits = recalled?.hits || []
    if (hits.length > 0) {
      const injected = loadInjected(sessionId)
      const fresh = hits.filter(h => !injected.has(h.id))
      if (fresh.length > 0) {
        const top = fresh.slice(0, 3)
        recallSection =
          `🔧 [mneme tool-recall] Before running \`${toolName}\`, mneme found ${top.length} memory hit(s) related to the arguments. ` +
          `Check them — you may be able to skip the tool call entirely, or you'll at least have the context.\n\n` +
          top.map(formatHit).join('\n\n')
        for (const h of top) injected.add(h.id)
        saveInjected(sessionId, injected)
      }
    }
  }

  if (!aliasBanners.length && !recallSection) process.exit(0)

  const additionalContext = [...aliasBanners, recallSection].filter(Boolean).join('\n\n')
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext,
    },
  }))
  process.exit(0)
})

setTimeout(() => process.exit(0), CFG.timeoutMs + 200).unref()
