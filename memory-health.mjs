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
import { extractHighSignalTokens, isStillCarried } from './high-signal-tokens.mjs'

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
  // Cosine floor for the supersede band (simSupersede <= cos < simFloor).
  // This band is NOT "the same thing said twice" — it is "the same subject,
  // written more than once, and the wording drifted". On a real 6k-row DB it is
  // where superseded-but-never-marked iterations live: an old design doc still
  // active next to its revision, one script's usage recorded three times.
  // A true duplicate is harmless (recall returns the same fact); an unmarked
  // stale iteration is not (recall can return the version you already replaced).
  // 0.85 was where per-category yield stayed reviewable (~75 pairs) — lower
  // floods with same-topic-different-fact pairs.
  simSupersede: 0.85,
  // (a3) shrink victims: only reference entries worth a human look. Below
  // these, a shrunk chain is usually a low-stakes note being tidied.
  shrinkMinImportance: 8,
  shrinkPeakRatio: 0.8,
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
  // this up — maybe store the answer" candidate. Frequency alone is not
  // evidence of a gap: a query can repeat because recall answers it well and
  // the topic is hot. Only repeats whose recall actually comes back thin are
  // reported — see repeatQueryMaxAvgHits.
  repeatQueryMin: 3,
  // A repeating query is a sediment gap only if it typically returns less than
  // this many rows. Measured 2026-09-01: every freq>=3 query in a 7d window
  // averaged 5-20 hits, i.e. the un-filtered signal was 100% false positive.
  repeatQueryMaxAvgHits: 1,
  // Two rows written inside this window are treated as one working session: a
  // log, a request and its reply, a decision and its refinement — not two
  // drafts of one fact. Calibrated on 10 hand-classified pairs (2026-09-01);
  // the closest true rewrite in that set sat 5 days apart, the widest
  // same-session false positive 6.8h.
  seriesSameSessionHours: 8,
  // A recall_log source must have written at least this many rows historically
  // before its silence is treated as a stall. Below it, "no rows this week" is
  // just a quiet occasional caller — one-off CLI probes and debug labels live
  // down there and would otherwise flood the report every run.
  sourceStallMinHistory: 200,
  // Days of silence from a high-volume source before it counts as stalled.
  // Deliberately shorter than a human would notice on their own.
  sourceStallDays: 3,
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

