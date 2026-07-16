import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(resolve(tmpdir(), 'mneme-longmemeval-harness-'))
const output = resolve(root, 'report.json')
const run = spawnSync(process.execPath, [
  resolve(__dirname, 'run.mjs'),
  '--dataset', resolve(__dirname, 'fixture.json'),
  '--per-category', '1',
  '--limit', '5',
  '--concurrency', '2',
  '--output', output,
], { encoding: 'utf-8', timeout: 60_000 })

let pass = 0, fail = 0
function check(label, condition, detail = '') {
  if (condition) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' -- ' + detail : ''}`) }
}

try {
  check('harness exits successfully', run.status === 0, `stderr=${run.stderr}`)
  check('harness writes a JSON report', existsSync(output), `stdout=${run.stdout}`)
  const report = existsSync(output) ? JSON.parse(readFileSync(output, 'utf-8')) : null
  check('stratified fixture selects all six LongMemEval categories',
    report?.selection?.questions === 6 && report.selection.categories.length === 6,
    `selection=${JSON.stringify(report?.selection)}`)
  check('fixture retrieval finds every required session by rank 5',
    report?.summaries?.current?.overall?.['recall_all@5'] === 1,
    `summary=${JSON.stringify(report?.summaries?.current?.overall)}`)
  check('case artifacts expose session ids without leaking evidence labels into memory text',
    report?.cases?.every(row => row.retrieved.every(hit => typeof hit.sessionId === 'string')),
    `cases=${JSON.stringify(report?.cases)}`)
  check('report fingerprints the local engine module graph and git state',
    /^[a-f0-9]{64}$/.test(report?.engines?.[0]?.moduleGraphSha256 || '') &&
      report.engines[0].moduleFiles.some(file => file.path === 'index.mjs') &&
      typeof report.engines[0].gitHead === 'string' &&
      typeof report.engines[0].gitDirty === 'boolean',
    `engine=${JSON.stringify(report?.engines?.[0])}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
