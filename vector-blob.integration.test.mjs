// Integration: memories.content_vector as Float32 BLOB — codec + Migration 013
// Run: node vector-blob.integration.test.mjs
//
// The column used to hold a JSON array. Measured on a 10,920-row library the
// JSON form was 226 MB for values that are all float32-exact (2,048,000 of
// 2,048,000 sampled satisfied Math.fround(x) === x), i.e. 5x the bytes to
// write the same 32-bit numbers in decimal. This test pins three properties:
//
//   1. The codec is lossless on float32 values and tolerant of everything a
//      column can actually contain (legacy JSON, BLOB, '', NULL, junk).
//   2. Migration 013 is bounded, resumable, idempotent, converts in place, and
//      NULLs unparseable text instead of leaving it to be counted as a vector
//      forever by the `!= ''` coverage checks.
//   3. A reader that predates the change (memory-health's near-dup scan) sees
//      BLOB rows and legacy rows as the same thing, so a half-migrated library
//      is not a broken library.

import { initMemory, closeMemory, migrateVectorsToBlob, rankNearDuplicateCandidates } from './index.mjs'
import { encodeVector, decodeVector, vectorStorageKind } from './vector-codec.mjs'
import { detectNearDup } from './memory-health.mjs'
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

// initMemory() builds the FTS5 table with the libsimple Chinese tokenizer when
// that extension is present (it is in the deployed runtime, not in CI). A second
// raw connection must load it too, or the FTS trigger on INSERT fails with
// "no such tokenizer: simple". Same helper as cold-pool-gate.test.mjs.
const SIMPLE_EXT_PATH = resolve(__dirname_at, 'lib', 'libsimple-windows-x64', 'simple')
function tryLoadSimple(conn) {
  try {
    if (existsSync(SIMPLE_EXT_PATH + '.dll') || existsSync(SIMPLE_EXT_PATH)) conn.loadExtension(SIMPLE_EXT_PATH)
  } catch {}
}

const db = new Database(DB_PATH)
tryLoadSimple(db)

let pass = 0, fail = 0
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`✓ ${name}`) }
  else { fail++; console.log(`✗ ${name}`) }
}
const near = (a, b, eps = 1e-6) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < eps)

// ── 1. codec ────────────────────────────────────────────────────────────────
{
  const v = [-0.07749947160482407, 0.007732080761343241, 0.5, 1, -1, 0]   // all float32-exact
  ok('input is float32-exact (test premise)', v.every(x => Math.fround(x) === x))
  const buf = encodeVector(v)
  ok('encode → Buffer of 4 bytes per lane', Buffer.isBuffer(buf) && buf.byteLength === v.length * 4)
  ok('decode(encode(v)) is exactly v', decodeVector(buf).every((x, i) => x === v[i]))
  ok('storage kind of encoded value is blob', vectorStorageKind(buf) === 'blob')

  ok('decode legacy JSON array', near(decodeVector('[0.5, -1, 2]'), [0.5, -1, 2]))
  ok('decode legacy JSON with surrounding whitespace', near(decodeVector('  [1,2]\n'), [1, 2]))
  ok('storage kind of JSON text is json', vectorStorageKind('[1]') === 'json')

  ok('decode(null) → null', decodeVector(null) === null)
  ok('decode(undefined) → null', decodeVector(undefined) === null)
  ok("decode('') → null", decodeVector('') === null)
  ok("storage kind of '' is empty", vectorStorageKind('') === 'empty')
  ok('decode junk text → null', decodeVector('not a vector') === null)
  ok('decode JSON that is not all finite numbers → null', decodeVector('[1,"a",2]') === null && decodeVector('[1,null]') === null)
  ok('decode JSON object → null', decodeVector('{"a":1}') === null)
  ok('decode empty JSON array → null', decodeVector('[]') === null)
  ok('decode BLOB with byteLength not divisible by 4 → null', decodeVector(Buffer.from([1, 2, 3])) === null)
  ok('decode empty BLOB → null', decodeVector(Buffer.alloc(0)) === null)
  const nanBuf = Buffer.alloc(8); nanBuf.writeFloatLE(1, 0); nanBuf.writeFloatLE(NaN, 4)
  ok('decode BLOB holding NaN → null', decodeVector(nanBuf) === null)
  ok('encode rejects NaN / Infinity / float32 overflow (symmetric with decode)',
     encodeVector([1, NaN]) === null && encodeVector([1, Infinity]) === null && encodeVector([1, 1e39]) === null)

  // Driver Buffers can be unaligned slices of a slab. A naive Float32Array view
  // would throw RangeError; the codec must copy first.
  const slab = Buffer.alloc(1 + 8)
  slab.writeFloatLE(3.5, 1); slab.writeFloatLE(-2, 5)
  const unaligned = slab.subarray(1)
  ok('decode unaligned Buffer slice (byteOffset=1) works', near(decodeVector(unaligned), [3.5, -2]))

  // Float32Array input must be copied, not aliased.
  const f = new Float32Array([1, 2]); const b2 = encodeVector(f); f[0] = 99
  ok('encode(Float32Array) does not alias the caller\'s buffer', decodeVector(b2)[0] === 1)

  ok('encode(null|[]) → null', encodeVector(null) === null && encodeVector([]) === null)
}