// Per-row signals a reviewer needs to judge "stale iteration vs both still true".
const sideDetail = (it, now) => ({
  rowid: it.rowid,
  imp: it.importance,
  level: (it.memory_level || '').slice(0, 4),
  type: it.memory_type,
  age_days: it.created_at ? Math.floor((now - it.created_at) / 86400_000) : null,
  acc: it.access_count ?? 0,
  protected: it.protected,
  summary: clip(it.summary, 110),
})

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
export function detectInflation(db, opts = {}) {
  // Match runLevelMigration's demotion rule (index.mjs): a meta_knowledge
  // row only becomes a downgrade candidate once it has aged past 30 days
  // with zero recalls. Counting age-agnostically inflates the number every
  // time a fresh meta gets stored, which makes the week-over-week diff the
  // recipe recommends noisy. Configurable so callers can widen the window.
  const metaDowngradeAgeDays = opts.metaDowngradeAgeDays ?? 30
  const cutoff = Date.now() - metaDowngradeAgeDays * 86400_000
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
    `SELECT COUNT(*) c FROM memories WHERE ${ACTIVE_CLAUSE} AND memory_level='meta_knowledge' AND access_count=0 AND created_at < ?`
  ).get(cutoff).c
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
    meta_downgrade_age_days: metaDowngradeAgeDays,
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
    // superseded_by holds the SUCCESSOR ROWID as a TEXT column (migrations/001).
    // SQLite coerces "42" -> 42 for INTEGER comparisons; empty string / non-numeric
    // would silently coerce to 0 and return "orphan". CAST explicitly so a bad
    // value stays NULL and lands in the orphan bucket where it's visible.
    const successor = String(r.superseded_by).trim()
    if (!/^\d+$/.test(successor)) { orphan++; continue }
    const target = db.prepare(`SELECT rowid, deleted_at FROM memories WHERE rowid = CAST(? AS INTEGER)`).get(successor)
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
  const maxAvgHits = opts.repeatQueryMaxAvgHits ?? DEFAULTS.repeatQueryMaxAvgHits
  const since = Date.now() - days * 86400_000
  // Not every mneme deployment writes to recall_log — it's optional
  // instrumentation. Skip cleanly if the table is missing.
  let hasRecallLog = true
  try { db.prepare(`SELECT 1 FROM recall_log LIMIT 1`).get() } catch { hasRecallLog = false }
  if (!hasRecallLog) return { available: false, reason: 'recall_log table not present (this build does not instrument recall)' }

  const total = db.prepare(`SELECT COUNT(*) c FROM recall_log WHERE ts > ?`).get(since).c
  if (total === 0) {
    // "Never instrumented" and "was instrumented, then went silent" are very
    // different facts, and the old message said the same bland thing for both.
    // A refactor that drops the write call leaves the table and its history
    // intact, so this scan degrades to "not available" and stays quiet — which
    // is how one real deployment lost 13 days of recall telemetry unnoticed.
    // If there is history but nothing recent, say so loudly.
    const hist = db.prepare(`SELECT COUNT(*) c, MAX(ts) last_ts FROM recall_log`).get()
    if (hist.c > 0 && hist.last_ts) {
      const silentDays = Math.floor((Date.now() - hist.last_ts) / 86400_000)
      return {
        available: false,
        instrumentation_stalled: true,
        total_rows: hist.c,
        last_write_at: new Date(hist.last_ts).toISOString(),
        silent_days: silentDays,
        reason: `recall_log STALLED — ${hist.c} historical rows but nothing for ${silentDays}d `
          + `(last write ${new Date(hist.last_ts).toISOString().slice(0, 16)}Z). `
          + `The table survived but something stopped writing to it — check whether a refactor dropped the log call.`,
      }
    }
    return { available: false, reason: `no recall_log rows in the last ${days} days` }
  }
  const bySource = db.prepare(`SELECT source, COUNT(*) c FROM recall_log WHERE ts > ? GROUP BY source ORDER BY c DESC`).all(since)
  const strictZero = db.prepare(`SELECT COUNT(*) c FROM recall_log WHERE ts > ? AND hit_count = 0`).get(since).c
  const finalZero = db.prepare(`SELECT COUNT(*) c FROM recall_log WHERE ts > ? AND final_hit_count = 0`).get(since).c
  // A repeating query is only evidence of a missing memory if recall keeps
  // coming back thin. Frequency on its own measures how hot a topic is, not
  // whether it is answered — and hot-and-answered is the normal case: hooks
  // fire recall on every prompt containing the word. Reporting those as
  // "sediment-worthy" sends you off to write a card that already exists.
  const repeatsRaw = db.prepare(`
    SELECT query, COUNT(*) freq, SUM(hit_count) hits
    FROM recall_log WHERE ts > ? AND query IS NOT NULL AND length(query) > 0
    GROUP BY query HAVING freq >= ? ORDER BY freq DESC LIMIT 30
  `).all(since, minFreq).filter(r => !isNoiseQuery(r.query))
  const avgHits = (r) => (r.freq > 0 ? (r.hits ?? 0) / r.freq : 0)
  const repeats = repeatsRaw.filter(r => avgHits(r) < maxAvgHits)
  const repeatsAnswered = repeatsRaw.length - repeats.length
  const zeroQueries = db.prepare(`
    SELECT DISTINCT query FROM recall_log
    WHERE ts > ? AND (hit_count = 0 OR final_hit_count = 0) AND query IS NOT NULL AND length(query) > 0
    LIMIT 50
  `).all(since).map(r => r.query).filter(q => !isNoiseQuery(q)).slice(0, 15)
  return {
    available: true, window_days: days, total_calls: total,
    by_source: bySource, strict_zero: strictZero, final_zero: finalZero,
    repeat_queries: repeats.slice(0, 15).map(r => ({
      q: clip(r.query, 60), freq: r.freq, hits: r.hits,
      avg_hits: +(avgHits(r)).toFixed(1),
    })),
    repeat_queries_answered: repeatsAnswered,
    zero_hit_real_queries: zeroQueries,
    stalled_sources: detectStalledSources(db, opts),
  }
}

