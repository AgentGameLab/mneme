#!/usr/bin/env node
// ============================================================
// memory-health.mjs — read-only health check for a mneme database
// ============================================================
// The "signal source" for a nightly consolidation loop: five scans that
// surface — but never mutate — the candidates a curator (human or LLM
// agent) should look at next. Only `SELECT` queries run; the DB is opened
// in physical readonly mode so nothing about the health check leaks into
// decay / recall signals (access_count / last_accessed are untouched).
//
// Five scans:
//   (a) inflation    — memory_level + importance distribution & their pcts
//                      (surfaces the "everything is meta / everything is
//                      important" failure mode); B5-style rule violations.
//   (b) dead_concrete — concrete_trace rows with access_count=0 or a very
//                      low decay_score — the cheapest thing to prune.
//   (c) integrity    — supersede chain sanity (dangling pointers, old rows
//                      that kept superseded_by but forgot to soft-delete)
//                      + dead-knowledge count (long_term/permanent rows
//                      that haven't been accessed in DEAD_KNOWLEDGE_DAYS).
//   (d) blindspot    — recall_log analytics: zero-hit rates + repeated
//                      queries. Gracefully skipped when the recall_log
//                      table is empty or does not exist.
//   (e) near_dup     — per-category vector cosine over content_vector,
//                      pre-normalized, with a wall-clock budget so a huge
//                      bucket downgrades to uniform sampling. Requires the
//                      sqlite-vec column to be populated; otherwise skips.
//
// CLI usage
//   node memory-health.mjs                   # text report (default)
//   node memory-health.mjs --format json     # machine-readable
//   node memory-health.mjs --days 14         # recall_log window (default 7)
//   node memory-health.mjs --dump-sim-hist   # per-category cosine bands
//   node memory-health.mjs --budget-ms 90000 # near-dup wall-clock budget
//   node memory-health.mjs --sim-dup 0.97    # near-dup floor (default 0.97)
//
// Module API — the detect* functions accept a better-sqlite3 handle so
// you can compose them from your own tooling without spawning a child.
// ============================================================

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Defaults (probe-calibrated on a real DB, override with flags) ──
export const DEFAULTS = Object.freeze({
  // Cosine floor at which a pair becomes a "true duplicate" supersede candidate.
  // Bands from 0.90-0.96 were dominated by "same rule iterated" / "request-response
  // pair" false positives on a real DB — 0.97 was where the FP rate collapsed.
  simDup: 0.97,
  // Cosine floor below which we don't even record a pair. 0.95..0.97 is the
  // "near-duplicate, review manually" band; below 0.95 is signal-less noise.
  simFloor: 0.95,
  // Cosine histogram bucket edges (for the optional --dump-sim-hist calibration output).
  simBands: [0.85, 0.88, 0.90, 0.93, 0.95, 0.97, 0.99],
  // A concrete_trace row is "dead" if its access_count is 0 OR its decay_score is
  // below this floor. The decay half-life is set by runDecayCycle in index.mjs.
  staleDecay: 0.5,
  // A long_term / permanent row is "dead knowledge" if untouched for this many days.
  deadKnowledgeDays: 30,
  // recall_log analytics window in days.
  recallLogDays: 7,
  // Minimum frequency at which a repeat query surfaces as a "you keep looking
  // this up — maybe store the answer" candidate.
  repeatQueryMin: 3,
  // Wall-clock budget for the O(n^2)-per-category near-dup scan. Buckets
  // whose full pair count would blow past MAX_PAIRS_PER_BUCKET are downgraded
  // to uniform sampling; buckets that would blow past the wall-clock budget
  // cut off early and record a warning.
  budgetMs: 90000,
  maxPairsPerBucket: 4_000_000,
})

// ── SQL fragment: "active" excludes soft-deleted AND superseded rows ──
const ACTIVE_CLAUSE = `deleted_at IS NULL AND superseded_by IS NULL`

// ── Small text helpers ──
const clip = (s, n = 70) => (s || '').replace(/\s+/g, ' ').slice(0, n)

/**
 * "Noise" queries that should not surface in blindspot repeat-query lists —
 * ids, URLs, file paths, single-word acknowledgements ("ok", "thanks"),
 * shell command fragments, XML-shaped system injects, and so on.
 */
