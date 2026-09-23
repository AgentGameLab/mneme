// The DB path is read when the store opens, not when the module is imported.
//
// A host that imports mneme and then loads its own env file sets
// TOKENMEM_DB_PATH after ES import hoisting has already run this module's top
// level. With a module-level const the store silently opened the fallback DB
// beside index.mjs — and with more than one tenant on a machine, one tenant's
// writes landed in another's store.
//
// This file re-runs itself as a child with TOKENMEM_DB_PATH unset at import
// time, then sets it in the body — the host's order — and checks where the
// store actually opened.
//
// Run: TOKENMEM_DB_PATH=/tmp/x.db node db-path-late-env.integration.test.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

if (process.env.MNEME_LATE_DB_CHILD) {
  const { initMemory, closeMemory, storeMemory } = await import('./index.mjs')
  process.env.TOKENMEM_DB_PATH = process.env.MNEME_LATE_DB_CHILD   // host sets it after import
  initMemory()
  storeMemory({ content: 'late env marker', importance: 5, memoryLevel: 'semi_abstract', memoryType: 'long_term' })
  closeMemory()
  process.exit(0)
}

const target = process.env.TOKENMEM_DB_PATH
if (!target) { console.error('FATAL: set TOKENMEM_DB_PATH'); process.exit(2) }
const latePath = target + '.late.db'
for (const sfx of ['', '-shm', '-wal']) { if (existsSync(latePath + sfx)) unlinkSync(latePath + sfx) }

const env = { ...process.env, MNEME_LATE_DB_CHILD: latePath }
delete env.TOKENMEM_DB_PATH
delete env.MNEME_DB_PATH
const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env, encoding: 'utf-8', timeout: 30000 })

let pass = 0, fail = 0
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' — ' + detail : ''}`) }
}
check('child ran cleanly', r.status === 0, (r.stderr || '').slice(0, 300))
check('store opened the path set after import', existsSync(latePath), latePath)

for (const sfx of ['', '-shm', '-wal']) { try { unlinkSync(latePath + sfx) } catch {} }
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
