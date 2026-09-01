// End-to-end: cold-pool candidate selection is by demonstrated reuse, not self-rating
// Run: node cold-pool-gate.test.mjs
//
// The cold pool produces the "oh, I just remembered something" surface: when a
// recall comes back short, 25% of the time it adds 1-3 rows that are old,
// untouched, and still worth seeing.
//
// "Still worth seeing" was implemented as importance >= 8 — a number the author
// types at write time. Measured on a 9301-row library (2026-09-01), that gate
// excluded 441 rows from a 1124-row pool, and the excluded set was led by the
// single most-recalled memory in the whole database (access_count = 1879,
// importance = 5). The decay floor the pool already applies is the real filter:
// a 30-day-cold row only holds decay_score >= 0.3 if it was reused a lot, so
// every row reaching the pool has access_count >= 8 by construction.

import { initMemory, selectColdPoolCandidates, closeMemory } from './index.mjs'
import Database from 'better-sqlite3'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

initMemory()

const __dirname_at = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.TOKENMEM_DB_PATH
  || (existsSync(resolve(__dirname_at, 'engram.db'))
        ? resolve(__dirname_at, 'engram.db')
        : resolve(__dirname_at, 'tokenmem.db'))

const SIMPLE_EXT_PATH = resolve(__dirname_at, 'lib', 'libsimple-windows-x64', 'simple')
function tryLoadSimple(db) {
  try {
    if (existsSync(SIMPLE_EXT_PATH + '.dll') || existsSync(SIMPLE_EXT_PATH)) {
      db.loadExtension(SIMPLE_EXT_PATH)
    }
  } catch {}
}

const db = new Database(DB_PATH)
tryLoadSimple(db)

let pass = 0, fail = 0
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`✓ ${name}`) }
  else { fail++; console.log(`✗ ${name}`) }
}

const DAY = 86400_000
const now = Date.now()
const cold = now - 45 * DAY   // comfortably past the 30d staleness cutoff
const warm = now - 2 * DAY
const TAG = `coldpool-${process.pid}`

const insert = db.prepare(`
  INSERT INTO memories (id, content, summary, importance, access_count,
                        last_accessed, created_at, decay_score, memory_level, memory_type)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'semi_abstract', 'long_term')
`)
const add = (id, imp, acc, last, decay) =>
  insert.run(`${TAG}-${id}`, `cold pool fixture ${id}`, `fixture ${id}`, imp, acc, last, cold, decay)

// The row the old gate wrongly excluded: heavily reused, self-rated low.
add('proven-but-low-rated', 5, 1879, cold, 0.9)
// The row the old gate admitted on its rating alone.
add('rated-high', 9, 12, cold, 0.5)
// Must stay out: not cold yet.
add('too-warm', 10, 400, warm, 0.9)
// Must stay out: decayed below the floor.
add('below-decay-floor', 10, 400, cold, 0.1)

const mine = (rows) => new Set(
  rows.filter(r => String(r.id).startsWith(TAG)).map(r => String(r.id).slice(TAG.length + 1)))

// take is deliberately large: selection is ORDER BY RANDOM(), so asserting on a
// small sample would be flaky. We assert on eligibility, not on which row won.
const picked = mine(selectColdPoolCandidates(db, { take: 5000, nowMs: now }))

ok('a heavily reused memory is eligible even when its importance is low',
   picked.has('proven-but-low-rated'))
ok('a high self-rating still gets in — this widens the pool, it does not invert it',
   picked.has('rated-high'))
ok('the staleness cutoff still holds', !picked.has('too-warm'))
ok('the decay floor still holds — it is the real relevance filter',
   !picked.has('below-decay-floor'))

const all = selectColdPoolCandidates(db, { take: 5000, nowMs: now })
const drop = all[0]?.rowid
const rest = selectColdPoolCandidates(db, { take: 5000, nowMs: now, excludeRowids: [drop] })
ok('excluded rowids are honoured so the surface cannot repeat a hit',
   drop != null && !rest.some(r => r.rowid === drop))

ok('take caps the result size', selectColdPoolCandidates(db, { take: 1, nowMs: now }).length === 1)

db.prepare(`DELETE FROM memories WHERE id LIKE ?`).run(`${TAG}-%`)
db.close()
closeMemory()

console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