export function isNoiseQuery(q) {
  if (!q) return true
  const s = q.trim()
  if (s.length < 2) return true
  if (/^id:\s*\d+$/i.test(s)) return true
  if (/^https?:\/\//i.test(s)) return true
  if (/^[A-Za-z]:[\\/]/.test(s) || /\.(mjs|js|md|json|sql|db|sh)\b/i.test(s)) return true
  if (/^[<\[]/.test(s)) return true
  if (/^(\.\/|\.\.|cd |node |bash |curl |git )/.test(s)) return true
  // A short list of EN + ZH "conversational filler" openers. Extend to taste.
  if (/^(ok|okay|thanks|thx|sure|fine|got it|good|nice|cool|yes|no|nope|嗯+|哦+|好的|收到|好呢|真棒|哦哦|okie)[!！。.~]*$/i.test(s)) return true
  return false
}

// ── Vector helpers (pre-normalized cosine = dot product) ──
function parseVec(json) {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : null } catch { return null }
}
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

// ============================================================
// Scan (a): inflation — memory_level / importance / category distributions
// ============================================================
export function detectInflation(db) {
  const total = db.prepare(`SELECT COUNT(*) c FROM memories WHERE ${ACTIVE_CLAUSE}`).get().c
  const byLevel = db.prepare(`SELECT memory_level lvl, COUNT(*) c FROM memories WHERE ${ACTIVE_CLAUSE} GROUP BY memory_level`).all()
  const byImp = db.prepare(`SELECT importance imp, COUNT(*) c FROM memories WHERE ${ACTIVE_CLAUSE} GROUP BY importance ORDER BY importance DESC`).all()
  const byCat = db.prepare(`SELECT category cat, COUNT(*) c FROM memories WHERE ${ACTIVE_CLAUSE} GROUP BY category ORDER BY c DESC`).all()
  const pct = (c) => total ? +(c / total * 100).toFixed(1) : 0
  const metaC = byLevel.find(r => r.lvl === 'meta_knowledge')?.c || 0
  const impGe7 = byImp.filter(r => r.imp >= 7).reduce((s, r) => s + r.c, 0)
  const impGe9 = byImp.filter(r => r.imp >= 9).reduce((s, r) => s + r.c, 0)
  // "B5" surface: rows that violate simple write-side rules and are cheap to fix.
  const concreteViol = db.prepare(
    `SELECT COUNT(*) c FROM memories WHERE ${ACTIVE_CLAUSE} AND memory_level='concrete_trace' AND importance>5`
  ).get().c
  const metaNoAccess = db.prepare(
    `SELECT COUNT(*) c FROM memories WHERE ${ACTIVE_CLAUSE} AND memory_level='meta_knowledge' AND access_count=0`
  ).get().c
  return {
    total,
    level: byLevel.map(r => ({ ...r, pct: pct(r.c) })),
    importance: byImp.map(r => ({ ...r, pct: pct(r.c) })),
    category: byCat.map(r => ({ ...r, pct: pct(r.c) })),
    meta_pct: pct(metaC),
    imp_ge7_pct: pct(impGe7),
    imp_ge9_pct: pct(impGe9),
    concrete_importance_violations: concreteViol,
    meta_zero_access_downgrade_candidates: metaNoAccess,
  }
}

// ============================================================
// Scan (b): dead concrete_trace — cheap-to-prune / cheap-to-forget
// ============================================================
export function detectDeadConcrete(db, opts = {}) {
  const staleDecay = opts.staleDecay ?? DEFAULTS.staleDecay
  const rows = db.prepare(`
    SELECT rowid, id, summary, importance, access_count, decay_score, last_accessed
    FROM memories
    WHERE ${ACTIVE_CLAUSE} AND memory_level='concrete_trace'
      AND (access_count = 0 OR decay_score < ?)
    ORDER BY decay_score ASC, access_count ASC
  `).all(staleDecay)
  return rows.map(r => ({
    rowid: r.rowid, id: r.id, importance: r.importance,
    access_count: r.access_count, decay_score: +((r.decay_score ?? 0).toFixed(3)),
    summary: clip(r.summary, 80),
  }))
}

// ============================================================
// Scan (c): integrity — supersede chain + dead-knowledge count
// ============================================================
export function detectIntegrity(db, opts = {}) {
  const deadKnowledgeDays = opts.deadKnowledgeDays ?? DEFAULTS.deadKnowledgeDays
  const supRows = db.prepare(`SELECT rowid, superseded_by FROM memories WHERE superseded_by IS NOT NULL`).all()
  let orphan = 0, leakedActive = 0
  for (const r of supRows) {
    // superseded_by holds the SUCCESSOR ROWID (not id). See migrations/001.
    const target = db.prepare(`SELECT rowid, deleted_at FROM memories WHERE rowid = ?`).get(r.superseded_by)
    if (!target) orphan++
    // A row that carries superseded_by should also be soft-deleted.
    const self = db.prepare(`SELECT deleted_at FROM memories WHERE rowid = ?`).get(r.rowid)
    if (self && self.deleted_at === null) leakedActive++
  }
  const deadKnowledge = db.prepare(`
    SELECT COUNT(*) c FROM memories
    WHERE ${ACTIVE_CLAUSE} AND memory_type IN ('long_term','permanent') AND last_accessed < ?
  `).get(Date.now() - deadKnowledgeDays * 86400_000).c
  return {
    supersede_rows: supRows.length,
    orphan_targets: orphan,          // expect 0
    leaked_active: leakedActive,     // expect 0
    dead_knowledge_days: deadKnowledgeDays,
    dead_knowledge_count: deadKnowledge,
  }
}

// ============================================================
// Scan (d): blindspot — recall_log analytics (gracefully skipped)
// ============================================================
export function detectBlindspot(db, opts = {}) {
  const days = opts.recallLogDays ?? DEFAULTS.recallLogDays
  const minFreq = opts.repeatQueryMin ?? DEFAULTS.repeatQueryMin
  const since = Date.now() - days * 86400_000
  // Not every mneme deployment writes to recall_log — it's optional
  // instrumentation. Skip cleanly if the table is missing or empty.
  let hasRecallLog = true
  try { db.prepare(`SELECT 1 FROM recall_log LIMIT 1`).get() } catch { hasRecallLog = false }
  if (!hasRecallLog) return { available: false, reason: 'recall_log table not present' }
  const total = db.prepare(`SELECT COUNT(*) c FROM recall_log WHERE ts > ?`).get(since).c
  if (total === 0) return { available: false, reason: `no recall_log rows in the last ${days} days` }
  const bySource = db.prepare(`SELECT source, COUNT(*) c FROM recall_log WHERE ts > ? GROUP BY source ORDER BY c DESC`).all(since)
  const strictZero = db.prepare(`SELECT COUNT(*) c FROM recall_log WHERE ts > ? AND hit_count = 0`).get(since).c
  const finalZero = db.prepare(`SELECT COUNT(*) c FROM recall_log WHERE ts > ? AND final_hit_count = 0`).get(since).c
  const repeats = db.prepare(`
    SELECT query, COUNT(*) freq, SUM(hit_count) hits
    FROM recall_log WHERE ts > ? AND query IS NOT NULL AND length(query) > 0
    GROUP BY query HAVING freq >= ? ORDER BY freq DESC LIMIT 30
  `).all(since, minFreq).filter(r => !isNoiseQuery(r.query))
  const zeroQueries = db.prepare(`
    SELECT DISTINCT query FROM recall_log
    WHERE ts > ? AND (hit_count = 0 OR final_hit_count = 0) AND query IS NOT NULL AND length(query) > 0
    LIMIT 50
  `).all(since).map(r => r.query).filter(q => !isNoiseQuery(q)).slice(0, 15)
  return {
    available: true, window_days: days, total_calls: total,
    by_source: bySource, strict_zero: strictZero, final_zero: finalZero,
    repeat_queries: repeats.slice(0, 15).map(r => ({ q: clip(r.query, 60), freq: r.freq, hits: r.hits })),
    zero_hit_real_queries: zeroQueries,
  }
}

// ============================================================
// Scan (e): near-dup — per-category cosine, budgeted
// ============================================================
export function detectNearDup(db, opts = {}) {
  const simDup = opts.simDup ?? DEFAULTS.simDup
  const simFloor = opts.simFloor ?? DEFAULTS.simFloor
  const simBands = opts.simBands ?? DEFAULTS.simBands
  const budgetMs = opts.budgetMs ?? DEFAULTS.budgetMs
  const maxPairs = opts.maxPairsPerBucket ?? DEFAULTS.maxPairsPerBucket
  const dumpHist = !!opts.dumpHist
  const warnings = []
  const t0 = Date.now()
  const overBudget = () => Date.now() - t0 > budgetMs

  const rows = db.prepare(`
    SELECT rowid, id, category, importance, summary, content_vector
    FROM memories
    WHERE ${ACTIVE_CLAUSE} AND content_vector IS NOT NULL AND content_vector != ''
  `).all()

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

  const candidates = []
  const hist = {}
  let scannedPairs = 0
  const bucketsSampled = []

  for (const [cat, items] of buckets) {
    const n = items.length
    if (n < 2) continue
    const fullPairs = n * (n - 1) / 2
    let step = 1
    if (fullPairs > maxPairs) {
      // Even sampling — sqrt keeps the sampled count near maxPairs regardless of n.
      step = Math.ceil(Math.sqrt(fullPairs / maxPairs))
      bucketsSampled.push(`${cat}(n=${n},step=${step})`)
    }
    const bandCount = simBands.map(() => 0)
    const bandSamples = simBands.map(() => [])
    outer:
    for (let i = 0; i < n; i += step) {
      if (overBudget()) {
        warnings.push(`near-dup budget ${budgetMs}ms exhausted; cut off in category=${cat} after ${scannedPairs} pairs`)
        break outer
      }
      for (let j = i + 1; j < n; j += step) {
        const c = dot(items[i].nv, items[j].nv)
        scannedPairs++
        for (let b = simBands.length - 1; b >= 0; b--) {
          if (c >= simBands[b]) {
            bandCount[b]++
            if (bandSamples[b].length < 3) bandSamples[b].push([items[i], items[j], c])
            break
          }
        }
        if (c >= simFloor) {
          candidates.push({
            cat, cosine: +c.toFixed(4),
            a: { rowid: items[i].rowid, id: items[i].id, imp: items[i].importance, summary: clip(items[i].summary, 60) },
            b: { rowid: items[j].rowid, id: items[j].id, imp: items[j].importance, summary: clip(items[j].summary, 60) },
            is_dup: c >= simDup,
          })
        }
      }
    }
    if (dumpHist) {
      hist[cat] = simBands.map((band, b) => ({
        band, count: bandCount[b],
        samples: bandSamples[b].map(([x, y, c]) => ({
          cos: +c.toFixed(4), a: clip(x.summary, 40), b: clip(y.summary, 40),
        })),
      }))
    }
  }
  candidates.sort((x, y) => y.cosine - x.cosine)

  return {
    rows_with_vector: rows.length - noVec, no_vector: noVec,
    scanned_pairs: scannedPairs, buckets_sampled: bucketsSampled,
    dup_candidates: candidates.filter(c => c.is_dup),
    near_candidates: candidates.filter(c => !c.is_dup),
    warnings,
    ...(dumpHist ? { histogram: hist } : {}),
  }
}

// ============================================================
// Orchestrator — opens the DB (readonly) and runs all five scans
// ============================================================
export function runMemoryHealth(opts = {}) {
  const dbPath = opts.dbPath || defaultDbPath()
  const Database = require('better-sqlite3')
  const db = new Database(dbPath, { readonly: true })   // physical readonly guarantee
  try {
    const t0 = Date.now()
    const report = {
      generated_at: new Date(t0).toISOString(),
      db: dbPath,
      thresholds: {
        sim_dup: opts.simDup ?? DEFAULTS.simDup,
        sim_floor: opts.simFloor ?? DEFAULTS.simFloor,
        stale_decay: opts.staleDecay ?? DEFAULTS.staleDecay,
        recall_window_days: opts.recallLogDays ?? DEFAULTS.recallLogDays,
        budget_ms: opts.budgetMs ?? DEFAULTS.budgetMs,
      },
      inflation: detectInflation(db),
      dead_concrete: detectDeadConcrete(db, opts),
      integrity: detectIntegrity(db, opts),
      blindspot: detectBlindspot(db, opts),
      near_dup: detectNearDup(db, opts),
      elapsed_ms: 0,
      warnings: [],
    }
    report.warnings.push(...(report.near_dup.warnings || []))
    delete report.near_dup.warnings
    report.elapsed_ms = Date.now() - t0
    return report
  } finally {
    db.close()
  }
}

function defaultDbPath() {
  return process.env.TOKENMEM_DB_PATH
    || (existsSync(resolve(__dirname, 'engram.db'))
          ? resolve(__dirname, 'engram.db')
          : resolve(__dirname, 'tokenmem.db'))
}

// ============================================================
// Text render — human-readable report from the JSON return
// ============================================================
export function renderTextReport(report, opts = {}) {
  const simDup = report.thresholds.sim_dup
  const simFloor = report.thresholds.sim_floor
  const staleDecay = report.thresholds.stale_decay
  const inf = report.inflation, nd = report.near_dup, bs = report.blindspot, ig = report.integrity
  const L = []
  L.push(`\n# mneme memory-health report  (${report.generated_at}, ${report.elapsed_ms}ms)`)
  L.push(`DB: ${report.db}  ·  active=${inf.total}\n`)

  L.push(`## TL;DR`)
  L.push(`- true-dup candidates (cos>=${simDup}): ${nd.dup_candidates.length} pair(s)  ·  near-dup for review (>=${simFloor}): ${nd.near_candidates.length}`)
  L.push(`- dead concrete_trace: ${report.dead_concrete.length}`)
  L.push(`- inflation: meta ${inf.meta_pct}% / imp>=7 ${inf.imp_ge7_pct}% / imp>=9 ${inf.imp_ge9_pct}%  ·  concrete imp>5 violations ${inf.concrete_importance_violations}  ·  meta zero-access downgrade candidates ${inf.meta_zero_access_downgrade_candidates}`)
  L.push(`- supersede chain: ${ig.orphan_targets} orphan / ${ig.leaked_active} leaked-active (both should be 0)  ·  dead_knowledge(${ig.dead_knowledge_days}d): ${ig.dead_knowledge_count}`)
  if (bs.available) {
    L.push(`- recall_log(${bs.window_days}d): ${bs.total_calls} calls  ·  strict-zero ${bs.strict_zero} / RRF-zero ${bs.final_zero}  ·  repeat queries (non-noise) ${bs.repeat_queries.length}`)
  } else {
    L.push(`- recall_log: not available (${bs.reason || 'unknown'})`)
  }
  if (report.warnings.length) L.push(`- WARN: ${report.warnings.join(' | ')}`)

  L.push(`\n## (a) true-dup candidates — supersede-worthy (review each pair)`)
  if (!nd.dup_candidates.length) L.push(`  (none)`)
  for (const c of nd.dup_candidates) {
    L.push(`  cos=${c.cosine} [${c.cat}] #${c.a.rowid}(imp=${c.a.imp}) <-> #${c.b.rowid}(imp=${c.b.imp})`)
    L.push(`     A: ${c.a.summary}`)
    L.push(`     B: ${c.b.summary}`)
  }
  if (nd.near_candidates.length) {
    L.push(`\n  near-duplicates (${simFloor}<=cos<${simDup}, usually related-but-distinct):`)
    for (const c of nd.near_candidates.slice(0, 10)) L.push(`  cos=${c.cosine} [${c.cat}] #${c.a.rowid} <-> #${c.b.rowid}`)
  }

  L.push(`\n## (b) inflation & level<->importance audit`)
  L.push(`  level: ${inf.level.map(r => `${r.lvl}=${r.c}(${r.pct}%)`).join(' / ')}`)
  L.push(`  importance: ${inf.importance.map(r => `${r.imp}=${r.c}`).join(' ')}`)
  L.push(`  -> concrete importance>5 violations: ${inf.concrete_importance_violations} (rule: concrete_trace stays <=5)`)
  L.push(`  -> meta with access_count=0 (downgrade candidates): ${inf.meta_zero_access_downgrade_candidates}`)

  L.push(`\n## (c) dead concrete_trace (${report.dead_concrete.length}, decay<${staleDecay} or access=0)`)
  for (const r of report.dead_concrete.slice(0, 15)) L.push(`  #${r.rowid} imp=${r.importance} acc=${r.access_count} decay=${r.decay_score} | ${r.summary}`)
  if (report.dead_concrete.length > 15) L.push(`  ... and ${report.dead_concrete.length - 15} more (use --format json for the full list)`)

  if (bs.available) {
    L.push(`\n## (d) recall_log blindspots (${bs.window_days}d)`)
    L.push(`  source: ${bs.by_source.map(s => `${s.source}=${s.c}`).join(' / ')}`)
    L.push(`  strict zero-hit: ${bs.strict_zero}  ·  RRF zero: ${bs.final_zero}`)
    if (bs.zero_hit_real_queries.length) {
      L.push(`  real zero-hit queries (noise filtered): ${bs.zero_hit_real_queries.map(q => `"${clip(q, 30)}"`).join(', ')}`)
    }
    if (bs.repeat_queries.length) {
      L.push(`  repeat queries (freq>=${DEFAULTS.repeatQueryMin}, sediment-worthy):`)
      for (const r of bs.repeat_queries) L.push(`    freq=${r.freq} "${r.q}"`)
    }
  }

  if (opts.dumpHist && nd.histogram) {
    L.push(`\n## cosine histogram (--dump-sim-hist, threshold calibration)`)
    for (const [cat, bands] of Object.entries(nd.histogram)) {
      const nz = bands.filter(b => b.count > 0)
      if (!nz.length) continue
      L.push(`  [${cat}] ${nz.map(b => `>=${b.band}:${b.count}`).join(' ')}`)
      for (const b of nz) for (const s of b.samples) L.push(`     >=${b.band} cos=${s.cos}: "${s.a}" ~ "${s.b}"`)
    }
  }
  L.push(`\n(scanned ${nd.scanned_pairs} pair(s)${nd.buckets_sampled.length ? '; sampled buckets: ' + nd.buckets_sampled.join(', ') : ''})`)
  return L.join('\n') + '\n'
}

// ============================================================
// Direct-execution entry point
// ============================================================
function parseArgs(argv) {
  const getFlag = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d }
  const hasFlag = (f) => argv.includes(f)
  const parsePosInt = (name, s, d) => {
    if (s === undefined) return d
    const n = parseInt(s, 10)
    if (!Number.isFinite(n) || n <= 0) {
      process.stderr.write(`warning: invalid ${name}=${JSON.stringify(s)}, using default ${d}\n`)
      return d
    }
    return n
  }
  const parseFloatArg = (name, s, d) => {
    if (s === undefined) return d
    const n = parseFloat(s)
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      process.stderr.write(`warning: invalid ${name}=${JSON.stringify(s)}, using default ${d}\n`)
      return d
    }
    return n
  }
  return {
    format: getFlag('--format', 'text'),
    dbPath: getFlag('--db', undefined),
    recallLogDays: parsePosInt('--days', getFlag('--days'), DEFAULTS.recallLogDays),
    budgetMs: parsePosInt('--budget-ms', getFlag('--budget-ms'), DEFAULTS.budgetMs),
    simDup: parseFloatArg('--sim-dup', getFlag('--sim-dup'), DEFAULTS.simDup),
    dumpHist: hasFlag('--dump-sim-hist'),
    help: hasFlag('--help') || hasFlag('-h'),
  }
}

const HELP = `Usage: node memory-health.mjs [flags]

Flags:
  --format text|json      Output format (default: text)
  --db PATH               Override DB path (default: env TOKENMEM_DB_PATH,
                          then engram.db, then tokenmem.db)
  --days N                recall_log analytics window (default: ${DEFAULTS.recallLogDays})
  --budget-ms N           Wall-clock budget for the near-dup scan (default: ${DEFAULTS.budgetMs})
  --sim-dup F             Cosine floor for "true duplicate" (default: ${DEFAULTS.simDup})
  --dump-sim-hist         Emit per-category cosine histogram (for calibration)
  --help, -h              Show this help
`

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  const report = runMemoryHealth(opts)
  if (opts.format === 'json') {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    process.stdout.write(renderTextReport(report, opts))
  }
}