// One caller going quiet is invisible to a whole-table check.
//
// The stall branch above asks "has ANYTHING written recently", which is only
// true when every writer is dead at once. In practice they die one at a time:
// a refactor drops one CLI branch, that hook's recalls stop, and the other
// callers keep the table busy so the table looks fine forever. Two real cases
// on one deployment, both found by hand long after the fact — a per-turn
// conversation writer down 17 days, and a PreToolUse recall down 19. Both had
// been sitting in recall_log the whole time as a source whose last_ts stopped
// on a date and never moved.
//
// A stall is a SIGNAL, not a verdict. A renamed source looks identical to a
// dead one from here — the old label stops, a new one starts. That is worth a
// human glance either way, so this reports and does not judge.
export function detectStalledSources(db, opts = {}) {
  const minHistory = opts.sourceStallMinHistory ?? DEFAULTS.sourceStallMinHistory
  const stallDays = opts.sourceStallDays ?? DEFAULTS.sourceStallDays
  const cutoff = Date.now() - stallDays * 86400_000
  let rows
  try {
    rows = db.prepare(`
      SELECT source, COUNT(*) total, MAX(ts) last_ts, MIN(ts) first_ts
      FROM recall_log
      GROUP BY source
      HAVING total >= ? AND last_ts < ?
      ORDER BY total DESC
    `).all(minHistory, cutoff)
  } catch { return [] }
  return rows.map(r => ({
    source: r.source,
    total: r.total,
    silent_days: Math.floor((Date.now() - r.last_ts) / 86400_000),
    last_write_at: new Date(r.last_ts).toISOString(),
    first_write_at: new Date(r.first_ts).toISOString(),
  }))
}

