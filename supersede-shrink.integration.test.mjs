// End-to-end: supersede shrink guard (v2.10)
//
// Regression target — a real 4-hop chain in the wild went 2076B -> 568B because
// each supersede wrote only "what changed". The durable half (service URL, env
// vars, API routes, code locations) survived in prior_versions[] but fell out of
// `content`, and memories_fts only indexes content/summary/tags — so it was
// still in the DB and no longer findable. The guard reports; it never blocks.
//
// Run: node supersede-shrink.integration.test.mjs
import { storeMemory, initMemory } from './index.mjs'
import Database from 'better-sqlite3'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

initMemory()

let pass = 0, fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass++; else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
}

const __dirname_at = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.TOKENMEM_DB_PATH
  || (existsSync(resolve(__dirname_at, 'engram.db'))
        ? resolve(__dirname_at, 'engram.db')
        : resolve(__dirname_at, 'tokenmem.db'))
const dbRead = new Database(DB_PATH, { readonly: true })

const stamp = Math.floor(Math.random() * 1e6)
const marker = `[test-marker-shrink-${stamp}]`

// A realistic "durable ops entry": URLs, host:port, env var, API route, file paths.
const FAT = `${marker} Key service ops entry.
Service root http://100.87.169.100:8787 with agent API under /api/agent/v1.
Set SERVICE_MANAGER_URL and SERVICE_MANAGER_TOKEN before calling.
GET /api/agent/v1/whoami verifies identity; POST /keys/claim needs an Idempotency-Key.
Code lives at E:/Project/key-manager/, routes in src/http.mjs, schema in src/db.mjs.
Credentials under E:/Project/nas-setup/agents/. Inventory currently 300 available.`

// ── Case 1: 1:1 supersede that keeps only the delta → warn on both axes ──
{
  const out0 = {}
  const fatId = storeMemory({ content: FAT, memoryType: 'short_term' }, { out: out0 })

  const out = {}
  const thinId = storeMemory({
    content: `${marker} Inventory now 296 available, 4 sent.`,
    memoryType: 'short_term',
    supersedes: [String(fatId)],
  }, { out })

  const w = out.supersedeShrink?.[0]
  check(!!thinId, 'case1 write still succeeds (detection only, never blocks)', `id=${thinId}`)
  check(!!w && w.id === String(fatId), 'case1 warning raised against the superseded row', `id=${w?.id}`)
  check(!!w && w.ratio < 0.6, 'case1 length ratio flagged', `ratio=${w?.ratio}`)

  const dropped = new Set(w?.dropped || [])
  const expected = [
    'http://100.87.169.100:8787',
    '100.87.169.100:8787',
    'SERVICE_MANAGER_URL',
    'SERVICE_MANAGER_TOKEN',
    '/api/agent/v1',
    'src/http.mjs',
    'src/db.mjs',
  ]
  const missed = expected.filter(t => !dropped.has(t))
  check(missed.length === 0, 'case1 high-signal tokens reported as dropped',
    missed.length ? `not reported: ${missed.join(', ')}` : `${dropped.size} tokens`)

  const winPath = [...dropped].some(t => /^E:[\\/]Project/.test(t))
  check(winPath, 'case1 windows drive path detected', [...dropped].filter(t => t.startsWith('E:')).join(', '))
}

// ── Case 2: full restatement + new fact → no warning ──
{
  const out0 = {}
  const baseId = storeMemory({ content: FAT, memoryType: 'short_term' }, { out: out0 })

  const out = {}
  const id = storeMemory({
    content: FAT.replace('Inventory currently 300 available.', 'Inventory currently 296 available, 4 sent.')
      + '\nAdded: POST /keys/{keyId}/status reports activation.',
    memoryType: 'short_term',
    supersedes: [String(baseId)],
  }, { out })

  check(!!id && !out.supersedeShrink, 'case2 full restatement produces no warning',
    out.supersedeShrink ? JSON.stringify(out.supersedeShrink[0].dropped) : 'clean')
}

// ── Case 3: N:1 consolidation → length ignored, only dropped tokens judged ──
{
  const a = storeMemory({ content: `${marker} Alpha note. Endpoint /api/alpha/v1 on ALPHA_TOKEN.`, memoryType: 'short_term' }, { out: {} })
  const b = storeMemory({ content: `${marker} Beta note. Endpoint /api/beta/v1 on BETA_TOKEN.`, memoryType: 'short_term' }, { out: {} })

  const out = {}
  const id = storeMemory({
    content: `${marker} Merged: /api/alpha/v1 uses ALPHA_TOKEN, /api/beta/v1 uses BETA_TOKEN.`,
    memoryType: 'short_term',
    supersedes: [String(a), String(b)],
  }, { out })

  check(!!id && !out.supersedeShrink, 'case3 tighter N:1 merge keeping all identifiers is clean',
    out.supersedeShrink ? JSON.stringify(out.supersedeShrink) : 'clean')
}

// ── Case 4: N:1 consolidation that loses one identifier → still warns ──
{
  const a = storeMemory({ content: `${marker} Gamma note. Endpoint /api/gamma/v1 on GAMMA_TOKEN.`, memoryType: 'short_term' }, { out: {} })
  const b = storeMemory({ content: `${marker} Delta note. Endpoint /api/delta/v1 on DELTA_TOKEN.`, memoryType: 'short_term' }, { out: {} })

  const out = {}
  storeMemory({
    content: `${marker} Merged: /api/gamma/v1 uses GAMMA_TOKEN. Delta retired.`,
    memoryType: 'short_term',
    supersedes: [String(a), String(b)],
  }, { out })

  const hit = out.supersedeShrink?.find(w => w.id === String(b))
  check(!!hit, 'case4 N:1 losing an identifier warns on the row that lost it')
  check(!!hit && hit.dropped.includes('/api/delta/v1') && hit.dropped.includes('DELTA_TOKEN'),
    'case4 names the lost identifiers', JSON.stringify(hit?.dropped))
  check(!out.supersedeShrink?.find(w => w.id === String(a)),
    'case4 the fully-carried row is not flagged')
}

