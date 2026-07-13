// End-to-end smoke: `locations` KV layer — API + CLI + hook front-load.
// Uses TOKENMEM_DB_PATH sandboxing so it's safe to run in CI and never
// touches a user's real store.
// Run: TOKENMEM_DB_PATH=$(mktemp -u) node locations.test.mjs

import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, unlinkSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

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

function cli(args, opts = {}) {
  return spawnSync(process.execPath, [resolve(__dirname, 'index.mjs'), ...args], {
    encoding: 'utf-8',
    env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH, ...(opts.env || {}) },
    input: opts.input,
  })
}

// ── API round-trip ──
{
  const { initMemory, closeMemory, setLocation, getLocation, listLocations, deleteLocation, importLocations } = await import('./index.mjs')
  initMemory()

  const r1 = setLocation({ name: 'download', path: 'E:/download', notes: 'main' })
  check('setLocation returns created=true', r1.created === true && r1.updated === false)
  check('setLocation captures notes + kind default', r1.notes === 'main' && r1.kind === 'dir')

  const r2 = setLocation({ name: 'godot', path: 'E:/tools/godot', aliases: ['gd', 'godot4'], kind: 'dir' })
  check('setLocation with aliases stores array', JSON.stringify(r2.aliases) === JSON.stringify(['gd', 'godot4']))

  const rExact = getLocation('download')
  check('getLocation exact match returns row', rExact?.path === 'E:/download')

  const rAlias = getLocation('gd')
  check('getLocation via alias returns primary row', rAlias?.name === 'godot' && rAlias.path === 'E:/tools/godot')

  const rAlias2 = getLocation('godot4')
  check('getLocation via secondary alias also works', rAlias2?.name === 'godot')

  const rMiss = getLocation('nope')
  check('getLocation miss returns null', rMiss === null)

  const list = listLocations()
  check('listLocations returns 2 rows sorted', list.length === 2 && list[0].name === 'download' && list[1].name === 'godot')

  const listFiltered = listLocations({ kind: 'executable' })
  check('listLocations filter by kind returns empty when none match', listFiltered.length === 0)

  let threw = false
  try { setLocation({ name: 'download', path: 'E:/other' }) } catch { threw = true }
  check('setLocation refuses conflicting path without force', threw)

  const rForce = setLocation({ name: 'download', path: 'E:/other', force: true })
  check('setLocation with force=true overwrites', rForce.updated === true && rForce.path === 'E:/other')

  check('deleteLocation removes row', deleteLocation('godot') === true)
  check('deleteLocation twice returns false the second time', deleteLocation('godot') === false)
  check('listLocations reflects delete', listLocations().length === 1)

  // Input validation
  let threwName = false, threwPath = false, threwKind = false
  try { setLocation({ path: 'x' }) } catch { threwName = true }
  try { setLocation({ name: 'y' }) } catch { threwPath = true }
  try { setLocation({ name: 'z', path: 'p', kind: 'invalid' }) } catch { threwKind = true }
  check('setLocation rejects missing name', threwName)
  check('setLocation rejects missing path', threwPath)
  check('setLocation rejects invalid kind', threwKind)

  // Bulk import — array and object shapes
  const arrRes = importLocations([
    { name: 'a1', path: '/a1' },
    { name: 'a2', path: '/a2', kind: 'file' },
  ])
  check('importLocations array shape adds 2', arrRes.added === 2 && arrRes.errors.length === 0)

  const objRes = importLocations({ b1: '/b1', b2: { path: '/b2', aliases: ['bb2'] } })
  check('importLocations object shape mixes string + object', objRes.added === 2)
  check('importLocations preserved alias on object shape', getLocation('bb2')?.name === 'b2')

  const conflictRes = importLocations({ a1: '/different' })
  check('importLocations skips conflicts without force', conflictRes.skipped === 1 && conflictRes.errors.length === 0)

  const forceRes = importLocations({ a1: '/different' }, { force: true })
  check('importLocations with force overwrites', forceRes.updated === 1 && getLocation('a1')?.path === '/different')

  closeMemory()
}