// ============================================================
// Scan (e): near-dup — per-category cosine, budgeted
// ============================================================
export function detectNearDup(db, opts = {}) {
  const simDup = opts.simDup ?? DEFAULTS.simDup
  const simFloor = opts.simFloor ?? DEFAULTS.simFloor
  const simSupersede = opts.simSupersede ?? DEFAULTS.simSupersede
  const simBands = opts.simBands ?? DEFAULTS.simBands
  const budgetMs = opts.budgetMs ?? DEFAULTS.budgetMs
  const maxPairs = opts.maxPairsPerBucket ?? DEFAULTS.maxPairsPerBucket
  const dumpHist = !!opts.dumpHist
  const warnings = []
  const t0 = Date.now()
  const overBudget = () => Date.now() - t0 > budgetMs
  // Anything at or above this cosine gets recorded; the band it lands in is
  // decided per-pair below.
  const recordFloor = Math.min(simFloor, simSupersede)

  // migration 008 columns — absent on DBs that have not been opened by a
  // current initMemory() yet. This script is read-only and must not migrate,
  // so degrade instead: without the flags the supersede band simply cannot
  // protect anchors/pins, which is stated in the report rather than assumed.
  const cols = new Set(db.prepare(`PRAGMA table_info(memories)`).all().map(c => c.name))
  const hasFlags = cols.has('is_anchor') && cols.has('is_pinned')
  const flagSel = hasFlags ? 'is_anchor, is_pinned' : '0 AS is_anchor, 0 AS is_pinned'
  if (!hasFlags) warnings.push('is_anchor/is_pinned columns absent — supersede band cannot exclude anchored/pinned rows')

  const rows = db.prepare(`
    SELECT rowid, id, category, importance, content_vector,
           COALESCE(NULLIF(summary, ''), substr(content, 1, 140)) AS summary,
           created_at, access_count, memory_level, memory_type, ${flagSel}
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
    buckets.get(r.category).push({
      rowid: r.rowid, id: r.id, importance: r.importance, summary: r.summary, nv,
      created_at: r.created_at, access_count: r.access_count,
      memory_level: r.memory_level, memory_type: r.memory_type,
      protected: !!(r.is_anchor || r.is_pinned || r.memory_type === 'permanent'),
    })
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
        if (c >= recordFloor) {
          const band = c >= simDup ? 'dup' : (c >= simFloor ? 'near' : 'supersede')
          const entry = {
            cat, cosine: +c.toFixed(4), band,
            a: { rowid: items[i].rowid, id: items[i].id, imp: items[i].importance, summary: clip(items[i].summary, 60) },
            b: { rowid: items[j].rowid, id: items[j].id, imp: items[j].importance, summary: clip(items[j].summary, 60) },
            is_dup: c >= simDup,
          }
          // The supersede band is reviewed pair-by-pair by a human/agent, so it
          // carries the signals that decide "is one of these a stale iteration":
          // which side is newer, how far apart they were written, and how alive
          // each one is. Protected rows (anchor/pin/permanent) are flagged, not
          // dropped — an old plain row next to an anchor is still a valid
          // supersede target, and only the reviewer can tell which side is which.
          if (band === 'supersede') {
            // Time series masquerade as rewrites at this cosine band. See
            // isLikelySeries for the three signals and what calibrated them.
            // Flagged rather than dropped: the reviewer still sees the count.
            const likelySeries = isLikelySeries(items[i], items[j])
            entry.detail = {
              a: sideDetail(items[i], t0), b: sideDetail(items[j], t0),
              newer_rowid: (items[i].created_at ?? 0) >= (items[j].created_at ?? 0) ? items[i].rowid : items[j].rowid,
              age_gap_days: Math.abs(Math.round(((items[i].created_at ?? 0) - (items[j].created_at ?? 0)) / 86400_000)),
              any_protected: items[i].protected || items[j].protected,
              likely_series: likelySeries,
            }
          }
          candidates.push(entry)
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
    dup_candidates: candidates.filter(c => c.band === 'dup'),
    near_candidates: candidates.filter(c => c.band === 'near'),
    supersede_candidates: candidates.filter(c => c.band === 'supersede'),
    warnings,
    ...(dumpHist ? { histogram: hist } : {}),
  }
}

// ============================================================
// (a3) shrink victims — chains that already collapsed
//
// The write-time guard in index.mjs catches this going forward. This finds the
// rows where it already happened: walk prior_versions[] and ask which
// high-signal identifiers the live content no longer carries.
//
// Two classes look identical by token count and are NOT the same thing:
//   - a rolling ledger (daily log, running account) legitimately rotates old
//     file names out while the entry keeps GROWING — expected, not a defect
//   - a reference entry that SHRANK below its own historical peak while
//     shedding identifiers — that is the collapse
// Only the second is reported. Judging on lost tokens alone flags ~60% of all
// chains and buries the real ones.
// ============================================================
export function detectShrinkVictims(db, opts = {}) {
  const minImportance = opts.shrinkMinImportance ?? DEFAULTS.shrinkMinImportance
  const peakRatio = opts.shrinkPeakRatio ?? DEFAULTS.shrinkPeakRatio
  const cols = new Set(db.prepare(`PRAGMA table_info(memories)`).all().map(c => c.name))
  const hasFlags = cols.has('is_anchor') && cols.has('is_pinned')
  const flagSel = hasFlags ? 'is_anchor, is_pinned' : '0 AS is_anchor, 0 AS is_pinned'

  let rows
  try {
    rows = db.prepare(`
      SELECT rowid, COALESCE(NULLIF(summary, ''), substr(content, 1, 140)) AS summary,
             content, prior_versions, importance, access_count, memory_level, ${flagSel},
             CAST(COALESCE(json_extract(metadata, '$.shrink_ack'), 0) AS INTEGER) AS shrink_ack,
             COALESCE(updated_at, created_at, 0) AS touched_at
      FROM memories
      WHERE deleted_at IS NULL AND superseded_by IS NULL
        AND prior_versions IS NOT NULL AND length(prior_versions) > 2
    `).all()
  } catch (e) {
    return { available: false, reason: e.message, victims: [], scanned: 0, ledger_growing: 0, lost_any: 0, acked: 0 }
  }

  let lostAny = 0, ledgerGrowing = 0, acked = 0
  const victims = []
  for (const r of rows) {
    let priors
    try { priors = JSON.parse(r.prior_versions) } catch { continue }
    if (!Array.isArray(priors) || !priors.length) continue

    // A reviewer who looked and judged "acceptable" must not be asked again —
    // a queue that re-reports the same rows every night trains you to skip it.
    // The ack expires if the row is edited afterwards: new content, new question.
    if (r.shrink_ack && r.shrink_ack >= r.touched_at) { acked++; continue }

    const nowTokens = new Set(extractHighSignalTokens(r.content))
    const lost = new Set()
    for (const p of priors) {
      // Same "is it still carried" rule as the write-time guard, imported rather
      // than reimplemented — these two drifted apart once before and the audit
      // queue is only trustworthy if it agrees with the gate that let the write
      // through in the first place.
      for (const t of extractHighSignalTokens(p.content)) if (!isStillCarried(t, nowTokens)) lost.add(t)
    }
    if (!lost.size) continue
    lostAny++

    const peakLen = Math.max(...priors.map(p => (p.content || '').length), 0)
    const nowLen = (r.content || '').length
    if (nowLen >= peakLen) { ledgerGrowing++; continue }   // still growing → ledger rotation
    const ratio = peakLen ? +(nowLen / peakLen).toFixed(2) : 1
    if (r.importance < minImportance || ratio >= peakRatio) continue

    victims.push({
      rowid: r.rowid,
      imp: r.importance,
      acc: r.access_count ?? 0,
      level: (r.memory_level || '').slice(0, 4),
      protected: !!(r.is_anchor || r.is_pinned),
      hops: priors.length,
      peak_len: peakLen,
      now_len: nowLen,
      ratio,
      lost: [...lost].slice(0, 20),
      lost_count: lost.size,
      summary: clip(r.summary, 110),
    })
  }
  // Highest recall traffic first: a collapsed entry nobody reads is a smaller
  // problem than one being served hundreds of times a month.
  victims.sort((a, b) => (b.acc - a.acc) || (b.lost_count - a.lost_count))
  return {
    available: true, scanned: rows.length, lost_any: lostAny,
    ledger_growing: ledgerGrowing, acked, victims,
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
        sim_supersede: opts.simSupersede ?? DEFAULTS.simSupersede,
        shrink_min_importance: opts.shrinkMinImportance ?? DEFAULTS.shrinkMinImportance,
        shrink_peak_ratio: opts.shrinkPeakRatio ?? DEFAULTS.shrinkPeakRatio,
        stale_decay: opts.staleDecay ?? DEFAULTS.staleDecay,
        recall_window_days: opts.recallLogDays ?? DEFAULTS.recallLogDays,
        budget_ms: opts.budgetMs ?? DEFAULTS.budgetMs,
      },
      inflation: detectInflation(db),
      dead_concrete: detectDeadConcrete(db, opts),
      integrity: detectIntegrity(db, opts),
      blindspot: detectBlindspot(db, opts),
      near_dup: detectNearDup(db, opts),
      shrink: detectShrinkVictims(db, opts),
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
// Series detection — keeps timelines out of the supersede band
// ============================================================

// Matches a temporal or ordinal marker anywhere in a summary: ISO dates,
// clock times, slash dates, CJK dates. Rows whose summaries lead with one of
// these are almost always entries in a series (nightly snapshots, timestamped
// log lines) rather than drafts of a single fact.
const TEMPORAL_MARKER = /(?:20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日)/g

function temporalMarkers(text) {
  if (typeof text !== 'string' || !text) return null
  const found = text.match(TEMPORAL_MARKER)
  return found && found.length ? new Set(found) : null
}

/**
 * True when a near-duplicate pair is a point in a time series rather than a
 * stale rewrite of one fact.
 *
 * The supersede band exists to catch "an already-replaced version stays active
 * and can be recalled as if current". A time series has no replaced version —
 * every entry is still true about its own moment, and superseding one destroys
 * the sequence. Reported separately instead of dropped, so the count stays
 * visible.
 *
 * Three signals, any one of which is sufficient:
 *   1. both rows are concrete_trace — two runs of one routine, which decay is
 *      already supposed to bury
 *   2. written inside one working session — a log or a request/reply pair
 *   3. both summaries carry a temporal marker and the markers differ — a dated
 *      series whose entries can sit arbitrarily far apart
 *
 * Signal 3 requires the markers to DIFFER: two rows citing the same date are
 * one event described twice, which is exactly the rewrite we want to surface.
 */
export function isLikelySeries(a, b, opts = {}) {
  if (a?.memory_level === 'concrete_trace' && b?.memory_level === 'concrete_trace') return true

  // Missing timestamps must not read as a zero gap — that would swallow every
  // pair with an unset created_at into "same session".
  const ta = a?.created_at, tb = b?.created_at
  if (Number.isFinite(ta) && Number.isFinite(tb)) {
    const windowMs = (opts.sameSessionHours ?? DEFAULTS.seriesSameSessionHours) * 3600_000
    if (Math.abs(ta - tb) < windowMs) return true
  }

  const ma = temporalMarkers(a?.summary), mb = temporalMarkers(b?.summary)
  if (ma && mb) {
    for (const m of ma) if (!mb.has(m)) return true
    for (const m of mb) if (!ma.has(m)) return true
  }
  return false
}

// ============================================================
// Text render — human-readable report from the JSON return
// ============================================================
export function renderTextReport(report, opts = {}) {
  const simDup = report.thresholds.sim_dup
  const simFloor = report.thresholds.sim_floor
  const simSupersede = report.thresholds.sim_supersede ?? DEFAULTS.simSupersede
  const staleDecay = report.thresholds.stale_decay
  const inf = report.inflation, nd = report.near_dup, bs = report.blindspot, ig = report.integrity
  const L = []
  L.push(`\n# mneme memory-health report  (${report.generated_at}, ${report.elapsed_ms}ms)`)
  L.push(`DB: ${report.db}  ·  active=${inf.total}\n`)

  L.push(`## TL;DR`)
  L.push(`- true-dup candidates (cos>=${simDup}): ${nd.dup_candidates.length} pair(s)  ·  near-dup for review (>=${simFloor}): ${nd.near_candidates.length}`)
  if (report.shrink?.available) {
    L.push(`- shrink victims (collapsed chains, imp>=${report.thresholds.shrink_min_importance ?? DEFAULTS.shrinkMinImportance}): ${report.shrink.victims.length}  ·  ${report.shrink.ledger_growing} growing-ledger rotations excluded`)
  }
  L.push(`- dead concrete_trace: ${report.dead_concrete.length}`)
  L.push(`- inflation: meta ${inf.meta_pct}% / imp>=7 ${inf.imp_ge7_pct}% / imp>=9 ${inf.imp_ge9_pct}%  ·  concrete imp>5 violations ${inf.concrete_importance_violations}  ·  meta zero-access downgrade candidates ${inf.meta_zero_access_downgrade_candidates}`)
  L.push(`- supersede chain: ${ig.orphan_targets} orphan / ${ig.leaked_active} leaked-active (both should be 0)  ·  dead_knowledge(${ig.dead_knowledge_days}d): ${ig.dead_knowledge_count}`)
  if (bs.available) {
    L.push(`- recall_log(${bs.window_days}d): ${bs.total_calls} calls  ·  strict-zero ${bs.strict_zero} / RRF-zero ${bs.final_zero}  ·  repeat queries (non-noise) ${bs.repeat_queries.length}`)
    if (bs.stalled_sources?.length) {
      L.push(`- 🚨 recall_log source STALLED: ${bs.stalled_sources.map(s => `${s.source} (${s.total} rows, silent ${s.silent_days}d)`).join(' / ')} — a caller stopped writing while the table stayed busy`)
    }
  } else if (bs.instrumentation_stalled) {
    L.push(`- 🚨 recall_log STALLED: ${bs.total_rows} rows, silent ${bs.silent_days}d (last ${bs.last_write_at?.slice(0, 16)}Z) — the writer is gone, not the data`)
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

  const scAll = nd.supersede_candidates || []
  const scSeries = scAll.filter(c => c.detail?.likely_series)
  const sc = scAll.filter(c => !c.detail?.likely_series)
  L.push(`\n## (a2) supersede candidates — same subject rewritten (${simSupersede}<=cos<${simFloor}): ${sc.length}`)
  L.push(`  Judge each: [stale-iteration] supersede the older -> [redundant] keep one -> [both-true] leave alone.`)
  L.push(`  Not a duplicate scan — these are pairs whose wording drifted, which is where`)
  L.push(`  an already-replaced version stays active and can be recalled as if current.`)
  if (scSeries.length) {
    L.push(`  (${scSeries.length} time-series pairs hidden — same-session logs, dated snapshots, repeated routine runs.`)
    L.push(`   Every entry is still true about its own moment, so superseding one destroys the sequence.)`)
  }
  if (!sc.length) L.push(`  (none)`)
  for (const c of sc.slice(0, 40)) {
    const d = c.detail
    const mark = (s) => `#${s.rowid}${s.protected ? '[P]' : ''}`
    const newerA = d.newer_rowid === d.a.rowid
    L.push(`  cos=${c.cosine} [${c.cat}] gap=${d.age_gap_days}d  newer=#${d.newer_rowid}${d.any_protected ? '  ⚠ protected side present' : ''}`)
    L.push(`     ${newerA ? 'NEW' : 'old'} ${mark(d.a)} imp=${d.a.imp} ${d.a.level} acc=${d.a.acc} age=${d.a.age_days}d: ${d.a.summary}`)
    L.push(`     ${newerA ? 'old' : 'NEW'} ${mark(d.b)} imp=${d.b.imp} ${d.b.level} acc=${d.b.acc} age=${d.b.age_days}d: ${d.b.summary}`)
  }
  if (sc.length > 40) L.push(`  ... ${sc.length - 40} more (use --format json for the full list)`)

  const sh = report.shrink
  if (sh?.available) {
    const minImp = report.thresholds.shrink_min_importance ?? DEFAULTS.shrinkMinImportance
    const pr = report.thresholds.shrink_peak_ratio ?? DEFAULTS.shrinkPeakRatio
    L.push(`\n## (a3) shrink victims — supersede chains that dropped identifiers: ${sh.victims.length}`)
    L.push(`  scanned ${sh.scanned} chain(s) · ${sh.lost_any} lost >=1 identifier · ${sh.ledger_growing} still growing (ledger rotation, not a defect)`)
    L.push(`  filter: importance>=${minImp} AND now/peak<${pr}, highest access_count first${sh.acked ? `  ·  ${sh.acked} previously reviewed (node index.mjs --shrink-ack)` : ''}`)
    if (!sh.victims.length) L.push(`  (none)`)
    for (const v of sh.victims.slice(0, 20)) {
      L.push(`  #${v.rowid} imp=${v.imp}${v.protected ? ' [P]' : ''} acc=${v.acc} · ${v.hops} hop(s) · ${v.peak_len}B->${v.now_len}B (${Math.round(v.ratio * 100)}%) · lost ${v.lost_count}`)
      L.push(`     ${v.summary}`)
      L.push(`     lost: ${v.lost.slice(0, 6).join(' | ')}${v.lost_count > 6 ? ` ...+${v.lost_count - 6}` : ''}`)
    }
    if (sh.victims.length > 20) L.push(`  ... ${sh.victims.length - 20} more (use --format json for the full list)`)
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
    if (bs.stalled_sources?.length) {
      L.push(`  🚨 stalled sources (wrote >=${DEFAULTS.sourceStallMinHistory} rows, silent >=${DEFAULTS.sourceStallDays}d):`)
      for (const s of bs.stalled_sources) {
        L.push(`    ${s.source}: ${s.total} rows, last ${s.last_write_at.slice(0, 16)}Z (${s.silent_days}d ago)`)
      }
      L.push(`    a rename looks the same as a death from here — check whether the caller was retired or broke`)
    }
    if (bs.zero_hit_real_queries.length) {
      L.push(`  real zero-hit queries (noise filtered): ${bs.zero_hit_real_queries.map(q => `"${clip(q, 30)}"`).join(', ')}`)
    }
    if (bs.repeat_queries.length) {
      L.push(`  repeat queries that recall answers thinly (freq>=${DEFAULTS.repeatQueryMin}, avg hits<${DEFAULTS.repeatQueryMaxAvgHits}) — these are the sediment gaps:`)
      for (const r of bs.repeat_queries) L.push(`    freq=${r.freq} avg_hits=${r.avg_hits} "${r.q}"`)
    }
    if (bs.repeat_queries_answered) {
      L.push(`  (${bs.repeat_queries_answered} more repeat queries hidden — recall answers them, so they are hot topics, not gaps)`)
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
    simSupersede: parseFloatArg('--sim-supersede', getFlag('--sim-supersede'), DEFAULTS.simSupersede),
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
  --sim-supersede F       Cosine floor for the supersede band (default: ${DEFAULTS.simSupersede})
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
