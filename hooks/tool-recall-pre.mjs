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

// ── main ─────────────────────────────────────────────────
let input = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', d => input += d)
process.stdin.on('end', () => {
  let payload = {}
  try { payload = JSON.parse(input || '{}') } catch { process.exit(0) }

  const sessionId = payload.session_id || payload.sessionId || 'unknown'
  const toolName = payload.tool_name || ''
  const query = extractQuery(toolName, payload.tool_input || {})
  if (!query || query.length < 3) process.exit(0)

  const recalled = runRecall(query, sessionId)
  if (!recalled || !Array.isArray(recalled.hits)) process.exit(0)

  const hits = recalled.hits
  if (hits.length === 0) process.exit(0)

  const injected = loadInjected(sessionId)
  const fresh = hits.filter(h => !injected.has(h.id))
  if (fresh.length === 0) process.exit(0)

  const top = fresh.slice(0, 3)
  const additionalContext =
    `🔧 [mneme tool-recall] Before running \`${toolName}\`, mneme found ${top.length} memory hit(s) related to the arguments. ` +
    `Check them — you may be able to skip the tool call entirely, or you'll at least have the context.\n\n` +
    top.map(formatHit).join('\n\n')

  for (const h of top) injected.add(h.id)
  saveInjected(sessionId, injected)

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext,
    },
  }))
  process.exit(0)
})

setTimeout(() => process.exit(0), CFG.timeoutMs + 200).unref()
