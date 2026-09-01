// Unit test for isLikelySeries — the (a2) supersede-band filter.
//
// Fixtures are the real shapes measured out of a 9301-row library on 2026-09-01,
// where (a2) reported 125 "supersede candidates" and a hand review found that
// nearly all of them were time series, not stale rewrites. Each case below
// records what that pair actually was, so a future change to the predicate has
// to argue with the data rather than with the rule.
//
// The one TRUE positive (#49/#272) is the shape the band exists to find: one
// fact restated days later, where the older wording stays recallable as if
// current. If a change makes that case fall out, the filter has eaten its
// own purpose.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLikelySeries } from './memory-health.mjs'

const H = 3600_000
const D = 24 * H
const t = (hoursAgo) => 1756_000_000_000 - hoursAgo * H

const row = (level, hoursAgo, summary) => ({
  memory_level: level, created_at: t(hoursAgo), summary,
})

// ── series: must be filtered out of the review list ────────────────────────

test('same-session log entries minutes apart are a timeline, not a rewrite', () => {
  // #9782/#9787 — one person narrating a decision then refining it 3 min later
  const a = row('semi_abstract', 100, '小毛 20:22 决策路径: 直接开游戏录真实运行 (不装 Godot)')
  const b = row('semi_abstract', 99.9, '小毛 20:25 细化: 优先 hyperbeam native 60fps MP4')
  assert.equal(isLikelySeries(a, b), true)
})

test('a request and its reply written in the same minute are not versions of each other', () => {
  // #2640/#2641 — desktop asks, group session answers
  const a = row('semi_abstract', 200, '桌面→群聊 千夏 V4-B promote 进展 query · 5/17 03:30')
  const b = row('semi_abstract', 200, '群聊→桌面 V4-B promote query 回包: 5 答 evidence-first')
  assert.equal(isLikelySeries(a, b), true)
})

test('dated snapshots a week apart are a series even though the gap is wide', () => {
  // #6317/#5960 — nightly autosleep metrics; the leading date is the whole point
  const a = row('semi_abstract', 0, '2026-07-08 autosleep 指标快照 meta70.9% imp≥7=91%')
  const b = row('concrete_trace', 7 * 24, '2026-07-01 autosleep 指标快照 meta74.6% imp≥7=91.1%')
  assert.equal(isLikelySeries(a, b), true)
})

test('consecutive daily snapshots are a series at 23.8h apart', () => {
  // #10756/#10676 — just outside the same-session window, caught by the date literal
  const a = row('semi_abstract', 0, '2026-08-29 autosleep 快照：active9215 meta59.5%(持降)')
  const b = row('semi_abstract', 23.8, '2026-08-28 autosleep 快照：active9141 meta59.9%(持降)')
  assert.equal(isLikelySeries(a, b), true)
})

test('ordinal progression within one session is a series', () => {
  // #5586/#5588 — 切片2b-i then 2c-i; no date literal, caught by the window
  const a = row('semi_abstract', 50, 'TANDEM火控切片2b-i完成: σ(w)+ω_max(w)联动→trade-off曲线立住')
  const b = row('semi_abstract', 49.6, 'TANDEM火控切片2c-i完成: 动态w策略 > 静态最优')
  assert.equal(isLikelySeries(a, b), true)
})

test('two unrelated todos filed together are not a rewrite', () => {
  // #7940/#7941 — different subjects entirely; pure embedding false positive
  const a = row('semi_abstract', 300, '【待办·Discord session】把 Discord 各处的 Steam 链接改成带 utm_source')
  const b = row('semi_abstract', 300, '【待办·隔壁session】press kit 挂 UTM：CF Pages 部署但本地非 git 仓库')
  assert.equal(isLikelySeries(a, b), true)
})

test('the existing concrete_trace rule still holds on its own', () => {
  const a = row('concrete_trace', 0, '跑了一次同步')
  const b = row('concrete_trace', 40 * 24, '跑了一次同步')
  assert.equal(isLikelySeries(a, b), true)
})

// ── the real target: must survive the filter ───────────────────────────────

test('one fact restated days later is a genuine supersede candidate', () => {
  // #49/#272 — this is what (a2) exists to surface. 5 days apart, no temporal
  // marker in either summary, neither is a routine trace.
  const a = row('semi_abstract', 5 * 24, '千夏不爱吃香菜')
  const b = row('meta_knowledge', 0, '千夏讨厌香菜的味道')
  assert.equal(isLikelySeries(a, b), false)
})

test('a shared date literal does not make two rows a series', () => {
  // Both mention the same date — that is one event described twice, which IS
  // a rewrite. Only *differing* markers indicate a sequence.
  const a = row('semi_abstract', 5 * 24, '2026-07-01 部署失败根因是端口占用')
  const b = row('semi_abstract', 0, '2026-07-01 那次部署失败其实是端口被占')
  assert.equal(isLikelySeries(a, b), false)
})

test('missing summaries do not crash or silently classify as series', () => {
  const a = { memory_level: 'semi_abstract', created_at: t(5 * 24), summary: null }
  const b = { memory_level: 'semi_abstract', created_at: t(0), summary: undefined }
  assert.equal(isLikelySeries(a, b), false)
})

test('missing timestamps fall back to the marker rule instead of matching at zero gap', () => {
  // created_at null on both sides would read as a 0ms gap and swallow every
  // pair into "same session". Guard against that.
  const a = { memory_level: 'semi_abstract', created_at: null, summary: '千夏不爱吃香菜' }
  const b = { memory_level: 'semi_abstract', created_at: null, summary: '千夏讨厌香菜的味道' }
  assert.equal(isLikelySeries(a, b), false)
})
