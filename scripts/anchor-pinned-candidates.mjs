#!/usr/bin/env node
// ============================================================
// scripts/anchor-pinned-candidates.mjs
// ============================================================
// Migration 008 存量迁移助手：从当前库里挑候选 is_anchor / is_pinned 行。
//
// 候选策略：
//   anchor (≤40)  = memory_type='permanent' 全部 + importance=10 全部，按
//                   (access_count DESC, importance DESC) 排序取前 40
//   pinned (≤30)  = importance>=9 非 anchor 候选，按同样排序取前 30
//
// 排序依据：access_count 优先 —— "真被反复用到" 比 "自己标了 imp=10" 更可信。
// 这条借鉴 Ombre-Brain 的"元数据不喂算分" —— importance 不是硬信号，实际访问频率才是。
//
// 用法：
//   node scripts/anchor-pinned-candidates.mjs                  # dry-run，只出清单
//   node scripts/anchor-pinned-candidates.mjs --write          # 真写 is_anchor/is_pinned
//   node scripts/anchor-pinned-candidates.mjs --json out.json  # dry-run + 写候选到 JSON
// ============================================================

import Database from 'better-sqlite3'
import { writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Mirror index.mjs's DB resolution so `TOKENMEM_DB_PATH=/prod/mneme.db node ...`
// works and doesn't silently mutate the wrong DB. Order: explicit env → legacy
// engram.db beside the module → fresh-install tokenmem.db default.
const args = process.argv.slice(2)
const dbFlag = args.find(a => a.startsWith('--db='))
const DB_PATH = (
  (dbFlag && dbFlag.slice(5))
  || process.env.TOKENMEM_DB_PATH
  || (existsSync(resolve(__dirname, '..', 'engram.db'))
        ? resolve(__dirname, '..', 'engram.db')
        : resolve(__dirname, '..', 'tokenmem.db'))
)
const ANCHOR_LIMIT = 40
const PIN_LIMIT = 30

const WRITE = args.includes('--write')
const jsonArg = args.find(a => a.startsWith('--json='))
const jsonPath = jsonArg ? jsonArg.split('=')[1] : null

const db = new Database(DB_PATH, { readonly: !WRITE })

console.log(`DB: ${DB_PATH}`)
console.log(`mode: ${WRITE ? 'WRITE' : 'DRY-RUN'}`)

// Baseline
const existingAnchor = db.prepare('SELECT COUNT(*) c FROM memories WHERE is_anchor=1 AND deleted_at IS NULL').get().c
const existingPinned = db.prepare('SELECT COUNT(*) c FROM memories WHERE is_pinned=1 AND deleted_at IS NULL').get().c
console.log(`baseline: anchor=${existingAnchor}/${ANCHOR_LIMIT}  pinned=${existingPinned}/${PIN_LIMIT}`)

// Anchor candidates: permanent + importance=10, sorted by access_count DESC / importance DESC
const anchorPool = db.prepare(`
  SELECT rowid, importance, memory_type, memory_level, access_count, category,
         COALESCE(summary, substr(content, 1, 80)) as label
  FROM memories
  WHERE deleted_at IS NULL
    AND superseded_by IS NULL
    AND is_anchor = 0
    AND (memory_type = 'permanent' OR importance = 10)
  ORDER BY access_count DESC, importance DESC, rowid ASC
`).all()

const anchorSlots = Math.max(0, ANCHOR_LIMIT - existingAnchor)
const anchorPicks = anchorPool.slice(0, anchorSlots)

// Pinned candidates: importance>=9, not in anchor picks, same sort
const pickedAnchorIds = new Set(anchorPicks.map(r => r.rowid))
const pinnedPool = db.prepare(`
  SELECT rowid, importance, memory_type, memory_level, access_count, category,
         COALESCE(summary, substr(content, 1, 80)) as label
  FROM memories
  WHERE deleted_at IS NULL
    AND superseded_by IS NULL
    AND is_anchor = 0
    AND is_pinned = 0
    AND importance >= 9
  ORDER BY access_count DESC, importance DESC, rowid ASC
`).all().filter(r => !pickedAnchorIds.has(r.rowid))

const pinnedSlots = Math.max(0, PIN_LIMIT - existingPinned)
const pinnedPicks = pinnedPool.slice(0, pinnedSlots)

// Report
function fmt(r) {
  const tags = `[${r.memory_type[0]} imp=${r.importance} ac=${r.access_count}]`
  const label = r.label.replace(/\n+/g, ' ').slice(0, 80)
  return `  #${r.rowid} ${tags} ${label}`
}

console.log(`\n=== ANCHOR candidates (${anchorPicks.length}/${anchorSlots} slots) ===`)
console.log(`  pool: ${anchorPool.length} eligible (permanent OR imp=10)`)
anchorPicks.forEach(r => console.log(fmt(r)))
if (anchorPool.length > anchorPicks.length) {
  console.log(`  ... ${anchorPool.length - anchorPicks.length} more didn't make the cut (bump access_count or wait for slot).`)
}

console.log(`\n=== PINNED candidates (${pinnedPicks.length}/${pinnedSlots} slots) ===`)
console.log(`  pool: ${pinnedPool.length} eligible (imp>=9, not anchored)`)
pinnedPicks.forEach(r => console.log(fmt(r)))
if (pinnedPool.length > pinnedPicks.length) {
  console.log(`  ... ${pinnedPool.length - pinnedPicks.length} more waiting.`)
}

if (jsonPath) {
  const out = { generated_at: new Date().toISOString(), anchor_picks: anchorPicks, pinned_picks: pinnedPicks }
  writeFileSync(jsonPath, JSON.stringify(out, null, 2))
  console.log(`\ncandidates written to ${jsonPath}`)
}

if (WRITE) {
  console.log(`\n=== APPLYING (mode: --write) ===`)
  const setAnchor = db.prepare('UPDATE memories SET is_anchor = 1 WHERE rowid = ? AND deleted_at IS NULL')
  const setPinned = db.prepare('UPDATE memories SET is_pinned = 1 WHERE rowid = ? AND deleted_at IS NULL')
  const tx = db.transaction(() => {
    for (const r of anchorPicks) setAnchor.run(r.rowid)
    for (const r of pinnedPicks) setPinned.run(r.rowid)
  })
  tx()
  const anchorNow = db.prepare('SELECT COUNT(*) c FROM memories WHERE is_anchor=1 AND deleted_at IS NULL').get().c
  const pinnedNow = db.prepare('SELECT COUNT(*) c FROM memories WHERE is_pinned=1 AND deleted_at IS NULL').get().c
  console.log(`applied. anchor: ${existingAnchor} -> ${anchorNow}   pinned: ${existingPinned} -> ${pinnedNow}`)
} else {
  console.log(`\n(dry-run — no writes. rerun with --write to apply.)`)
}

db.close()
