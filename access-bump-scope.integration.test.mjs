// recallForClients over-fetches a candidate pool (up to 30 rows when filtering)
// and trims it to the caller's limit. Access counts must move only for the rows
// that were returned. When the whole pool was bumped, every hook call added +1 to
// ~30 rows while showing 3, and since access frequency feeds ranking and decay the
// rows that were already on top stayed there: on one 10k-row store a single row
// reached 46% of two weeks of hook recalls.
//
// Run: TOKENMEM_DB_PATH=/tmp/x.db node access-bump-scope.integration.test.mjs
import { initMemory, closeMemory, storeMemory, recallForClients } from './index.mjs'
import Database from 'better-sqlite3'

const DB_PATH = process.env.TOKENMEM_DB_PATH
if (!DB_PATH) { console.error('FATAL: set TOKENMEM_DB_PATH'); process.exit(2) }

let pass = 0, fail = 0
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' — ' + detail : ''}`) }
}

initMemory()
const marker = `zzbump${Math.floor(Math.random() * 1e6)}`
const ids = []
for (let i = 0; i < 12; i++) {
  ids.push(storeMemory({
    content: `${marker} pool row ${i} ${'x'.repeat(i)}`,
    importance: 7, memoryLevel: 'semi_abstract', memoryType: 'long_term',
  }))
}

const readCounts = () => {
  const db = new Database(DB_PATH, { readonly: true })
  const rows = db.prepare(`SELECT rowid, access_count FROM memories WHERE rowid IN (${ids.map(() => '?').join(',')})`).all(...ids)
  db.close()
  return new Map(rows.map(r => [String(r.rowid), r.access_count || 0]))
}

const before = readCounts()
// min_importance > 0 is what makes recallForClients over-fetch — the shape the hooks send.
const res = await recallForClients({ query: marker, limit: 2, minImportance: 1, source: 'test' })
const after = readCounts()

const returned = new Set(res.hits.map(h => String(h.id)))
const bumped = [...after].filter(([id, n]) => n > (before.get(id) || 0)).map(([id]) => id)

check('the pool held more candidates than were returned', res.hits.length === 2 && bumped.length <= 2,
  `returned=${res.hits.length} bumped=${bumped.length}`)
check('every returned row was bumped', [...returned].every(id => bumped.includes(id)),
  `returned=${[...returned]} bumped=${bumped}`)
check('no row outside the result was bumped', bumped.every(id => returned.has(id)),
  `bumped=${bumped} returned=${[...returned]}`)

// preferVec is the fail-open twin of requireVec. This temp DB has no embedding
// config, i.e. the zero-config install: requireVec must return nothing and
// preferVec must fall back to the FTS rows in the same call.
const strict = await recallForClients({ query: marker, limit: 2, minImportance: 1, requireVec: true, source: 'test' })
const lenient = await recallForClients({ query: marker, limit: 2, minImportance: 1, preferVec: true, source: 'test' })
check('requireVec without embeddings returns nothing', strict.hits.length === 0, `got ${strict.hits.length}`)
check('preferVec without embeddings falls back to FTS rows', lenient.hits.length === 2, `got ${lenient.hits.length}`)

closeMemory()
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
