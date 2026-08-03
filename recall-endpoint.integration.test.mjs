// End-to-end: POST /recall + the hook's fallback contract.
//
// The auto-recall hooks used to spawn `node index.mjs --recall` per prompt.
// On a warm production-sized DB that is ~1.6s of node startup around a ~6ms
// query, paid on the critical path before the model sees the prompt. This
// endpoint lets a hook reuse the already-warm server instead.
//
// The promise worth protecting is not the speedup, it is that the speedup can
// never become a new single point of failure: a hook whose server is down must
// still recall, via the CLI, silently.
//
// Run: node recall-endpoint.integration.test.mjs
import { spawn, spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, unlinkSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.TOKENMEM_DB_PATH
if (!DB_PATH) { console.error('FATAL: set TOKENMEM_DB_PATH'); process.exit(2) }
for (const sfx of ['', '-shm', '-wal']) { const p = DB_PATH + sfx; if (existsSync(p)) unlinkSync(p) }

let pass = 0, fail = 0
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' — ' + detail : ''}`) }
}
const PORT = 18897 + Math.floor(Math.random() * 60)
const URL = `http://127.0.0.1:${PORT}/recall`

// ── seed ──
{
  const { initMemory, storeMemory, closeMemory } = await import('./index.mjs')
  initMemory()
  storeMemory({ content: 'omega calibration runbook lives at OMEGA_URL with OMEGA_TOKEN', importance: 9, memoryLevel: 'meta_knowledge', memoryType: 'long_term' })
  storeMemory({ content: 'omega rig teardown checklist', importance: 7, memoryLevel: 'semi_abstract', memoryType: 'long_term' })
  storeMemory({ content: 'omega scratch note, low value', importance: 2, memoryLevel: 'concrete_trace', memoryType: 'long_term' })
  closeMemory()
}

// ── the hook must work with NO server up ──
{
  const r = spawnSync(process.execPath, [resolve(__dirname, 'hooks/prompt-recall.mjs')], {
    input: JSON.stringify({ session_id: 'no-server', prompt: 'omega calibration 的 token 和端口 配置在哪' }),
    encoding: 'utf-8', timeout: 20000,
    env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH, MNEME_DB_PATH: DB_PATH,
      MNEME_STATE_DIR: resolve(DB_PATH + '-state'),
      MNEME_HTTP_URL: `http://127.0.0.1:${PORT + 900}/recall` },  // nothing listening
  })
  check('hook exits 0 with the server unreachable', r.status === 0, `status=${r.status} err=${(r.stderr || '').slice(0, 120)}`)
  check('hook stays silent on stderr when falling back', !(r.stderr || '').trim(),
    (r.stderr || '').slice(0, 120))
}

// ── bring the server up ──
const srv = spawn(process.execPath, [resolve(__dirname, 'mcp-server.mjs'), '--transport=http', `--port=${PORT}`], {
  env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH }, stdio: 'ignore', detached: false,
})
const waitUp = async () => {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return true } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}
check('test server came up', await waitUp())

const post = async (body, init = {}) => {
  const r = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...init })
  let j = null
  try { j = await r.json() } catch {}
  return { status: r.status, j }
}

// ── contract ──
{
  const { status, j } = await post({ query: 'omega calibration', limit: 5, min_importance: 6, level: 'meta_knowledge,semi_abstract', source: 'test-http', session_id: 'sess-1' })
  check('POST /recall returns 200 with hits', status === 200 && Array.isArray(j?.hits) && j.hits.length > 0, JSON.stringify(j).slice(0, 140))
  check('filters are applied — nothing below min_importance comes back',
    j.hits.every(h => h.importance >= 6), JSON.stringify(j?.hits?.map(h => h.importance)))
  check('filters are applied — only requested levels come back',
    j.hits.every(h => ['meta_knowledge', 'semi_abstract'].includes(h.memory_level)))
  check('capacity signals ride along', typeof j.requested_limit === 'number' && typeof j.effective_limit === 'number' && 'capped' in j)
}

// ── the trace id survives the filters ──
//
// recallTrace rides on the returned array as a non-enumerable property, and
// Array.prototype.filter builds a new array. Reading it after the filters
// yielded undefined, so every filtered call answered trace_id: null — while
// still persisting the trace. Rows piled up in recall_traces that no caller
// could name, and get_recall_trace / validate_memory_references had nothing to
// be called with.
//
// It stayed quiet because the unfiltered path, which nobody uses, worked fine.
// Both hooks send min_importance and level on every call.
{
  const bare = await post({ query: 'omega calibration', limit: 3, source: 'trace-bare' })
  check('unfiltered call returns a trace id', typeof bare.j?.trace_id === 'string' && bare.j.trace_id.length > 0,
    JSON.stringify(bare.j?.trace_id))

  for (const [label, body] of [
    ['min_importance', { query: 'omega calibration', limit: 3, min_importance: 6, source: 'trace-imp' }],
    ['level', { query: 'omega calibration', limit: 3, level: 'meta_knowledge,semi_abstract', source: 'trace-lvl' }],
    ['the shape both hooks send', { query: 'omega calibration', limit: 3, min_importance: 6, level: 'meta_knowledge,semi_abstract', require_vec: false, source: 'trace-hook' }],
  ]) {
    const { j: r } = await post(body)
    check(`trace id survives ${label}`, typeof r?.trace_id === 'string' && r.trace_id.length > 0,
      `trace_id=${JSON.stringify(r?.trace_id)} hits=${r?.count}`)
  }
}

