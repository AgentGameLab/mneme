// Regression tests for `--store --supersedes` on the CLI.
// Uses a fresh temp DB via TOKENMEM_DB_PATH; never touches tokenmem.db.
// Run: node cli-supersedes.test.mjs
//
// Why this flag needed a test rather than just a pass-through: a *partial*
// supersede is worse than none. If one of the requested rowids is already
// deleted/superseded/nonexistent, the write still lands and the stale version
// stays live and recallable — the correction looks applied and isn't. So the
// CLI pre-checks the targets and refuses the whole write, rather than letting
// storeMemory silently point at whatever still exists.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(resolve(tmpdir(), 'mneme-cli-supersedes-'))
const DB_PATH = resolve(root, 'tokenmem.test.db')
const INDEX = resolve(__dirname, 'index.mjs')

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' -- ' + detail : ''}`) }
}

function cli(...args) {
  return spawnSync(process.execPath, [INDEX, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH, EMBEDDING_API_KEY: '' },
  })
}

function storedId(r) {
  const m = /^stored: (\d+)$/m.exec(r.stdout || '')
  return m ? m[1] : null
}

try {
  // Seed a record to supersede.
  const first = cli('--store', 'first version of the claim', '--category', 'general', '--type', 'working')
  const id1 = storedId(first)
  check('plain --store still works without --supersedes', id1 !== null, first.stderr)

  // Malformed rowid → refuse before writing.
  const bad = cli('--store', 'x', '--supersedes', 'abc')
  check('non-numeric target exits 1', bad.status === 1, `status=${bad.status}`)
  check('non-numeric target names the bad value', /abc/.test(bad.stderr || ''), bad.stderr)

  // Nonexistent rowid → refuse before writing.
  const missing = cli('--store', 'x', '--supersedes', '99999999')
  check('nonexistent target exits 1', missing.status === 1, `status=${missing.status}`)

  // A refused call must not have written anything.
  const db1 = new Database(DB_PATH, { readonly: true })
  const afterRefusals = db1.prepare('SELECT COUNT(*) c FROM memories').get().c
  db1.close()
  check('refused calls write nothing', afterRefusals === 1, `rows=${afterRefusals}`)

  // Happy path.
  const second = cli('--store', 'second version of the claim', '--category', 'general', '--type', 'working', '--supersedes', id1)
  const id2 = storedId(second)
  check('supersede stores a new record', id2 !== null, second.stderr)
  check('supersede reports which ids it replaced', new RegExp(`superseded: ${id1}`).test(second.stdout || ''), second.stdout)

  const db2 = new Database(DB_PATH, { readonly: true })
  const old = db2.prepare('SELECT superseded_by FROM memories WHERE rowid = ?').get(Number(id1))
  db2.close()
  check('old record points at the new one', String(old?.superseded_by) === String(id2), JSON.stringify(old))

  // Superseding an already-superseded row is a no-op trap: refuse it too.
  const again = cli('--store', 'third version', '--supersedes', id1)
  check('already-superseded target exits 1', again.status === 1, `status=${again.status}`)

  // Partial batch must fail whole: one live id + one dead id writes nothing.
  const third = cli('--store', 'a live record', '--category', 'general', '--type', 'working')
  const id3 = storedId(third)
  const db3 = new Database(DB_PATH, { readonly: true })
  const before = db3.prepare('SELECT COUNT(*) c FROM memories').get().c
  db3.close()
  const partial = cli('--store', 'x', '--supersedes', `${id3},99999999`)
  const db4 = new Database(DB_PATH, { readonly: true })
  const after = db4.prepare('SELECT COUNT(*) c FROM memories').get().c
  const stillLive = db4.prepare('SELECT superseded_by FROM memories WHERE rowid = ?').get(Number(id3))
  db4.close()
  check('partly-dead target list exits 1', partial.status === 1, `status=${partial.status}`)
  check('partly-dead target list writes nothing', after === before, `${before} → ${after}`)
  check('partly-dead target list leaves the live target alone', stillLive?.superseded_by == null, JSON.stringify(stillLive))

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
} finally {
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}
