#!/usr/bin/env node
// ============================================================
// hooks/prompt-recall.mjs — mneme UserPromptSubmit auto-recall
// ============================================================
// Optional Claude Code hook that reads the user prompt, checks it against a
// small trigger set (infrastructure / operational lookups where memory helps
// most), runs a mneme recall through the CLI, and injects the top hits back
// into the conversation via `hookSpecificOutput.additionalContext`.
//
// Wire it in ~/.claude/settings.json:
//
//   {
//     "hooks": {
//       "UserPromptSubmit": [{
//         "hooks": [{
//           "type": "command",
//           "command": "node /abs/path/to/mneme/hooks/prompt-recall.mjs",
//           "timeout": 5
//         }]
//       }]
//     }
//   }
//
// Configuration (all optional — sensible defaults):
//   MNEME_DB_PATH          alias for TOKENMEM_DB_PATH; where mneme's engram.db lives
//   MNEME_INDEX_PATH       override for index.mjs (default: ../index.mjs)
//   MNEME_MIN_IMPORTANCE   floor for hits (default: 6)
//   MNEME_LEVEL            recall level filter (default: meta_knowledge)
//   MNEME_LIMIT            max recall candidates (default: 5)
//   MNEME_MIN_CONSENSUS    hide injection if hits < this (default: 2)
//   MNEME_STATE_DIR        session-dedup file dir (default: ~/.claude/hooks)
//   MNEME_TIMEOUT_MS       spawn timeout (default: 2800)
//
// Design notes:
//   - fast path only. Semantic recall would require an embedding key at
//     the client — out of scope for a zero-config default. Add it in a
//     downstream fork if you need it.
//   - DETECTION ONLY. Any error (missing DB, spawn crash, timeout) exits 0
//     silently — never breaks the user prompt.
//   - Session-scoped dedup: same rowid never re-injected within a session.

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOME = process.env.USERPROFILE || process.env.HOME || __dirname

// Parse a positive integer env var. Silently falls back to `fallback` on
// missing, non-numeric, negative, or NaN values — hook is fail-soft, we
// don't want a bad env like MNEME_TIMEOUT_MS=abc leaking a TimeoutNaNWarning
// to stderr and violating the "silent" contract.
function intEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

const CFG = {
  // Prefer the already-running HTTP server: it holds the DB, extensions and
  // embedding config warm, so a recall costs a local round trip instead of a
  // full node cold start (~6ms vs ~1.6s measured). Falls back to spawning the
  // CLI when the server is down, so this stays a speedup and never a new
  // single point of failure.
  httpUrl: process.env.MNEME_HTTP_URL || 'http://127.0.0.1:18792/recall',
  // Deliberately much shorter than the CLI budget: a healthy server answers in
  // single-digit ms, so anything slower means it is unwell and we should be
  // spawning already rather than paying both costs.
  httpTimeoutMs: intEnv('MNEME_HTTP_TIMEOUT_MS', 800),
  indexPath: process.env.MNEME_INDEX_PATH || resolve(__dirname, '..', 'index.mjs'),
  minImportance: intEnv('MNEME_MIN_IMPORTANCE', 6),
  level: process.env.MNEME_LEVEL || 'meta_knowledge',
  limit: intEnv('MNEME_LIMIT', 5),
  minConsensus: intEnv('MNEME_MIN_CONSENSUS', 2),
  stateDir: process.env.MNEME_STATE_DIR || resolve(HOME, '.claude', 'hooks'),
  timeoutMs: intEnv('MNEME_TIMEOUT_MS', 2800),
}

// Generic trigger set. Covers "how do I / where is / what's the path" style
// lookups — the shape that benefits most from persistent memory. Kept
// deliberately narrow to avoid db pressure on every prompt.
const TRIGGERS = [
  // How-to / where-is / operations
  /\bhow\s+(?:to|do|does|can)\b/i,
  /\bwhere\s+(?:is|are|do|does)\b/i,
  /\bwhat(?:'s| is)\s+the\s+(?:path|port|config|command|key|token|url|endpoint)\b/i,
  /怎么(?:启|跑|运行|开|连|装|配|改|修|登|连接|设置)/,
  /(?:在|放在|位于|装在)哪/,
  /如何(?:启动|运行|配置|连接|登录|使用|安装)/,

  // Infrastructure / config nouns
  /\b(?:path|port|token|api[\s_-]?key|env|environment|config|settings?)\b/i,
  /\b(?:daemon|service|process|script|binary|executable)\b/i,
  /\b(?:restart|start|stop|spawn|launch)\b/i,
  /(?:路径|目录|位置|端口|凭证|密钥|环境变量|配置|脚本|工具|命令|启动|重启|守护进程)/,
]

function shouldTrigger(prompt) {
  if (!prompt || prompt.length < 4) return false
  if (prompt.length > 1500) return false  // long paste — probably not a lookup
  return TRIGGERS.some(re => re.test(prompt))
}

function stateFilePath(sessionId) {
  const safe = (sessionId || 'unknown').replace(/[^\w-]/g, '_').slice(0, 36)
  return resolve(CFG.stateDir, `.mneme-prompt-recall-injected-${safe}.json`)
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
    const ids = Array.from(idSet).slice(-200)  // cap file size
    // Atomic write: full-content write to a per-pid temp, then rename. A
    // kill between write and rename leaves the previous state file intact
    // (no truncated JSON, no lost dedup). Orphaned .tmp files from a
    // crashed process will be overwritten by the next same-pid save.
    writeFileSync(tmp, JSON.stringify({ ids, ts: Date.now() }))
    renameSync(tmp, p)
  } catch { /* best-effort */ }
}

