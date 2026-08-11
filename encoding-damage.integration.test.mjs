// End-to-end: encoding-damage detection on BOTH write paths.
//
// The detector shipped in a downstream runtime copy and was lost coming up:
// the definition and the storeMemory() call site never made the trip, while
// storeMemoryQuarantined() kept calling it. Nothing failed, because the
// quarantine suite only ever called that function WITHOUT opts.out — the
// `if (opts.out)` guard skipped the undefined call, 25/25 stayed green, and
// the first real quarantined write would have thrown ReferenceError.
//
// So the contract these tests protect is not "the regex works". It is that
// every path which accepts opts.out is actually exercised WITH opts.out —
// an optional-output parameter that no test populates is an untested branch
// wearing a passing suite.
//
// Run: node encoding-damage.integration.test.mjs
import {
  initMemory, closeMemory, storeMemory, storeMemoryQuarantined,
  detectEncodingDamage, listQuarantine,
} from './index.mjs'
import Database from 'better-sqlite3'

const DB_PATH = process.env.TOKENMEM_DB_PATH
if (!DB_PATH) { console.error('FATAL: set TOKENMEM_DB_PATH'); process.exit(2) }

let pass = 0, fail = 0
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' — ' + detail : ''}`) }
}

// ── detector unit surface ──
{
  const dmg = detectEncodingDamage('daemon ????????? cp936 ????')
  check('a long run of ? is flagged', !!dmg && dmg.maxRun >= 4, JSON.stringify(dmg))
  check('the report carries count and longest run',
    dmg?.qmarkCount >= 4 && typeof dmg.ratio === 'number', JSON.stringify(dmg))

  check('ordinary prose with a question mark is not flagged',
    detectEncodingDamage('is the daemon up? it looked fine at 04:00') === null)
  check('intact CJK is not flagged',
    detectEncodingDamage('daemon 重启脚本在 workspace/scripts 下，怎么跑？') === null)
  check('a short string is never flagged', detectEncodingDamage('??') === null)
  check('empty input is not flagged', detectEncodingDamage(null, undefined) === null)

  // The second trigger: mojibake wiped the CJK entirely, so there is no long
  // run left to find — only a high '?' density on a CJK-less string.
  check('dense ? on a CJK-less string is flagged',
    !!detectEncodingDamage('cfg ? ? ? ? ? ok'), 'density branch')
  check('summary is scanned too, not just content',
    !!detectEncodingDamage('fine content here', '????????'))
}

initMemory()
const db = new Database(DB_PATH)

// ── main write path ──
{
  const out = {}
  const id = storeMemory({
    content: 'restart runbook ????????? lives on the box',
    importance: 6, memoryType: 'long_term', memoryLevel: 'semi_abstract',
  }, { out })
  check('storeMemory still stores the row — detection never blocks a write', !!id)
  check('storeMemory reports the damage through opts.out',
    !!out.encodingWarning && out.encodingWarning.maxRun >= 4, JSON.stringify(out))

  // by rowid, not by the `id` column: storeMemory returns the rowid as a string,
  // while `memories.id` holds a separate hex hash. Everything user-facing (recall
  // hits, recall_by_id) speaks rowid.
  const row = db.prepare('SELECT content FROM memories WHERE rowid = ?').get(id)
  check('the damaged content is stored verbatim, not silently rewritten',
    row?.content?.includes('?????'), row?.content?.slice(0, 40))
}
{
  const out = {}
  const id = storeMemory({
    content: 'restart runbook 重启手册 lives on the box',
    importance: 6, memoryType: 'long_term', memoryLevel: 'semi_abstract',
  }, { out })
  check('a clean write sets no warning', !!id && !out.encodingWarning, JSON.stringify(out))
}
{
  // The exact shape that hid the bug: opts.out absent. Must not throw.
  let threw = null
  try { storeMemory({ content: 'no out object ?????????', importance: 5 }) }
  catch (e) { threw = e }
  check('storeMemory without opts.out does not throw', threw === null, String(threw))
}

// ── quarantine write path — the one that was broken ──
{
  const out = {}
  let threw = null, qid = null
  try {
    qid = storeMemoryQuarantined({
      content: 'quarantined runbook ????????? on the box',
      importance: 6, memoryType: 'long_term', memoryLevel: 'semi_abstract',
      sourceHost: 'codex',
    }, { out })
  } catch (e) { threw = e }
  check('storeMemoryQuarantined with opts.out does not throw', threw === null, String(threw))
  check('the quarantined row is stored', !!qid)
  check('storeMemoryQuarantined reports the damage through opts.out',
    !!out.encodingWarning && out.encodingWarning.maxRun >= 4, JSON.stringify(out))
  check('the row is really in quarantine, not the main pool',
    listQuarantine({ status: 'pending' }).some(r => String(r.qid) === String(qid)))
}
{
  let threw = null
  try { storeMemoryQuarantined({ content: 'no out here ?????????', importance: 5, sourceHost: 'codex' }) }
  catch (e) { threw = e }
  check('storeMemoryQuarantined without opts.out does not throw', threw === null, String(threw))
}

db.close()
closeMemory()
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
