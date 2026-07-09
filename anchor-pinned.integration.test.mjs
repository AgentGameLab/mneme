// End-to-end: is_anchor / is_pinned quota gate + INSERT round-trip
// Run: node anchor-pinned.integration.test.mjs
import { storeMemory, initMemory } from './index.mjs'

initMemory()

let pass = 0, fail = 0
const testIds = []

function verifyRow(id) {
  // Read via storeMemory's own db — pull count via a fresh storeMemory hit
  // Simplest: since we don't export getDb, rely on second store with dedup to prove it exists.
  // But for is_anchor read we need raw sql. We'll do this via a wrapper that opens the same db
  // *without* extension load — is_anchor/is_pinned reads don't trigger FTS insert triggers.
}

import Database from 'better-sqlite3'
// Read-only connection to check is_anchor / is_pinned values — no writes, no FTS trigger, tokenizer irrelevant
const dbRead = new Database('./engram.db', { readonly: true })

const baseAnchor = dbRead.prepare('SELECT COUNT(*) as c FROM memories WHERE is_anchor = 1 AND deleted_at IS NULL').get().c
const basePinned = dbRead.prepare('SELECT COUNT(*) as c FROM memories WHERE is_pinned = 1 AND deleted_at IS NULL').get().c
console.log(`baseline: anchor=${baseAnchor} pinned=${basePinned}`)

// Case 1: is_anchor true, quota not full → flag set
{
  const stamp = Math.floor(Math.random() * 1e6)
  const out = {}
  const id = storeMemory({
    content: `test anchor payload [test-marker-anchor-${stamp}]`,
    memoryType: 'short_term',
    isAnchor: true,
  }, { out })
  testIds.push(id)
  const row = dbRead.prepare('SELECT is_anchor, is_pinned FROM memories WHERE rowid = ?').get(id)
  const ok = row.is_anchor === 1 && row.is_pinned === 0 && !out.quotaRejected
  if (ok) pass++; else fail++
  console.log(`${ok?'✓':'✗'} case1 anchor-set: id=${id} is_anchor=${row.is_anchor} quotaRejected=${!!out.quotaRejected}`)
}

// Case 2: is_pinned true → flag set
{
  const stamp = Math.floor(Math.random() * 1e6)
  const out = {}
  const id = storeMemory({
    content: `test pinned payload [test-marker-pinned-${stamp}]`,
    memoryType: 'short_term',
    isPinned: true,
  }, { out })
  testIds.push(id)
  const row = dbRead.prepare('SELECT is_anchor, is_pinned FROM memories WHERE rowid = ?').get(id)
  const ok = row.is_pinned === 1 && row.is_anchor === 0 && !out.quotaRejected
  if (ok) pass++; else fail++
  console.log(`${ok?'✓':'✗'} case2 pinned-set: id=${id} is_pinned=${row.is_pinned}`)
}

// Case 3: neither flag → both stay 0
{
  const stamp = Math.floor(Math.random() * 1e6)
  const out = {}
  const id = storeMemory({
    content: `test neutral payload [test-marker-neutral-${stamp}]`,
    memoryType: 'short_term',
  }, { out })
  testIds.push(id)
  const row = dbRead.prepare('SELECT is_anchor, is_pinned FROM memories WHERE rowid = ?').get(id)
  const ok = row.is_anchor === 0 && row.is_pinned === 0
  if (ok) pass++; else fail++
  console.log(`${ok?'✓':'✗'} case3 neutral: id=${id} is_anchor=${row.is_anchor}/${row.is_pinned}`)
}

// Case 4: quota check via mocked count. Rather than actually filling 30/40 rows,
// verify the code path by momentarily flagging existing test rows as anchor via a
// raw-sql UPDATE (bypass storeMemory to avoid FTS trigger issues on this connection).
// Then attempt a new store with isAnchor → should be rejected.
//
// We open a write connection WITHOUT extension load — UPDATE on existing rows does NOT
// trigger the FTS insert/update trigger (those fire on INSERT/UPDATE of content/summary/tags),
// so UPDATE is_anchor is safe with unicode61 tokenizer default.
const dbWrite = new Database('./engram.db')
try {
  // Get 40 existing rows (real anchors + top importance) and temp-flag them
  const rowsToFlag = dbRead.prepare('SELECT rowid FROM memories WHERE deleted_at IS NULL AND is_anchor = 0 ORDER BY importance DESC, rowid LIMIT ?').all(40 - baseAnchor)
  const flagStmt = dbWrite.prepare('UPDATE memories SET is_anchor = 1 WHERE rowid = ?')
  const unflagStmt = dbWrite.prepare('UPDATE memories SET is_anchor = 0 WHERE rowid = ?')
  for (const r of rowsToFlag) flagStmt.run(r.rowid)
  const filled = dbRead.prepare('SELECT COUNT(*) as c FROM memories WHERE is_anchor = 1 AND deleted_at IS NULL').get().c
  console.log(`  anchor filled to ${filled} via UPDATE (baseline ${baseAnchor})`)

  const stamp = Math.floor(Math.random() * 1e6)
  const out = {}
  const id = storeMemory({
    content: `over-quota anchor attempt [test-marker-overquota-${stamp}]`,
    memoryType: 'short_term',
    isAnchor: true,
  }, { out })
  testIds.push(id)
  const row = dbRead.prepare('SELECT is_anchor FROM memories WHERE rowid = ?').get(id)
  const ok = row.is_anchor === 0
    && Array.isArray(out.quotaRejected)
    && out.quotaRejected.length === 1
    && out.quotaRejected[0].flag === 'is_anchor'
    && out.quotaRejected[0].current >= 40
    && out.quotaRejected[0].limit === 40
  if (ok) pass++; else fail++
  console.log(`${ok?'✓':'✗'} case4 anchor-quota-reject: id=${id} is_anchor=${row.is_anchor} quotaRejected=${JSON.stringify(out.quotaRejected)}`)

  // Rollback the temp flags
  for (const r of rowsToFlag) unflagStmt.run(r.rowid)
  const rolled = dbRead.prepare('SELECT COUNT(*) as c FROM memories WHERE is_anchor = 1 AND deleted_at IS NULL').get().c
  console.log(`  rolled back to anchor=${rolled} (baseline ${baseAnchor})`)
} finally {
  dbWrite.close()
}

// Cleanup: soft-delete test-marker rows (UPDATE deleted_at does not trigger FTS reindex trigger)
const dbClean = new Database('./engram.db')
try {
  const now = Date.now()
  const cleanup = dbClean.prepare(`UPDATE memories SET deleted_at = ? WHERE content LIKE '%[test-marker-%' AND deleted_at IS NULL`).run(now)
  console.log(`\nfinal cleanup: soft-deleted ${cleanup.changes} test rows`)
} finally {
  dbClean.close()
}

const anchorAfter = dbRead.prepare('SELECT COUNT(*) as c FROM memories WHERE is_anchor = 1 AND deleted_at IS NULL').get().c
const pinnedAfter = dbRead.prepare('SELECT COUNT(*) as c FROM memories WHERE is_pinned = 1 AND deleted_at IS NULL').get().c
console.log(`after cleanup: anchor=${anchorAfter} pinned=${pinnedAfter} (should match baseline ${baseAnchor}/${basePinned})`)

dbRead.close()
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
