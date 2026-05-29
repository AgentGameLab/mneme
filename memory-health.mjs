#!/usr/bin/env node
// ============================================================
// memory-health.mjs — engram 只读体检报告
// [CHINATSU-PRIVATE · 社区版剥离] 依赖 recall_log 表(私有功能)，不进 origin/main 社区版。
// ------------------------------------------------------------
// autosleep 记忆整理步骤的「系统信号源」：取代肉眼扫近 7 天 + 主观判断。
// 一次进程跑完五类扫描，输出排好序的候选清单；agent 拿它做合并/升华/降级决策。
// 脚本只 surface + 排序 + 给依据，**绝不写库**（new Database readonly 物理保证，
// 连 access_count / last_accessed 都不 bump → 不污染 decay 信号）。
//
// 用法：
//   node memory-health.mjs                      # text 报告（默认）
//   node memory-health.mjs --format json        # 结构化输出
//   node memory-health.mjs --days 14            # recall_log 窗口（默认 7）
//   node memory-health.mjs --dump-sim-hist      # 输出各 category 的 cosine 分布直方（阈值校准用）
//   node memory-health.mjs --budget-ms 120000   # near-dup 扫描墙钟预算（默认 90s）
//
// 阈值（2026-05-29 probe 真实数据校准）：
//   SIM_DUP=0.97 主线 / 0.95 下限 / 禁用 0.90（0.90-0.95 全是规则迭代/请求-回包配对假阳）
//   active = deleted_at IS NULL AND superseded_by IS NULL
//   superseded_by 存的是【替换者 rowid】不是 id → 链校验必按 rowid join
// ============================================================

import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

// ── self-load ../.env.local（CRLF 兼容，与 mcp-server.mjs 一致；cron 子进程也要有 env）──
const envPath = resolve(__dirname, '..', '.env.local')
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*?)\r?$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
  })
}

// ── flags ──
const args = process.argv.slice(2)
const getFlag = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d }
const hasFlag = (f) => args.includes(f)
const FORMAT = getFlag('--format', 'text')
const DAYS = parseInt(getFlag('--days', '7'), 10)
const DUMP_HIST = hasFlag('--dump-sim-hist')
const BUDGET_MS = parseInt(getFlag('--budget-ms', '90000'), 10)

// ── thresholds (probe-calibrated 2026-05-29) ──
const SIM_DUP = parseFloat(getFlag('--sim-dup', '0.97'))      // 真重复主线
const SIM_FLOOR = 0.95                                        // 候选下限（低于此不列 dedup 候选）
const SIM_BANDS = [0.85, 0.88, 0.90, 0.93, 0.95, 0.97, 0.99]
const MAX_PAIRS_PER_BUCKET = 4_000_000                        // decision 2169≈2.35M 实测可跑；超此降级抽样
const STALE_DECAY = 0.5                                       // dead concrete: decay < 此 或 access=0
const DEAD_KNOWLEDGE_DAYS = 30
const REPEAT_QUERY_MIN = 3                                    // recall_log 高频重复 query 门

const DB_PATH = process.env.TOKENMEM_DB_PATH
  || (existsSync(resolve(__dirname, 'engram.db')) ? resolve(__dirname, 'engram.db') : resolve(__dirname, 'tokenmem.db'))

const Database = require('better-sqlite3')
const db = new Database(DB_PATH, { readonly: true })   // 物理只读

const t0 = Date.now()
const elapsed = () => Date.now() - t0
const overBudget = () => elapsed() > BUDGET_MS

const ACTIVE = `deleted_at IS NULL AND superseded_by IS NULL`
const warnings = []

// ── helpers ──
function parseVec(json) {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : null } catch { return null }
}
// 预归一化 → 之后 cosine = 点积，热循环省开方
function normalize(v) {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  n = Math.sqrt(n)
  if (n === 0) return null
  const out = new Float64Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}