// ── Case 5: short rows do not trip the length heuristic on noise alone ──
{
  const short = storeMemory({ content: `${marker} tiny note about nothing in particular`, memoryType: 'short_term' }, { out: {} })
  const out = {}
  storeMemory({
    content: `${marker} tiny note`,
    memoryType: 'short_term',
    supersedes: [String(short)],
  }, { out })
  check(!out.supersedeShrink, 'case5 sub-200B rows exempt from ratio check',
    out.supersedeShrink ? JSON.stringify(out.supersedeShrink[0]) : 'clean')
}

// ── Case 5b: a rolling ledger that grows past its peak is exempt ──
// Mirrors the (a3) audit rule. A daily log rotates yesterday's file names out
// while the entry keeps growing; without the exemption this fires every day and
// the gate becomes noise you learn to skip.
{
  const day1 = storeMemory({
    content: `${marker} ledger day 1. touched src/alpha.mjs and docs/alpha-NOTES.md. ` + 'padding '.repeat(30),
    memoryType: 'short_term', importance: 8,
  })
  const out1 = {}
  const day2 = storeMemory({
    // different files today (rotation) AND longer than day 1 overall
    content: `${marker} ledger day 2. touched src/beta.mjs and docs/beta-NOTES.md. ` + 'padding '.repeat(45),
    memoryType: 'short_term', importance: 8,
    supersedes: [String(day1)],
  }, { out: out1 })
  check(!out1.supersedeShrink, 'case5b growing ledger is exempt despite rotating identifiers',
    out1.supersedeShrink ? JSON.stringify(out1.supersedeShrink[0].dropped) : 'clean')

  // ...but shrinking BELOW the historical peak still reports, even though this
  // new version is longer than the (already shrunken) row it directly replaces.
  const out2 = {}
  const day3 = storeMemory({
    content: `${marker} ledger day 3. short.`,
    memoryType: 'short_term', importance: 8,
    supersedes: [String(day2)],
  }, { out: out2 })
  check(!!out2.supersedeShrink, 'case5b a real collapse below peak still reports')

  // Growing relative to the row it replaces does NOT buy an exemption on its own:
  // the exemption needs newLen >= the all-time peak. So a write that is longer than
  // its predecessor but still below peak, and drops an identifier the predecessor
  // carried, is still reported.
  const carrier = storeMemory({
    content: `${marker} ledger day 4. now tracking KEY_ONE and src/gamma.mjs.`,
    memoryType: 'short_term', importance: 8,
    supersedes: [String(day3)],
  }, { out: {} })
  const out3 = {}
  storeMemory({
    content: `${marker} ledger day 5. a bit longer than the previous entry, but that env var is no longer mentioned.`,
    memoryType: 'short_term', importance: 8,
    supersedes: [String(carrier)],
  }, { out: out3 })
  check(!!out3.supersedeShrink && out3.supersedeShrink[0].dropped.includes('KEY_ONE'),
    'case5b growing vs predecessor but under peak still reports a fresh loss',
    out3.supersedeShrink ? JSON.stringify(out3.supersedeShrink[0].dropped) : 'MISSED')
}

// ── Case 6: plain store without supersedes never carries the field ──
{
  const out = {}
  storeMemory({ content: `${marker} standalone entry, no supersedes`, memoryType: 'short_term' }, { out })
  check(!out.supersedeShrink, 'case6 non-supersede store has no shrink field')
}

// ── Case 7: near-dup gate must not offer a row this write just superseded ──
// storeMemory sets superseded_by synchronously; deleted_at only lands on the next
// expireMemories sweep. The gate filters on superseded_by IS NULL for that reason.
{
  const supersededCount = dbRead.prepare(`
    SELECT COUNT(*) c FROM memories
    WHERE content LIKE ? AND superseded_by IS NOT NULL AND deleted_at IS NULL
  `).get(`%${marker}%`).c
  check(supersededCount > 0, 'case7 setup: superseded rows are still un-deleted', `${supersededCount} rows`)

  // Direct check of the SQL predicate the gate relies on.
  const offerable = dbRead.prepare(`
    SELECT COUNT(*) c FROM memories
    WHERE content LIKE ? AND deleted_at IS NULL AND superseded_by IS NULL
  `).get(`%${marker}%`).c
  const total = dbRead.prepare(`SELECT COUNT(*) c FROM memories WHERE content LIKE ? AND deleted_at IS NULL`).get(`%${marker}%`).c
  check(offerable < total, 'case7 gate predicate excludes retired rows', `${offerable} offerable / ${total} live`)
}

// Cleanup: soft-delete test rows (UPDATE deleted_at does not fire the FTS reindex trigger)
const dbClean = new Database(DB_PATH)
try {
  const r = dbClean.prepare(`UPDATE memories SET deleted_at = ? WHERE content LIKE '%[test-marker-shrink-%' AND deleted_at IS NULL`).run(Date.now())
  console.log(`\ncleanup: soft-deleted ${r.changes} test rows`)
} finally {
  dbClean.close()
}

dbRead.close()
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
