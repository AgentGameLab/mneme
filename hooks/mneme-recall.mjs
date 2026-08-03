#!/usr/bin/env node
// UserPromptSubmit hook · mneme cross-project memory recall (LIVE MODE v0.3)
//
// Lives in the engine repo on purpose. v0.2 lived in `~/.claude/hooks/`, i.e.
// outside any repo — nobody could review it, and it drifted from the engine it
// imports. Same lesson as PR #19 shipping `scripts/transcript-sweep.mjs` with
// the engine: one live copy of a runner, next to the code it calls.
//
// ── Why v0.3 exists ────────────────────────────────────────────────────────
// v0.2 called `recallMemories()` (FTS-only). The obvious "upgrade" is to swap
// in `recallMemoriesHybrid()` — and on its own that swap is a NO-OP:
//
//   `_embeddingConfig` is only assigned inside `initMemory()`. A hook that
//   `import`s index.mjs and calls recall directly goes through `getDb()` and
//   never touches initMemory(), so `_embeddingConfig` stays null and
//   recallMemoriesHybrid() takes its fallback branch and returns plain FTS
//   rows. Measured: identical rowids in identical order, ~2ms, zero network —
//   while the embedding endpoint itself answers fine (221ms, 1024d, HTTP 200).
//
// So the hybrid switch needs three things together, not one:
//   1. load `.env.local` (EMBEDDING_API_*) before initMemory()  — same reason
//      mcp-server.mjs does it: hooks are spawned without the user's shell env
//   2. actually call initMemory()
//   3. a latency guard — hybrid is p50 ~258ms and was measured at 2979ms cold,
//      and UserPromptSubmit sits on the synchronous critical path of every
//      single prompt. We race it against the (2ms) FTS result and keep
//      whichever is ready in time.
//
// Everything else is carried over from v0.2: trigger gate, cross-layer dedup,
// observe mode, and exit(0) on every path — a broken hook must never block a
// prompt.

import { appendFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ENGINE = resolve(__dirname, '..', 'index.mjs')

const HOME = process.env.USERPROFILE || process.env.HOME || ''
const OBSERVE = process.env.MNEME_HOOK_OBSERVE === '1'   // live by default; set to 1 for a dry run
const TRACE = resolve(HOME, '.claude/hooks/.mneme-recall-observe.jsonl')
const CUR_PROJECT_MEM_DIR = resolve(HOME, '.claude/projects/E--project/memory') // cross-layer dedup basis

// Budget for the hybrid path. Past this we serve the FTS rows we already have.
// Tuned off measured p50 ~258ms / cold max ~2979ms; override per-environment.
const HYBRID_TIMEOUT_MS = parseInt(process.env.MNEME_HOOK_HYBRID_TIMEOUT_MS || '800', 10)

function trace(obj) {
  try {
    const dir = dirname(TRACE)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(TRACE, JSON.stringify({ ts: Date.now(), ...obj }) + '\n')
  } catch {}
}

// ── .env.local BEFORE initMemory() ─────────────────────────────────────────
// Hooks are spawned by the harness and don't inherit the user's shell env, so
// EMBEDDING_API_* would be missing and hybrid recall would silently degrade to
// FTS-only. Same pattern (and same reason) as mcp-server.mjs. Checks the engine
// repo first, then its parent — the config file has lived in both layouts.
function loadEnvLocal() {
  const candidates = [
    resolve(__dirname, '..', '.env.local'),
    resolve(__dirname, '..', '..', '.env.local'),
  ]
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue
    try {
      for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*?)\r?$/)
        // Existing env wins — a launcher-set value still overrides the file.
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
      }
      return envPath
    } catch {}
  }
  return null
}

// Gate: only run on prompts that look like a real question / task
function shouldTrigger(p) {
  if (!p) return false
  const len = p.trim().length
  if (len < 12) return false     // too short ("go" / "看下")
  if (len > 2000) return false   // long paste
  return /怎么|如何|为什么|为啥|能不能|可不可以|是不是|哪里|帮我|设计|方案|怎么办|排查|根治|优化|实现|对比|区别|要不要|\?|？/.test(p)
}

function toHit(r) {
  let meta = {}
  try { meta = JSON.parse(r.metadata || '{}') } catch {}
  const sf = String(meta.source_file || '').split(/[\\/]/).pop().toLowerCase()
  return {
    id: r.rowid,
    category: r.category,
    importance: r.importance,
    summary: r.summary || '',
    content: String(r.content || '').slice(0, 220).replace(/\n+/g, ' '),
    source_file: sf,
    fts_rank: r.fts_rank,
  }
}