function dot(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
const clip = (s, n = 70) => (s || '').replace(/\s+/g, ' ').slice(0, n)
// recall_log noise query 过滤（语气词 / 纯 id / url / 文件路径）
function isNoiseQuery(q) {
  if (!q) return true
  const s = q.trim()
  if (s.length < 2) return true
  if (/^id:\s*\d+$/i.test(s)) return true
  if (/^https?:\/\//i.test(s)) return true
  if (/^[A-Za-z]:[\\/]/.test(s) || /\.(mjs|js|md|json|sql|db|sh)\b/i.test(s)) return true
  if (/^[<\[]/.test(s)) return true                          // 系统注入：<task-notification>、<command-...>、[...]
  if (/^(\.\/|\.\.|cd |node |bash |curl |git )/.test(s)) return true  // shell 命令片段
  if (/^(等呗|好呢|哦哦|滴滴|真棒|嗯+|哦+|好的|收到|怎么样了|ok|okay)[!！。.~]*$/i.test(s)) return true
  return false
}

// ============================================================
// (c) inflation — 分布监控（只报不产候选；B5 level/importance 审计的数据底座）
// ============================================================
function detectInflation() {
  const total = db.prepare(`SELECT COUNT(*) c FROM memories WHERE ${ACTIVE}`).get().c
  const byLevel = db.prepare(`SELECT memory_level lvl, COUNT(*) c FROM memories WHERE ${ACTIVE} GROUP BY memory_level`).all()
  const byImp = db.prepare(`SELECT importance imp, COUNT(*) c FROM memories WHERE ${ACTIVE} GROUP BY importance ORDER BY importance DESC`).all()
  const byCat = db.prepare(`SELECT category cat, COUNT(*) c FROM memories WHERE ${ACTIVE} GROUP BY category ORDER BY c DESC`).all()
  const pct = (c) => total ? +(c / total * 100).toFixed(1) : 0
  const metaC = byLevel.find(r => r.lvl === 'meta_knowledge')?.c || 0
  const impGe7 = byImp.filter(r => r.imp >= 7).reduce((s, r) => s + r.c, 0)
  // B5 candidates (只报)：concrete importance>5 违规 / meta access_count=0 降级候选
  const concreteViol = db.prepare(
    `SELECT COUNT(*) c FROM memories WHERE ${ACTIVE} AND memory_level='concrete_trace' AND importance>5`
  ).get().c
  const metaNoAccess = db.prepare(
    `SELECT COUNT(*) c FROM memories WHERE ${ACTIVE} AND memory_level='meta_knowledge' AND access_count=0`
  ).get().c
  return {
    total,
    level: byLevel.map(r => ({ ...r, pct: pct(r.c) })),
    importance: byImp.map(r => ({ ...r, pct: pct(r.c) })),
    category: byCat.map(r => ({ ...r, pct: pct(r.c) })),
    meta_pct: pct(metaC),
    imp_ge7_pct: pct(impGe7),
    concrete_importance_violations: concreteViol,
    meta_zero_access_downgrade_candidates: metaNoAccess,
  }
}

// ============================================================
// (b) dead concrete_trace — access_count=0 OR decay<0.5 的 concrete
// ============================================================
function detectDeadConcrete() {
  const rows = db.prepare(`
    SELECT rowid, id, summary, importance, access_count, decay_score, last_accessed
    FROM memories
    WHERE ${ACTIVE} AND memory_level='concrete_trace'
      AND (access_count = 0 OR decay_score < ?)
    ORDER BY decay_score ASC, access_count ASC
  `).all(STALE_DECAY)
  return rows.map(r => ({
    rowid: r.rowid, id: r.id, importance: r.importance,
    access_count: r.access_count, decay_score: +((r.decay_score ?? 0).toFixed(3)),
    summary: clip(r.summary, 80),
  }))
}

// ============================================================
// (e) integrity — supersede 链(按 rowid) + dead_knowledge
// ============================================================
function detectIntegrity() {
  const supRows = db.prepare(`SELECT rowid, superseded_by FROM memories WHERE superseded_by IS NOT NULL`).all()
  let orphan = 0, leakedActive = 0
  for (const r of supRows) {
    const target = db.prepare(`SELECT rowid, deleted_at FROM memories WHERE rowid = ?`).get(r.superseded_by)
    if (!target) orphan++
    // 持有 superseded_by 的旧行自身应已软删
    const self = db.prepare(`SELECT deleted_at FROM memories WHERE rowid = ?`).get(r.rowid)
    if (self && self.deleted_at === null) leakedActive++
  }
  const deadKnowledge = db.prepare(`
    SELECT COUNT(*) c FROM memories
    WHERE ${ACTIVE} AND memory_type IN ('long_term','permanent') AND last_accessed < ?
  `).get(Date.now() - DEAD_KNOWLEDGE_DAYS * 86400_000).c
  return {
    supersede_rows: supRows.length,
    orphan_targets: orphan,           // 应为 0
    leaked_active: leakedActive,      // 应为 0（持 superseded_by 但没软删）
    dead_knowledge_30d: deadKnowledge,
  }
}

// ============================================================
// (d) blindspot — recall_log zero-hit + 高频重复 query
// ============================================================
function detectBlindspot() {
  const since = Date.now() - DAYS * 86400_000
  let hasRecallLog = true
  try { db.prepare(`SELECT 1 FROM recall_log LIMIT 1`).get() } catch { hasRecallLog = false }
  if (!hasRecallLog) return { available: false }
  const total = db.prepare(`SELECT COUNT(*) c FROM recall_log WHERE ts > ?`).get(since).c
  const bySource = db.prepare(`SELECT source, COUNT(*) c FROM recall_log WHERE ts > ? GROUP BY source ORDER BY c DESC`).all(since)
  // zero-hit：hit_count=0（严格）+ final_hit_count=0（RRF 后空）
  const strictZero = db.prepare(`SELECT COUNT(*) c FROM recall_log WHERE ts > ? AND hit_count = 0`).get(since).c
  const finalZero = db.prepare(`SELECT COUNT(*) c FROM recall_log WHERE ts > ? AND final_hit_count = 0`).get(since).c
  // 高频重复 query（过滤 noise 后）
  const repeats = db.prepare(`
    SELECT query, COUNT(*) freq, SUM(hit_count) hits
    FROM recall_log WHERE ts > ? AND query IS NOT NULL AND length(query) > 0
    GROUP BY query HAVING freq >= ? ORDER BY freq DESC LIMIT 30
  `).all(since, REPEAT_QUERY_MIN).filter(r => !isNoiseQuery(r.query))
  // zero-hit 的真实 query（过滤 noise）
  const zeroQueries = db.prepare(`
    SELECT DISTINCT query FROM recall_log
    WHERE ts > ? AND (hit_count = 0 OR final_hit_count = 0) AND query IS NOT NULL AND length(query) > 0
    LIMIT 50
  `).all(since).map(r => r.query).filter(q => !isNoiseQuery(q)).slice(0, 15)
  return {
    available: true, window_days: DAYS, total_calls: total,
    by_source: bySource, strict_zero: strictZero, final_zero: finalZero,
    repeat_queries: repeats.slice(0, 15).map(r => ({ q: clip(r.query, 60), freq: r.freq, hits: r.hits })),
    zero_hit_real_queries: zeroQueries,
  }
}

// ============================================================
// (a) near-dup — per-category 向量 cosine（预归一化 + 墙钟预算守护）
// ============================================================
function detectNearDup() {
  const rows = db.prepare(`
    SELECT rowid, id, category, importance, summary, content_vector
    FROM memories
    WHERE ${ACTIVE} AND content_vector IS NOT NULL AND content_vector != ''
  `).all()
  // 按 category 分桶 + 预归一化
  const buckets = new Map()
  let noVec = 0
  for (const r of rows) {
    const v = parseVec(r.content_vector)
    if (!v) { noVec++; continue }
    const nv = normalize(v)
    if (!nv) continue
    if (!buckets.has(r.category)) buckets.set(r.category, [])
    buckets.get(r.category).push({ rowid: r.rowid, id: r.id, importance: r.importance, summary: r.summary, nv })
  }
  const candidates = []                                  // cosine >= SIM_FLOOR
  const hist = {}                                        // category -> band counts
  let scannedPairs = 0, bucketsSampled = []
  for (const [cat, items] of buckets) {
    const n = items.length
    if (n < 2) continue
    const fullPairs = n * (n - 1) / 2
    let step = 1
    if (fullPairs > MAX_PAIRS_PER_BUCKET) {             // 降级：均匀抽样
      step = Math.ceil(Math.sqrt(fullPairs / MAX_PAIRS_PER_BUCKET))
      bucketsSampled.push(`${cat}(${n}行,step=${step})`)
    }
    const bandCount = SIM_BANDS.map(() => 0)
    const bandSamples = SIM_BANDS.map(() => [])
    outer:
    for (let i = 0; i < n; i += step) {
      if (overBudget()) { warnings.push(`near-dup 墙钟预算 ${BUDGET_MS}ms 用尽，在 category=${cat} 提前停（已扫 ${scannedPairs} 对）`); break outer }
      for (let j = i + 1; j < n; j += step) {
        const c = dot(items[i].nv, items[j].nv)
        scannedPairs++
        for (let b = SIM_BANDS.length - 1; b >= 0; b--) {
          if (c >= SIM_BANDS[b]) { bandCount[b]++; if (bandSamples[b].length < 3) bandSamples[b].push([items[i], items[j], c]); break }
        }
        if (c >= SIM_FLOOR) {
          candidates.push({
            cat, cosine: +c.toFixed(4),
            a: { rowid: items[i].rowid, id: items[i].id, imp: items[i].importance, summary: clip(items[i].summary, 60) },
            b: { rowid: items[j].rowid, id: items[j].id, imp: items[j].importance, summary: clip(items[j].summary, 60) },
            is_dup: c >= SIM_DUP,
          })
        }
      }
    }
    if (DUMP_HIST) {
      hist[cat] = SIM_BANDS.map((band, b) => ({
        band, count: bandCount[b],
        samples: bandSamples[b].map(([x, y, c]) => ({ cos: +c.toFixed(4), a: clip(x.summary, 40), b: clip(y.summary, 40) })),
      }))
    }
  }
  candidates.sort((x, y) => y.cosine - x.cosine)
  return {
    rows_with_vector: rows.length - noVec, no_vector: noVec,
    scanned_pairs: scannedPairs, buckets_sampled: bucketsSampled,
    dup_candidates: candidates.filter(c => c.is_dup),        // cosine >= SIM_DUP（真重复主线）
    near_candidates: candidates.filter(c => !c.is_dup),      // SIM_FLOOR <= cosine < SIM_DUP（人工再看）
    ...(DUMP_HIST ? { histogram: hist } : {}),
  }
}

// ============================================================
// run
// ============================================================
const report = {
  generated_at: new Date(t0).toISOString(),
  db: DB_PATH,
  thresholds: { sim_dup: SIM_DUP, sim_floor: SIM_FLOOR, stale_decay: STALE_DECAY, recall_window_days: DAYS },
  inflation: detectInflation(),
  dead_concrete: detectDeadConcrete(),
  integrity: detectIntegrity(),
  blindspot: detectBlindspot(),
  near_dup: detectNearDup(),
  elapsed_ms: 0,
  warnings,
}
report.elapsed_ms = elapsed()
db.close()

// ── render ──
if (FORMAT === 'json') {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} else {
  const L = []
  const inf = report.inflation, nd = report.near_dup, bs = report.blindspot, ig = report.integrity
  L.push(`\n# engram 记忆体检报告  (${report.generated_at}, ${report.elapsed_ms}ms)`)
  L.push(`DB: ${report.db}  ·  active=${inf.total}\n`)
  // TL;DR
  L.push(`## TL;DR`)
  L.push(`- 真重复候选 (cosine≥${SIM_DUP}): ${nd.dup_candidates.length} 对  ·  近重复待看 (≥${SIM_FLOOR}): ${nd.near_candidates.length} 对`)
  L.push(`- 僵死 concrete_trace: ${report.dead_concrete.length} 条`)
  L.push(`- 通胀: meta ${inf.meta_pct}% / importance≥7 ${inf.imp_ge7_pct}%  ·  concrete importance>5 违规 ${inf.concrete_importance_violations} 条  ·  meta 零召回(降级候选) ${inf.meta_zero_access_downgrade_candidates} 条`)
  L.push(`- supersede 链: ${ig.orphan_targets} 孤儿 / ${ig.leaked_active} 泄漏(应都=0)  ·  dead_knowledge(30d): ${ig.dead_knowledge_30d}`)
  if (bs.available) L.push(`- recall_log(${bs.window_days}d): ${bs.total_calls} 次  ·  严格zero ${bs.strict_zero} / RRF后zero ${bs.final_zero}  ·  高频重复(非噪声) ${bs.repeat_queries.length}`)
  if (report.warnings.length) L.push(`- ⚠ ${report.warnings.join(' | ')}`)
  // (a) dup
  L.push(`\n## (a) 真重复候选 — supersede 候选 (人工逐条审批)`)
  if (!nd.dup_candidates.length) L.push(`  (无)`)
  for (const c of nd.dup_candidates) L.push(`  cos=${c.cosine} [${c.cat}] #${c.a.rowid}(★${c.a.imp}) ↔ #${c.b.rowid}(★${c.b.imp})\n     A: ${c.a.summary}\n     B: ${c.b.summary}`)
  if (nd.near_candidates.length) {
    L.push(`\n  近重复 (${SIM_FLOOR}≤cos<${SIM_DUP}, 多为相关非重复, 仅参考):`)
    for (const c of nd.near_candidates.slice(0, 10)) L.push(`  cos=${c.cosine} [${c.cat}] #${c.a.rowid} ↔ #${c.b.rowid}`)
  }
  // (c) inflation / B5
  L.push(`\n## (c) 通胀 & level↔importance 审计 (B5 数据底座)`)
  L.push(`  level: ${inf.level.map(r => `${r.lvl}=${r.c}(${r.pct}%)`).join(' / ')}`)
  L.push(`  importance: ${inf.importance.map(r => `${r.imp}=${r.c}`).join(' ')}`)
  L.push(`  → concrete importance>5 违规 ${inf.concrete_importance_violations} 条 (铁律: concrete 应≤5)`)
  L.push(`  → meta access_count=0 降级候选 ${inf.meta_zero_access_downgrade_candidates} 条 (考虑降 semi_abstract 缓解通胀)`)
  // (b) dead concrete
  L.push(`\n## (b) 僵死 concrete_trace (${report.dead_concrete.length} 条, decay<${STALE_DECAY} 或 access=0)`)
  for (const r of report.dead_concrete.slice(0, 15)) L.push(`  #${r.rowid} ★${r.importance} acc=${r.access_count} decay=${r.decay_score} | ${r.summary}`)
  if (report.dead_concrete.length > 15) L.push(`  ... 余 ${report.dead_concrete.length - 15} 条 (--format json 看全)`)
  // (d) blindspot
  if (bs.available) {
    L.push(`\n## (d) recall_log 盲区 (${bs.window_days}d)`)
    L.push(`  source: ${bs.by_source.map(s => `${s.source}=${s.c}`).join(' / ')}`)
    L.push(`  严格 zero-hit: ${bs.strict_zero}  ·  RRF 后 zero: ${bs.final_zero}`)
    if (bs.zero_hit_real_queries.length) L.push(`  真 zero query (过滤噪声): ${bs.zero_hit_real_queries.map(q => `"${clip(q, 30)}"`).join(', ')}`)
    if (bs.repeat_queries.length) {
      L.push(`  高频重复 query (freq≥${REPEAT_QUERY_MIN}, 该 store 沉淀):`)
      for (const r of bs.repeat_queries) L.push(`    freq=${r.freq} "${r.q}"`)
    }
  }
  // hist
  if (DUMP_HIST && nd.histogram) {
    L.push(`\n## cosine 直方 (--dump-sim-hist, 阈值校准用)`)
    for (const [cat, bands] of Object.entries(nd.histogram)) {
      const nz = bands.filter(b => b.count > 0)
      if (!nz.length) continue
      L.push(`  [${cat}] ${nz.map(b => `≥${b.band}:${b.count}`).join(' ')}`)
      for (const b of nz) for (const s of b.samples) L.push(`     ≥${b.band} cos=${s.cos}: "${s.a}" ~ "${s.b}"`)
    }
  }
  L.push(`\n(扫描 ${nd.scanned_pairs} 对${nd.buckets_sampled.length ? ', 抽样桶: ' + nd.buckets_sampled.join(',') : ''})`)
  process.stdout.write(L.join('\n') + '\n')
}