// ── shape parity with the CLI: same query, same ids, same order ──
{
  const args = ['index.mjs', '--recall', 'omega calibration', '--format', 'json',
    '--min-importance', '6', '--level', 'meta_knowledge,semi_abstract', '--limit', '5', '--source', 'test-cli']
  const r = spawnSync(process.execPath, args, { encoding: 'utf-8', cwd: __dirname, env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH } })
  const line = (r.stdout || '').split('\n').find(l => l.trim().startsWith('{'))
  const cli = line ? JSON.parse(line) : null
  const { j: http } = await post({ query: 'omega calibration', limit: 5, min_importance: 6, level: 'meta_knowledge,semi_abstract', source: 'test-http2' })
  check('CLI and endpoint return the same ids in the same order',
    !!cli && JSON.stringify(cli.hits.map(h => h.id)) === JSON.stringify(http.hits.map(h => h.id)),
    `cli=${JSON.stringify(cli?.hits?.map(h => h.id))} http=${JSON.stringify(http?.hits?.map(h => h.id))}`)
}

// ── input validation ──
{
  const bad = await post({ limit: 5 })
  check('missing query is a 400, not a 500', bad.status === 400 && /query/.test(bad.j?.error || ''), JSON.stringify(bad))
  const r = await fetch(URL, { method: 'GET' })
  check('GET /recall is not handled as a recall', r.status !== 200)
}

// ── the hook actually goes over HTTP when a server is up ──
// Answer from a stub with a sentinel the DB does not contain: if the hook
// surfaces it, the HTTP path was taken. (Asserting via recall_log would not
// work here — that instrumentation is not part of this build.)
{
  const http = await import('node:http')
  let sawRequest = null
  const stub = http.createServer((req, res) => {
    let b = ''
    req.on('data', c => b += c)
    req.on('end', () => {
      try { sawRequest = JSON.parse(b) } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // Two hits, not one: the hook only injects once it has minConsensus (2)
      // of them, so a single-hit stub would exit silently and look like the
      // HTTP path failed.
      const hit = (id, content) => ({ id, content, summary: null, importance: 9,
        memory_level: 'meta_knowledge', memory_type: 'long_term', tags: [], score: 1,
        created_at: Date.now(), recall_sources: [], vec_distance: null })
      res.end(JSON.stringify({
        hits: [hit(999901, 'SENTINEL-FROM-STUB-SERVER'), hit(999902, 'SENTINEL-FROM-STUB-SERVER-2')],
        count: 2, requested_limit: 5, effective_limit: 5, candidate_limit: 30, capped: false, trace_id: null,
      }))
    })
  })
  const stubPort = PORT + 401
  await new Promise(r => stub.listen(stubPort, '127.0.0.1', r))

  // MUST be async spawn, not spawnSync: the stub lives in THIS process, and
  // spawnSync blocks this event loop — the stub could never answer the child,
  // so the hook would always time out and fall back, and the test would "prove"
  // the HTTP path is broken when it is the harness that is.
  const r = await new Promise(res => {
    const ch = spawn(process.execPath, [resolve(__dirname, 'hooks/prompt-recall.mjs')], {
      env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH, MNEME_DB_PATH: DB_PATH,
        MNEME_STATE_DIR: resolve(DB_PATH + '-state2'),
        MNEME_HTTP_URL: `http://127.0.0.1:${stubPort}/recall` },
    })
    let stdout = '', stderr = ''
    ch.stdout.on('data', d => stdout += d)
    ch.stderr.on('data', d => stderr += d)
    ch.on('close', status => res({ status, stdout, stderr }))
    ch.stdin.end(JSON.stringify({ session_id: 'with-server', prompt: 'omega calibration 的 token 和端口 配置在哪' }))
  })
  check('hook exits 0 against a live server', r.status === 0, `status=${r.status}`)
  check('hook took the HTTP path instead of spawning the CLI',
    (r.stdout || '').includes('SENTINEL-FROM-STUB-SERVER'), (r.stdout || '').slice(0, 140))
  check('hook forwards its filters and its own source label',
    sawRequest?.source === 'mneme-prompt-recall' && sawRequest?.min_importance >= 1 && typeof sawRequest?.level === 'string',
    JSON.stringify(sawRequest))
  stub.close()
}

srv.kill()
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