// ── CLI round-trip ──
{
  // Fresh DB for the CLI test — the API test left rows in the same file.
  for (const suffix of ['', '-shm', '-wal']) {
    const p = DB_PATH + suffix
    if (existsSync(p)) unlinkSync(p)
  }

  const rSet = cli(['--set-path', 'download', 'E:/download'])
  check('cli --set-path exit=0', rSet.status === 0)
  const setPayload = JSON.parse(rSet.stdout.substring(rSet.stdout.indexOf('{')))
  check('cli --set-path returns created=true', setPayload.created === true)

  const rGet = cli(['--get-path', 'download'])
  check('cli --get-path text prints path', rGet.status === 0 && rGet.stdout.includes('E:/download'))

  const rMiss = cli(['--get-path', 'nothing'])
  check('cli --get-path miss exits 1', rMiss.status === 1)

  const rList = cli(['--list-paths', '--format', 'json'])
  const listPayload = JSON.parse(rList.stdout.substring(rList.stdout.indexOf('[')))
  check('cli --list-paths --format json returns array', Array.isArray(listPayload) && listPayload.length === 1)

  // Import via a JSON file
  const importFile = DB_PATH + '.import.json'
  writeFileSync(importFile, JSON.stringify({ godot: 'E:/tools/godot' }))
  const rImport = cli(['--import-paths', importFile])
  check('cli --import-paths exit=0', rImport.status === 0)
  try { unlinkSync(importFile) } catch {}

  const rDelete = cli(['--delete-path', 'download'])
  check('cli --delete-path exit=0 when row existed', rDelete.status === 0)

  const rDeleteMiss = cli(['--delete-path', 'nothing'])
  check('cli --delete-path exit=1 when row missing', rDeleteMiss.status === 1)
}

// ── Hook front-load integration ──
{
  for (const suffix of ['', '-shm', '-wal']) {
    const p = DB_PATH + suffix
    if (existsSync(p)) unlinkSync(p)
  }
  const stateDir = mkdtempSync(resolve(tmpdir(), 'mneme-loc-hook-state-'))
  try {
    cli(['--set-path', 'download', 'E:/download'])
    cli(['--set-path', 'godot', 'E:/tools/godot', '--alias', 'gd,godot4', '--notes', 'engine'])

    const runHook = (payload) => spawnSync(process.execPath, [resolve(__dirname, 'hooks/tool-recall-pre.mjs')], {
      encoding: 'utf-8', input: JSON.stringify(payload),
      env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH, MNEME_DB_PATH: DB_PATH, MNEME_STATE_DIR: stateDir },
    })

    const r1 = runHook({ session_id: 'hook-t1', tool_name: 'Bash', tool_input: { command: 'ls download/subdir' } })
    check('hook Bash with alias in command exit=0', r1.status === 0)
    const out1 = r1.stdout ? JSON.parse(r1.stdout) : null
    const ctx1 = out1?.hookSpecificOutput?.additionalContext || ''
    check('hook Bash alias injects locations banner', ctx1.includes('mneme locations') && ctx1.includes('download → E:/download'))

    const r2 = runHook({ session_id: 'hook-t2', tool_name: 'Read', tool_input: { file_path: 'E:/tools/godot/README' } })
    const ctx2 = r2.stdout ? JSON.parse(r2.stdout).hookSpecificOutput?.additionalContext || '' : ''
    check('hook Read resolves godot from file_path token', ctx2.includes('godot → E:/tools/godot'))

    const r3 = runHook({ session_id: 'hook-t3', tool_name: 'Bash', tool_input: { command: 'cd gd && ls' } })
    const ctx3 = r3.stdout ? JSON.parse(r3.stdout).hookSpecificOutput?.additionalContext || '' : ''
    check('hook Bash resolves via alias "gd"', ctx3.includes('via alias "gd"'))

    const r4 = runHook({ session_id: 'hook-t4', tool_name: 'Bash', tool_input: { command: 'pwd' } })
    check('hook silent when no alias / no memory hit', r4.status === 0 && !r4.stdout)
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }) } catch {}
  }
}

// Cleanup
for (const suffix of ['', '-shm', '-wal']) {
  const p = DB_PATH + suffix
  try { if (existsSync(p)) unlinkSync(p) } catch {}
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