// ── Recall + cross-layer dedup. Shared by the live path and the observe worker.
async function computeCross(prompt) {
  // Filenames the current project's markdown layer already injects (dedup basis)
  const curMd = new Set()
  try {
    if (existsSync(CUR_PROJECT_MEM_DIR)) {
      for (const f of readdirSync(CUR_PROJECT_MEM_DIR)) {
        if (f.toLowerCase().endsWith('.md')) curMd.add(f.toLowerCase())
      }
    }
  } catch {}

  const envPath = loadEnvLocal()
  const { recallMemories, recallMemoriesHybrid, initMemory } = await import(pathToFileURL(ENGINE).href)
  // Without this, _embeddingConfig stays null and hybrid returns FTS rows.
  let inited = false
  try { initMemory(); inited = true } catch {}

  const query = prompt.slice(0, 500)
  const t0 = Date.now()

  // FTS first: ~2ms, and it's the fallback if hybrid overruns its budget.
  let rows = recallMemories({ query, limit: 8 }) || []
  let path = 'fts'
  let degradeReason = null

  if (inited) {
    let timer
    const budget = new Promise((r) => {
      timer = setTimeout(() => r('__timeout__'), HYBRID_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()  // never hold the process open
    })
    try {
      const winner = await Promise.race([
        recallMemoriesHybrid({ query, limit: 8 }).catch((e) => ({ __err: String(e?.message || e) })),
        budget,
      ])
      if (winner === '__timeout__') {
        path = 'fts-timeout'          // hybrid too slow — serve what we already have
      } else if (winner && winner.__err) {
        path = 'fts-error'
        degradeReason = winner.__err.slice(0, 120)
      } else if (Array.isArray(winner)) {
        // Engine tags its own silent degrade (see recallMemoriesHybrid) — the
        // whole point of v0.3 is that this case is visible instead of guessed.
        if (winner._degradedTo) {
          path = 'fts-engine-degraded'
          degradeReason = winner._degradeReason || null
        } else {
          path = 'hybrid'
        }
        rows = winner
      }
    } catch (e) {
      path = 'fts-error'
      degradeReason = String(e?.message || e).slice(0, 120)
    } finally {
      clearTimeout(timer)
    }
  } else {
    path = 'fts-no-init'
  }

  const hits = rows.map(toHit)
  // Drop what the current project's markdown layer already covers → only real
  // cross-project material survives (this hook exists to cover that gap only).
  const cross = hits.filter((h) => !h.source_file || !curMd.has(h.source_file))
  return { hits, cross, path, degradeReason, envPath, ms: Date.now() - t0 }
}

// ── OBSERVE worker: dry run, off the critical path ─────────────────────────
async function runObserveWorker(jobFile) {
  let job = {}
  try { job = JSON.parse(readFileSync(jobFile, 'utf-8')) } catch { process.exit(0) }
  try { unlinkSync(jobFile) } catch {}
  const { sessionId = 'unknown', prompt = '' } = job
  try {
    const { hits, cross, path, degradeReason, ms } = await computeCross(prompt)
    trace({
      sessionId,
      prompt: String(prompt).slice(0, 140),
      total: hits.length,
      cross: cross.length,
      path, degradeReason, ms,
      would_inject: cross.slice(0, 3).map((h) => ({
        id: h.id, cat: h.category, imp: h.importance, sf: h.source_file, sum: h.summary.slice(0, 80),
      })),
    })
  } catch (e) {
    trace({ sessionId, err: String(e.message || e).slice(0, 200) })
  }
  process.exit(0)
}

if (process.argv[2] === '--observe-worker') {
  runObserveWorker(process.argv[3])
} else {
  let input = ''
  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (d) => (input += d))
  process.stdin.on('end', async () => {
    let payload = {}
    try { payload = JSON.parse(input || '{}') } catch { process.exit(0) }
    const sessionId = payload.session_id || payload.sessionId || 'unknown'
    const prompt = (payload.prompt || '').trim()
    if (!shouldTrigger(prompt)) process.exit(0)

    // OBSERVE: push the work to a detached worker, return immediately
    if (OBSERVE) {
      try {
        const safeSid = String(sessionId).replace(/[^\w-]/g, '_').slice(0, 36)
        const jobFile = join(tmpdir(), `mneme-observe-job-${safeSid}-${process.pid}.json`)
        writeFileSync(jobFile, JSON.stringify({ sessionId, prompt }), 'utf-8')
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--observe-worker', jobFile], {
          detached: true, stdio: 'ignore', windowsHide: true,
        })
        child.unref()
      } catch {}
      process.exit(0)
    }

    // LIVE: inject the top-2 cross-project hits (synchronous — it has to
    // produce additionalContext before the prompt goes out)
    let hits = [], cross = [], path = 'unknown', degradeReason = null, ms = 0
    try {
      ({ hits, cross, path, degradeReason, ms } = await computeCross(prompt))
    } catch (e) {
      trace({ sessionId, err: String(e.message || e).slice(0, 200) })
      process.exit(0)
    }
    const top = cross.slice(0, 2)
    trace({
      sessionId,
      mode: 'live',
      prompt: String(prompt).slice(0, 140),
      total: hits.length,
      cross: cross.length,
      path, degradeReason, ms,
      injected: top.map((h) => ({
        id: h.id, cat: h.category, imp: h.importance, sf: h.source_file, sum: h.summary.slice(0, 80),
      })),
    })
    if (top.length === 0) process.exit(0)
    const lines = top.map(
      (h) => `[mneme#${h.id} ${h.category} ★${h.importance}]${h.summary ? '\n  📌 ' + h.summary : ''}\n  ${h.content}`
    )
    const additionalContext =
      `🧠 [mneme·跨项目记忆] 你的问题命中 ${top.length} 条其它项目/生态的记忆（当前项目 markdown 未覆盖）：\n\n` +
      lines.join('\n\n') +
      `\n\n（跨项目线索，判断适用性再用；不适用直接忽略）`
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } })
    )
    process.exit(0)
  })
}