function passThroughDbEnv() {
  // MNEME_DB_PATH is the user-facing alias. mneme's engine reads
  // TOKENMEM_DB_PATH — bridge it here so users only need to set one.
  const env = { ...process.env }
  if (env.MNEME_DB_PATH && !env.TOKENMEM_DB_PATH) {
    env.TOKENMEM_DB_PATH = env.MNEME_DB_PATH
  }
  return env
}

// Ask the warm server first. Any failure at all — server down, timeout, bad
// JSON, non-200 — returns null so the caller spawns the CLI instead.
async function recallOverHttp(body) {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), CFG.httpTimeoutMs)
    const headers = { 'Content-Type': 'application/json' }
    if (process.env.MNEME_HOST_TOKEN) headers.Authorization = `Bearer ${process.env.MNEME_HOST_TOKEN}`
    const r = await fetch(CFG.httpUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal })
    clearTimeout(t)
    if (!r.ok) return null
    const j = await r.json()
    return Array.isArray(j?.hits) ? j : null
  } catch { return null }
}
async function runRecall(query, sessionId) {
  const viaHttp = await recallOverHttp({
    query: query,
    limit: CFG.limit,
    min_importance: CFG.minImportance,
    level: CFG.level,
    source: 'mneme-prompt-recall',
    session_id: sessionId,
  })
  if (viaHttp) return viaHttp

  const args = [
    CFG.indexPath,
    '--recall', query,
    '--format', 'json',
    '--min-importance', String(CFG.minImportance),
    '--level', CFG.level,
    '--limit', String(CFG.limit),
    '--source', 'mneme-prompt-recall',
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
  const body = (h.content || '').slice(0, 300).replace(/\n+/g, ' ')
  const trailer = (h.content || '').length > 300 ? '...' : ''
  return `[id:${h.id} ★${h.importance} ${h.memory_level || 'semi_abstract'}]${tags}${sum}\n  ${body}${trailer}`
}

// ── main ─────────────────────────────────────────────────
let input = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', d => input += d)
process.stdin.on('end', async () => {
  let payload = {}
  try { payload = JSON.parse(input || '{}') } catch { process.exit(0) }

  const sessionId = payload.session_id || payload.sessionId || 'unknown'
  const prompt = (payload.prompt || '').trim()

  if (!shouldTrigger(prompt)) process.exit(0)

  const query = prompt.slice(0, 500)
  const recalled = await runRecall(query, sessionId)
  if (!recalled || !Array.isArray(recalled.hits)) process.exit(0)

  const hits = recalled.hits
  if (hits.length < CFG.minConsensus) process.exit(0)

  const injected = loadInjected(sessionId)
  const fresh = hits.filter(h => !injected.has(h.id))
  if (fresh.length === 0) process.exit(0)

  const top = fresh.slice(0, 3)
  const additionalContext =
    `🧠 [mneme recall] Your prompt overlaps with ${top.length} stored memories (importance ≥ ${CFG.minImportance}). ` +
    `Skim them before grepping or guessing — if something is stale, tell the user which id to supersede.\n\n` +
    top.map(formatHit).join('\n\n')

  for (const h of top) injected.add(h.id)
  saveInjected(sessionId, injected)

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  }))
  process.exit(0)
})

// Safety net AND event-loop lifeline. Deliberately NOT unref()d: the stdin
// handler is async, so after the first await the synchronous frame returns and
// stdin is already closed. With nothing else referencing the loop Node exits 0
// before fetch can even open its socket — the hook goes silent and no recall
// happens at all. A ref()d timer keeps the loop alive; every completion path
// calls process.exit(0) explicitly, so this deadline is never actually waited on.
setTimeout(() => process.exit(0), CFG.timeoutMs + 200)
