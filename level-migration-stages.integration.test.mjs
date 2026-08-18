// The ageing ladder: meta -> semi -> concrete, with brakes.
//
// Before the second stage, semi_abstract was terminal — rows arrived from meta
// and never left, so an entry that stopped being useful kept competing at
// weight 1.0 with live ones in every recall. On the live store: 1,276 rows past
// 30 days with zero recalls sitting in semi, against 78 in concrete_trace.
//
// Run: node level-migration-stages.integration.test.mjs
import { initMemory, storeMemory, runLevelMigration, closeMemory } from './index.mjs'
import Database from 'better-sqlite3'

const DB_PATH = process.env.TOKENMEM_DB_PATH
if (!DB_PATH) { console.error('FATAL: set TOKENMEM_DB_PATH'); process.exit(2) }

let pass = 0, fail = 0
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' — ' + detail : ''}`) }
}

initMemory()
const db = new Database(DB_PATH)
const D = 86400_000
const age = (id, days, ac) =>
  db.prepare('UPDATE memories SET created_at = ?, access_count = ? WHERE rowid = ?')
    .run(Date.now() - days * D, ac, id)
const levelOf = (id) => db.prepare('SELECT memory_level l FROM memories WHERE rowid = ?').get(id).l
const mk = (lv, extra = {}) => storeMemory({ content: `row ${Math.random()}`, memoryLevel: lv, importance: 8, memoryType: 'long_term', ...extra })

// stale semi: 120d old, 1 recall -> should drop to concrete
const staleSemi = mk('semi_abstract');            age(staleSemi, 120, 1)
// young semi: 40d old, 0 recalls -> NOT yet (the 30d arm belongs to meta only)
const youngSemi = mk('semi_abstract');            age(youngSemi, 40, 0)
// busy semi: old but used -> stays
const busySemi = mk('semi_abstract');             age(busySemi, 200, 30)
// pinned stale semi -> exempt
const pinnedSemi = mk('semi_abstract', { isPinned: true }); age(pinnedSemi, 200, 0)
// anchored stale meta -> exempt from the first stage too
const anchoredMeta = mk('meta_knowledge', { isAnchor: true }); age(anchoredMeta, 200, 0)
// plain stale meta -> demotes one step only
const staleMeta = mk('meta_knowledge');           age(staleMeta, 200, 0)
// cold concrete that got popular -> promotes
const hotConcrete = mk('concrete_trace');         age(hotConcrete, 200, 12)

const r = runLevelMigration({ dryRun: false })

check('stale semi_abstract drops to concrete_trace', levelOf(staleSemi) === 'concrete_trace', levelOf(staleSemi))
check('a 40d semi is not touched — the 30d arm is meta-only',
  levelOf(youngSemi) === 'semi_abstract', levelOf(youngSemi))
check('an old but frequently recalled semi stays', levelOf(busySemi) === 'semi_abstract', levelOf(busySemi))

check('a PINNED stale semi is exempt from demotion', levelOf(pinnedSemi) === 'semi_abstract', levelOf(pinnedSemi))
check('an ANCHORED stale meta is exempt from demotion', levelOf(anchoredMeta) === 'meta_knowledge', levelOf(anchoredMeta))

// The anti-cascade: one night must move a row one step, not two.
check('stale meta demotes exactly one step (no meta->semi->concrete in one run)',
  levelOf(staleMeta) === 'semi_abstract', levelOf(staleMeta))

check('a well-used concrete still promotes', levelOf(hotConcrete) === 'semi_abstract', levelOf(hotConcrete))

// Direction counting: semi->concrete must count as demotion, not promotion.
check('demotions counted as demotions', r.demoted >= 2, JSON.stringify({ demoted: r.demoted, promoted: r.promoted }))
check('the one real promotion is counted separately', r.promoted >= 1, JSON.stringify({ demoted: r.demoted, promoted: r.promoted }))

// Second night: the row that moved to semi is now eligible for stage two only
// once it ALSO clears 90d — it already has, so it should now step again.
const before2 = levelOf(staleMeta)
runLevelMigration({ dryRun: false })
check('on a later run the demoted row continues down the ladder',
  before2 === 'semi_abstract' && levelOf(staleMeta) === 'concrete_trace', levelOf(staleMeta))

db.close(); closeMemory()
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
