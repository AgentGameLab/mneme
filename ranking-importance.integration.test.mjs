// Importance filters; it does not rank.
//
// It used to do both. The ranking half was demoted to a small weight rather than
// removed, on the reasoning that a weak prior is harmless. Measured against RRF's
// actual spacing it is not: adjacent ranks differ by ~0.0026, so 0.05 moves an
// importance-8 row two places past an importance-7 row, and an importance-9 row
// four. A top-8 injection is decided inside that range.
//
// The field was spending that leverage on nothing. On a live 8.6k-row store, rows
// ever recalled averaged importance 7.70 and rows never recalled 7.36 — a 0.34 gap
// on a 1-10 scale with 90% of the corpus at >=7. Self-rated, saturated, and
// uncorrelated with use.
//
// The fixture below is calibrated to the failure regime rather than to an obvious
// case: an earlier version gave the low-importance row a large relevance edge,
// which survived the tilt, so the test passed with and without the fix and proved
// nothing. Here relevance is a tie and the low-importance row's only advantage is
// one prior access — worth ~0.0455, deliberately less than the ~0.07 that an
// importance gap of 10-vs-3 was buying. Restore the importance term and this goes
// red.
//
// Covers the FTS path (no embedding config in a temp DB, so hybrid falls back).
//
// Run: node ranking-importance.integration.test.mjs
import { initMemory, closeMemory, storeMemory, recallMemories } from './index.mjs'
import Database from 'better-sqlite3'

const DB_PATH = process.env.TOKENMEM_DB_PATH
if (!DB_PATH) { console.error('FATAL: set TOKENMEM_DB_PATH'); process.exit(2) }

let pass = 0, fail = 0
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' — ' + detail : ''}`) }
}

initMemory()
const marker = `zzrank${Math.floor(Math.random() * 1e6)}`

const used = storeMemory({
  content: `${marker} calibration runbook alpha`,
  importance: 3, memoryLevel: 'semi_abstract', memoryType: 'long_term',
})
const rated = storeMemory({
  content: `${marker} calibration runbook bravo`,
  importance: 10, memoryLevel: 'semi_abstract', memoryType: 'long_term',
})
{
  const db = new Database(DB_PATH)
  db.prepare('UPDATE memories SET access_count = 1 WHERE rowid = ?').run(used)
  db.prepare('UPDATE memories SET access_count = 0 WHERE rowid = ?').run(rated)
  db.close()
}

const hits = recallMemories({ query: marker, limit: 10 })
const ids = hits.map(h => String(h.rowid))
check('both rows retrieved', ids.includes(String(used)) && ids.includes(String(rated)), JSON.stringify(ids))

check('evidence of use outranks a higher self-rating',
  ids.indexOf(String(used)) < ids.indexOf(String(rated)),
  `used(imp3,acc1)@${ids.indexOf(String(used))} rated(imp10,acc0)@${ids.indexOf(String(rated))}`)

const filtered = recallMemories({ query: marker, limit: 10, minImportance: 8 })
const fids = filtered.map(h => String(h.rowid))
check('min_importance still excludes below the floor',
  !fids.includes(String(used)) && fids.includes(String(rated)), JSON.stringify(fids))
check('every row returned under a floor satisfies it',
  filtered.every(h => (h.importance || 0) >= 8), JSON.stringify(filtered.map(h => h.importance)))
check('importance still travels on the result', typeof hits[0]?.importance === 'number')

closeMemory()
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
