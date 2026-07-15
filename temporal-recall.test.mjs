// End-to-end regression tests for temporal recall filtering and hysteresis.
// Uses a fresh temp DB via TOKENMEM_DB_PATH; never touches tokenmem.db.
// Run: node temporal-recall.test.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

const root = mkdtempSync(resolve(tmpdir(), 'mneme-temporal-recall-'))
process.env.TOKENMEM_DB_PATH = resolve(root, 'tokenmem.test.db')

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' -- ' + detail : ''}`) }
}

const originalNow = Date.now
const fixedNow = new Date(2026, 6, 15, 12, 0, 0, 0).getTime()
Date.now = () => fixedNow

try {
  const { initMemory, closeMemory, storeMemory, recallMemories } = await import('./index.mjs')
  initMemory()

  const ids = []
  for (let daysAgo = 0; daysAgo < 8; daysAgo++) {
    ids.push(storeMemory({
      content: `temporalhysttopic project decision memory day ${daysAgo}`,
      summary: `temporal recall day ${daysAgo}`,
      memoryType: 'long_term',
      category: 'decision',
      importance: 7,
    }))
  }

  const db = new Database(process.env.TOKENMEM_DB_PATH)
  const setCreatedAt = db.prepare('UPDATE memories SET created_at = ?, updated_at = ?, last_accessed = ? WHERE rowid = ?')
  for (let daysAgo = 0; daysAgo < ids.length; daysAgo++) {
    const timestamp = fixedNow - daysAgo * 86400_000
    setCreatedAt.run(timestamp, timestamp, timestamp, ids[daysAgo])
  }
  db.close()

  const strict = recallMemories({
    query: 'the past 3 days temporalhysttopic',
    limit: 10,
    _internal: true,
  })
  const strictFrom = new Date(2026, 6, 13, 0, 0, 0, 0).getTime()
  const strictTo = new Date(2026, 6, 15, 23, 59, 59, 999).getTime()
  check('temporal cue with three hits returns only in-window rows',
    strict.length === 3 && strict.every(row => row.created_at >= strictFrom && row.created_at <= strictTo),
    `rows=${JSON.stringify(strict.map(row => ({ id: row.rowid, created_at: row.created_at })))}`)
  check('strict temporal recall reports no hysteresis fallback',
    strict.every(row => row.temporal_match === true && row.temporal_fallback === false),
    `rows=${JSON.stringify(strict.map(row => ({ id: row.rowid, match: row.temporal_match, fallback: row.temporal_fallback })))}`)

  const noCue = recallMemories({ query: 'temporalhysttopic', limit: 10, _internal: true })
  check('query without temporal cue preserves the unfiltered result count',
    noCue.length === 8,
    `count=${noCue.length}`)
  check('query without temporal cue does not add temporal result metadata',
    noCue.every(row => !('temporal_match' in row) && !('temporal_fallback' in row)),
    `rows=${JSON.stringify(noCue)}`)

  const timeQuestion = recallMemories({
    query: '什么时候讨论了 temporalhysttopic',
    limit: 10,
    _internal: true,
  })
  check('“什么时候” question leaves recall unfiltered',
    timeQuestion.length === noCue.length,
    `timeQuestion=${timeQuestion.length} noCue=${noCue.length}`)

  const hysteresis = recallMemories({
    query: 'yesterday temporalhysttopic',
    limit: 5,
    _internal: true,
  })
  const yesterdayFrom = new Date(2026, 6, 14, 0, 0, 0, 0).getTime()
  const yesterdayTo = new Date(2026, 6, 14, 23, 59, 59, 999).getTime()
  check('one-hit temporal window falls back to more than three rows',
    hysteresis.length > 3 && hysteresis.some(row => row.created_at < yesterdayFrom || row.created_at > yesterdayTo),
    `rows=${JSON.stringify(hysteresis.map(row => ({ id: row.rowid, created_at: row.created_at })))}`)
  check('hysteresis boosts the in-window row to first place',
    hysteresis[0]?.created_at >= yesterdayFrom && hysteresis[0]?.created_at <= yesterdayTo &&
      hysteresis[0]?.temporal_match === true && hysteresis[0]?.score > hysteresis[1]?.score,
    `rows=${JSON.stringify(hysteresis.map(row => ({ id: row.rowid, created_at: row.created_at, score: row.score, match: row.temporal_match })))}`)
  check('hysteresis is explicitly marked on expanded results',
    hysteresis.every(row => row.temporal_fallback === true),
    `rows=${JSON.stringify(hysteresis.map(row => ({ id: row.rowid, fallback: row.temporal_fallback })))}`)

  closeMemory()
} finally {
  Date.now = originalNow
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