// ── 2. Migration 013 ────────────────────────────────────────────────────────
const now = Date.now()
const ins = db.prepare(`
  INSERT INTO memories (id, content, summary, category, memory_level, memory_type,
                        importance, content_vector, created_at, updated_at, last_accessed, access_count)
  VALUES (?, ?, ?, ?, ?, 'long_term', ?, ?, ?, ?, ?, 0)
`)
db.prepare(`DELETE FROM memories WHERE id LIKE 'vb-%'`).run()

const legacy = {
  'vb-l1': [1, 0, 0],
  'vb-l2': [0.9995, 0.0316, 0],
  'vb-l3': [0, 1, 0],
  'vb-l4': [0.5, 0.5, 0.7071067690849304],
  'vb-l5': [-1, 0, 0],
}
for (const [id, vec] of Object.entries(legacy)) {
  ins.run(id, `content ${id}`, `summary ${id}`, 'skill', 'semi_abstract', 6, JSON.stringify(vec), now, now, now)
}
ins.run('vb-blob', 'content vb-blob', 'summary vb-blob', 'skill', 'semi_abstract', 6, encodeVector([0, 0, 1]), now, now, now)
ins.run('vb-junk', 'content vb-junk', 'summary vb-junk', 'skill', 'semi_abstract', 6, 'not a vector', now, now, now)
ins.run('vb-empty', 'content vb-empty', 'summary vb-empty', 'skill', 'semi_abstract', 6, '', now, now, now)
ins.run('vb-null', 'content vb-null', 'summary vb-null', 'skill', 'semi_abstract', 6, null, now, now, now)

const kindOf = (id) => db.prepare(`SELECT typeof(content_vector) AS t FROM memories WHERE id = ?`).get(id).t
const vecOf = (id) => decodeVector(db.prepare(`SELECT content_vector AS v FROM memories WHERE id = ?`).get(id).v)
const legacyLeft = () => db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE id LIKE 'vb-%' AND typeof(content_vector)='text' AND content_vector != ''`).get().c

ok('seed: legacy rows are typeof text', Object.keys(legacy).every(id => kindOf(id) === 'text'))
ok('seed: pre-encoded row is typeof blob', kindOf('vb-blob') === 'blob')
ok('seed: 6 legacy text rows pending (5 vectors + 1 junk)', legacyLeft() === 6)

// Reset the completion marker so this test observes the migration itself, not
// the marker initMemory() may have set on the empty table at startup.
db.pragma('user_version = 0')

// Bounded: limit=2 scans exactly 2; with count:true it also reports the rest.
const r1 = migrateVectorsToBlob({ db, limit: 2, count: true })
ok('limit=2 scans exactly 2', r1.scanned === 2 && r1.converted + r1.skipped === 2)
ok('limit=2 is not drained and counts 4 remaining', r1.drained === false && r1.remaining === 4 && legacyLeft() === 4)
ok('completion marker NOT set while rows remain', db.pragma('user_version', { simple: true }) === 0)

// A cut-short run without count:true reports remaining=null — it must not COUNT(*).
const r1b = migrateVectorsToBlob({ db, limit: 1 })
ok('bounded run without count reports remaining=null, not a full-scan count', r1b.scanned === 1 && r1b.drained === false && r1b.remaining === null && legacyLeft() === 3)

// budgetMs=0: no batch may start, nothing changes.
const r0 = migrateVectorsToBlob({ db, budgetMs: 0 })
ok('budgetMs=0 scans nothing', r0.scanned === 0 && r0.drained === false && r0.remaining === null && legacyLeft() === 3)

// Resume to completion.
const r2 = migrateVectorsToBlob({ db })
ok('resume scans the remaining 3', r2.scanned === 3)
ok('across all runs: 5 vectors converted, 1 unparseable cleared',
   r1.converted + r1b.converted + r2.converted === 5 && r1.skipped + r1b.skipped + r2.skipped === 1)
ok('drained, remaining 0 after completion', r2.drained === true && r2.remaining === 0 && legacyLeft() === 0)
ok('completion marker set (user_version = 13)', db.pragma('user_version', { simple: true }) === 13)

ok('all legacy rows are now typeof blob', Object.keys(legacy).every(id => kindOf(id) === 'blob'))
ok('converted values are bit-identical to the originals',
   Object.entries(legacy).every(([id, vec]) => { const d = vecOf(id); return d && d.every((x, i) => x === Math.fround(vec[i])) }))
ok('pre-encoded blob row untouched', kindOf('vb-blob') === 'blob' && near(vecOf('vb-blob'), [0, 0, 1]))
ok('junk text row became NULL (re-embeddable, no longer counted as a vector)', kindOf('vb-junk') === 'null')
ok("'' row left as-is (already excluded by != '' everywhere)", kindOf('vb-empty') === 'text')
ok('NULL row left as-is', kindOf('vb-null') === 'null')

// Idempotent.
const r3 = migrateVectorsToBlob({ db })
ok('second full run is a no-op', r3.scanned === 0 && r3.converted === 0 && r3.skipped === 0 && r3.drained === true && r3.remaining === 0)

// The existing coverage predicate must still count BLOB rows as vectorised.
const covered = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE id LIKE 'vb-%' AND content_vector IS NOT NULL AND content_vector != ''`).get().c
ok("IS NOT NULL AND != '' counts the 6 BLOB rows and nothing else", covered === 6)

