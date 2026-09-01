// End-to-end: a slow embedding endpoint must not hold the recall hot path open
// Run: node embedding-timeout.integration.test.mjs
//
// generateEmbedding had no timeout. Because hybrid recall awaits it, one slow
// upstream call held the whole request open for as long as the network took.
//
// Measured on a 14-day recall_log (2404 calls, 2026-09-01):
//
//   query_path=sync    n=844   slow(>=3s)=0    avg     9ms
//   query_path=strict  n=144   slow(>=3s)=0    avg    60ms
//   query_path=hybrid  n=1416  slow(>=3s)=282  avg  2527ms
//
// Every slow call was on hybrid — the only path that embeds. The hybrid
// distribution has a cliff with nothing in it: p80 = 2290ms, p85 = 10695ms.
// That plateau is an upstream stall, not our work getting slower.
//
// The waiting bought nothing. FTS runs in the same Promise.all and is
// synchronous, so its rows are already in hand; the request just sits on the
// network. Worse, the hook that issued most of these aborts at 1500ms, so the
// server was spending 11 seconds producing a result nobody was still waiting for.
//
// The timeout is tested against generateEmbedding directly. Going through
// recallMemoriesHybrid would not discriminate on a machine without the
// sqlite-vec extension (CI): that path early-bails to FTS before it ever
// embeds, so it would pass whether or not the timeout exists.

import { initMemory, generateEmbedding, recallMemoriesHybrid, storeMemory, closeMemory } from './index.mjs'
import http from 'node:http'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`✓ ${name}`) }
  else { fail++; console.log(`✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

const DIM = 1024
const STALL_MS = 30_000
const TIMEOUT_MS = 600

let mode = 'stall'
let calls = 0
const server = http.createServer((req, res) => {
  calls++
  const answer = () => {
    if (res.writableEnded || res.destroyed) return
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ embedding: new Array(DIM).fill(0.001) }] }))
  }
  if (mode === 'fast') answer()
  else setTimeout(answer, STALL_MS).unref()
})
await new Promise(r => server.listen(0, '127.0.0.1', r))

process.env.EMBEDDING_API_BASE_URL = `http://127.0.0.1:${server.address().port}`
process.env.EMBEDDING_API_KEY = 'test-key'
process.env.EMBEDDING_DIMENSION = String(DIM)
process.env.EMBEDDING_TIMEOUT_MS = String(TIMEOUT_MS)

initMemory()

// ── the fix itself ────────────────────────────────────────────────────────
mode = 'stall'
let t0 = Date.now()
const stalledResult = await generateEmbedding('a query whose embedding never arrives')
let elapsed = Date.now() - t0

ok('the stalling endpoint was actually reached (fixture is wired up)', calls > 0, `calls=${calls}`)
ok('a stalled embedding gives up on schedule instead of waiting out the network',
   elapsed < TIMEOUT_MS + 1500, `took ${elapsed}ms, budget ${TIMEOUT_MS}ms, stall ${STALL_MS}ms`)
ok('a timed-out embedding returns null rather than throwing',
   stalledResult === null, `got ${stalledResult === null ? 'null' : typeof stalledResult}`)

// ── the timeout must not eat healthy calls ────────────────────────────────
mode = 'fast'
t0 = Date.now()
const goodResult = await generateEmbedding('a query whose embedding arrives promptly')
elapsed = Date.now() - t0

ok('a healthy embedding still comes back',
   Array.isArray(goodResult) && goodResult.length === DIM,
   `got ${Array.isArray(goodResult) ? goodResult.length + ' dims' : goodResult}`)
ok('a healthy embedding is not delayed by the timeout machinery',
   elapsed < TIMEOUT_MS, `took ${elapsed}ms`)

// ── degradation stays visible ─────────────────────────────────────────────
// Silent degradation is the failure mode this whole change is about: fast and
// wrong-looking-like-right is worse than slow. Only assertable where the vec
// extension is present, since otherwise hybrid never reaches the embed.
storeMemory({
  content: 'The recall hot path degrades to full-text search when the embedding API stalls.',
  summary: 'embedding timeout degradation fixture',
  importance: 6,
})
mode = 'stall'
const rows = await recallMemoriesHybrid({ query: 'embedding stalls degrade full-text', limit: 5 })
ok('recall still returns rows — it degrades, it does not fail',
   Array.isArray(rows) && rows.length > 0, `got ${rows?.length} rows`)

if (rows?._degradeReason === 'vec-extension-not-loaded') {
  console.log('~ skipped: degradation-reason assertion needs the sqlite-vec extension (absent here)')
} else {
  ok('a timeout is recorded as its own degradation reason, not as a normal hybrid call',
     rows?._degradeReason === 'embedding-timeout',
     `_degradeReason=${rows?._degradeReason}`)
}

server.close()
closeMemory()

console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
