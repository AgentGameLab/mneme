// End-to-end smoke: memory-health module + --health / --surface-cold /
// --consolidate CLIs. Uses a fresh temp DB via TOKENMEM_DB_PATH so it's
// safe to run in CI and never touches a user's real store.
// Run: TOKENMEM_DB_PATH=$(mktemp -u) node memory-health.test.mjs

import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, unlinkSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.TOKENMEM_DB_PATH
if (!DB_PATH) {
  console.error('FATAL: set TOKENMEM_DB_PATH to a temp path before running this test.')
  process.exit(2)
}
for (const suffix of ['', '-shm', '-wal']) {
  const p = DB_PATH + suffix
  if (existsSync(p)) unlinkSync(p)
}

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' — ' + detail : ''}`) }
}

// ── Unit: isNoiseQuery ──
{
  const { isNoiseQuery } = await import('./memory-health.mjs')
  check('isNoiseQuery: ok', isNoiseQuery('ok'))
  check('isNoiseQuery: thanks', isNoiseQuery('thanks'))
  check('isNoiseQuery: id:123', isNoiseQuery('id: 42'))
  check('isNoiseQuery: url', isNoiseQuery('https://example.com'))
  check('isNoiseQuery: file path', isNoiseQuery('foo.mjs'))
  check('isNoiseQuery: node cmd', isNoiseQuery('node index.mjs --stats'))
  check('isNoiseQuery: real question', !isNoiseQuery('how do I start the daemon?'))
  check('isNoiseQuery: real short zh', !isNoiseQuery('内存 gate 是啥'))
}

// ── Initialize a fresh DB via index.mjs migrations ──
{
  const { initMemory, closeMemory, storeMemory, runDecayCycle } = await import('./index.mjs')
  initMemory()
  // Seed with a handful of rows across levels + importances + ages.
  const now = Date.now()
  const D45 = 45 * 86400_000
  // 3 hot meta, 2 stale meta, 4 stale concrete
  storeMemory({ content: 'hot meta pattern one', memoryLevel: 'meta_knowledge', importance: 8, memoryType: 'long_term' })
  storeMemory({ content: 'hot meta pattern two', memoryLevel: 'meta_knowledge', importance: 8, memoryType: 'long_term' })
  storeMemory({ content: 'stale meta candidate one', memoryLevel: 'meta_knowledge', importance: 8, memoryType: 'long_term' })
  storeMemory({ content: 'stale meta candidate two', memoryLevel: 'meta_knowledge', importance: 8, memoryType: 'long_term' })
  storeMemory({ content: 'concrete op log one', memoryLevel: 'concrete_trace', importance: 4, memoryType: 'long_term' })
  storeMemory({ content: 'concrete op log two', memoryLevel: 'concrete_trace', importance: 4, memoryType: 'long_term' })
  storeMemory({ content: 'concrete op log three', memoryLevel: 'concrete_trace', importance: 4, memoryType: 'long_term' })
  // Violation: concrete with importance>5 (health should surface it).
  storeMemory({ content: 'concrete rule violation', memoryLevel: 'concrete_trace', importance: 8, memoryType: 'long_term' })
  // Age some rows backward via raw SQL to trip surface-cold / dead-knowledge.
  const Database = (await import('better-sqlite3')).default
  const db = new Database(DB_PATH)
  db.prepare('UPDATE memories SET last_accessed = ?, created_at = ? WHERE content LIKE ?').run(now - D45, now - D45, '%stale meta%')
  db.prepare('UPDATE memories SET last_accessed = ?, decay_score = 0.2 WHERE content LIKE ?').run(now - D45, '%op log%')
  db.close()
  closeMemory()
}

// ── --health JSON: structure + counts ──
{
  const r = spawnSync(process.execPath, [resolve(__dirname, 'index.mjs'), '--health', '--format', 'json'], {
    encoding: 'utf-8', env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH },
  })
  check('--health exit=0', r.status === 0, `stderr=${(r.stderr||'').slice(0,200)}`)
  const body = (r.stdout || '').split('\n').filter(l => l.trim().startsWith('{')).slice(-1)[0]
    || (r.stdout || '').split('\n').find(l => l.trim().startsWith('{'))
  let report
  try { report = JSON.parse((r.stdout || '').substring((r.stdout || '').indexOf('{'))) } catch { report = null }
  check('--health JSON parseable', report !== null)
  if (report) {
    check('--health inflation.total >= 8', report.inflation.total >= 8, `total=${report.inflation.total}`)
    check('--health surfaces concrete importance violation', report.inflation.concrete_importance_violations >= 1)
    check('--health lists dead_concrete rows', report.dead_concrete.length >= 3, `count=${report.dead_concrete.length}`)
    check('--health blindspot gracefully unavailable on fresh DB',
      report.blindspot && report.blindspot.available === false)
    check('--health has thresholds', typeof report.thresholds === 'object' && report.thresholds.sim_dup > 0)
  }
}

// ── --health text: renders headings ──
{
  const r = spawnSync(process.execPath, [resolve(__dirname, 'index.mjs'), '--health', '--format', 'text'], {
    encoding: 'utf-8', env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH },
  })
  check('--health text exit=0', r.status === 0)
  check('--health text has TL;DR', /## TL;DR/.test(r.stdout))
  check('--health text has (a) section', /## \(a\)/.test(r.stdout))
}

// ── --surface-cold text + JSON ──
{
  const rj = spawnSync(process.execPath, [resolve(__dirname, 'index.mjs'), '--surface-cold', '--min-importance', '7', '--days', '30', '--limit', '10', '--format', 'json'], {
    encoding: 'utf-8', env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH },
  })
  check('--surface-cold JSON exit=0', rj.status === 0, rj.stderr?.slice(0, 200))
  let payload
  try { payload = JSON.parse((rj.stdout || '').substring((rj.stdout || '').indexOf('{'))) } catch { payload = null }
  check('--surface-cold JSON parseable', payload !== null)
  check('--surface-cold surfaces stale meta rows', payload && payload.count >= 2 && payload.rows.every(r => r.importance >= 7),
    payload ? `count=${payload.count}` : 'no payload')

  const rt = spawnSync(process.execPath, [resolve(__dirname, 'index.mjs'), '--surface-cold', '--min-importance', '7', '--days', '30', '--limit', '3'], {
    encoding: 'utf-8', env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH },
  })
  check('--surface-cold text exit=0', rt.status === 0)
  check('--surface-cold text has READ-ONLY footer', /READ-ONLY/.test(rt.stdout))
}

// ── --consolidate --dry-run: no writes ──
{
  const Database = (await import('better-sqlite3')).default
  const dbBefore = new Database(DB_PATH, { readonly: true })
  const active_before = dbBefore.prepare('SELECT COUNT(*) c FROM memories WHERE deleted_at IS NULL').get().c
  dbBefore.close()

  const r = spawnSync(process.execPath, [resolve(__dirname, 'index.mjs'), '--consolidate', '--dry-run'], {
    encoding: 'utf-8', env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH },
  })
  check('--consolidate --dry-run exit=0', r.status === 0, r.stderr?.slice(0, 200))
  let result
  try { result = JSON.parse((r.stdout || '').substring((r.stdout || '').indexOf('{'))) } catch { result = null }
  check('--consolidate --dry-run JSON parseable', result !== null)
  check('--consolidate --dry-run marks dryRun=true', result?.dryRun === true)
  check('--consolidate --dry-run reports level_migrate', typeof result?.level_migrate === 'object')

  const dbAfter = new Database(DB_PATH, { readonly: true })
  const active_after = dbAfter.prepare('SELECT COUNT(*) c FROM memories WHERE deleted_at IS NULL').get().c
  dbAfter.close()
  check('--consolidate --dry-run did NOT mutate', active_before === active_after, `${active_before} -> ${active_after}`)
}

// ── --consolidate (real run): idempotent-ish ──
{
  const r1 = spawnSync(process.execPath, [resolve(__dirname, 'index.mjs'), '--consolidate'], {
    encoding: 'utf-8', env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH },
  })
  check('--consolidate exit=0', r1.status === 0, r1.stderr?.slice(0, 200))
  let result
  try { result = JSON.parse((r1.stdout || '').substring((r1.stdout || '').indexOf('{'))) } catch { result = null }
  check('--consolidate returned decay + level_migrate', result?.decay && result?.level_migrate)
  check('--consolidate demoted at least one stale meta', (result?.level_migrate?.demoted || 0) >= 1,
    `demoted=${result?.level_migrate?.demoted}`)

  // Second run should be idempotent — no more meta rows to demote.
  const r2 = spawnSync(process.execPath, [resolve(__dirname, 'index.mjs'), '--consolidate'], {
    encoding: 'utf-8', env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH },
  })
  check('--consolidate second run exit=0', r2.status === 0)
  const result2 = JSON.parse((r2.stdout || '').substring((r2.stdout || '').indexOf('{')))
  check('--consolidate second run: no additional demotes', (result2?.level_migrate?.demoted || 0) === 0,
    `demoted=${result2?.level_migrate?.demoted}`)
}

// Cleanup temp DB files
for (const suffix of ['', '-shm', '-wal']) {
  const p = DB_PATH + suffix
  try { if (existsSync(p)) unlinkSync(p) } catch {}
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