// The completion marker is one-way and honoured only when asked (skipIfComplete):
// a legacy row appearing after completion is left alone by the server's loop and
// converted by an explicit run — exactly what README documents for operators.
ins.run('vb-late', 'content vb-late', 'summary vb-late', 'skill', 'semi_abstract', 6, JSON.stringify([0.5, 0.5, 0]), now, now, now)
const r4 = migrateVectorsToBlob({ db, skipIfComplete: true })
ok('skipIfComplete with marker set → drained immediately, nothing scanned, late row untouched',
   r4.scanned === 0 && r4.drained === true && r4.remaining === 0 && kindOf('vb-late') === 'text')
const r5 = migrateVectorsToBlob({ db })
ok('explicit run ignores the marker and converts the late row', r5.converted === 1 && kindOf('vb-late') === 'blob')

// ── 3. A pre-existing reader sees both formats as one ───────────────────────
// memory-health's near-dup scan decodes whatever is in the column. Seed one
// legacy JSON row and one BLOB row that are near-identical and check the pair
// is found across the format boundary.
db.prepare(`DELETE FROM memories WHERE id LIKE 'vb-%'`).run()
db.pragma('user_version = 0')
// 'preference' is a real category (the column has a CHECK). On a scratch DB it
// holds only these two rows; on a shared DB it may not, so the count assertion
// tightens to exactly-one only when the bucket started empty.
const CROSS_CAT = 'preference'
const preexisting = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE category = ? AND deleted_at IS NULL`).get(CROSS_CAT).c
ins.run('vb-x-json', 'content x json', 'summary x json', CROSS_CAT, 'semi_abstract', 6, JSON.stringify([1, 0, 0]), now - 9 * 86400_000, now, now)
ins.run('vb-x-blob', 'content x blob', 'summary x blob', CROSS_CAT, 'semi_abstract', 6, encodeVector([0.9995, 0.0316, 0]), now - 8 * 86400_000, now, now)
{
  const nd = detectNearDup(db, { simFloor: 0.95, simDup: 0.97, simSupersede: 0.85 })
  const inCat = (list, cat) => (list || []).filter(c => c.cat === cat)
  const dups = inCat(nd.dup_candidates, CROSS_CAT).length
  // cos([1,0,0], [0.9995,0.0316,0]) = 0.9995 ≥ simDup.
  ok('memory-health dup scan pairs a legacy JSON row with a BLOB row (dual-format read)',
     preexisting === 0 ? dups === 1 : dups >= 1)
  ok('…and does not also file that pair as a supersede candidate',
     preexisting === 0 ? inCat(nd.supersede_candidates, CROSS_CAT).length === 0 : true)
}

// ── 4. The write-gate's ranker reads both formats too ────────────────────────
// findNearDuplicates = sqlite-vec shortlist + rankNearDuplicateCandidates. The
// shortlist needs the vec extension (absent in CI); the ranker is pure and is
// where the decode happens, so it is tested directly with mixed-format rows.
{
  const cands = [
    { id: 11, content_vector: JSON.stringify([1, 0, 0]),        summary: 'json twin' },
    { id: 12, content_vector: encodeVector([0.9995, 0.0316, 0]), summary: 'blob near-twin' },
    { id: 13, content_vector: 'junk',                            summary: 'undecodable' },
    { id: 14, content_vector: encodeVector([0, 1, 0]),           summary: 'orthogonal' },
  ]
  const ranked = rankNearDuplicateCandidates([1, 0, 0], cands, { threshold: 0.92 })
  ok('ranker returns the JSON row and the BLOB row, best first', ranked.length === 2 && ranked[0].id === 11 && ranked[1].id === 12)
  ok('ranker skips undecodable and below-threshold rows', !ranked.some(r => r.id === 13 || r.id === 14))
  ok('ranker cosines are exact (1.0 for the identical JSON row, 0.9995 for the BLOB twin)', ranked[0].cosine === 1 && ranked[1].cosine === 0.9995)
}

// cleanup
db.prepare(`DELETE FROM memories WHERE id LIKE 'vb-%'`).run()
db.close()
closeMemory()

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
