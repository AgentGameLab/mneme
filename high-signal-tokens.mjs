// ============================================================
// High-signal token extraction + supersede shrink detection
//
// Shared by two consumers that must agree on what "losing a fact" means:
//   - index.mjs      write-time guard: warn the caller as a supersede lands
//   - memory-health.mjs  audit: find chains that already collapsed
//
// A "high-signal token" is an identifier a future reader would search for and
// that carries no synonyms — a URL, an env var, an API route, a file location.
// Prose can be reworded freely without loss; these cannot. When one disappears
// across a supersede, something became unrecallable, because memories_fts only
// indexes content/summary/tags — prior_versions[] keeps the audit trail but is
// invisible to search.
// ============================================================

export const SHRINK_RATIO_FLOOR = 0.6
export const SHRINK_MIN_OLD_LEN = 200

// What ends a URL or path token. Half-width ':' and ',' stay legal (ports,
// and trailing commas are stripped afterwards), but CJK text and CJK punctuation
// terminate: Chinese prose runs straight into a path with no space, so without
// this a path swallows the rest of the sentence — "C:/work/foo/。使用文档是".
const PATH_STOP = '\\s"\'`)）(（\\[\\]【】，、。；：！？…\\u4e00-\\u9fff\\u3000-\\u303f'

const HIGH_SIGNAL_PATTERNS = [
  new RegExp(`https?://[^${PATH_STOP}]+`, 'g'),            // URLs
  /\b\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}\b/g,                  // host:port
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,                    // ENV_VAR_NAMES
  // C:/ or E:\ paths. The lookbehind keeps "http://" from yielding "p://…".
  new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:[\\\\/][^${PATH_STOP}]+`, 'g'),
  // /api/agent/v1 routes. ':' and '/' in the lookbehind stop this from
  // re-matching the tail of a URL or a Windows path already captured above.
  /(?<![\w.:/])\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.{}-]+)+/g,
  // src/db.mjs — segments deliberately exclude '.' so the greedy head can't
  // swallow the extension and starve the required suffix match; the lookbehind
  // stops it re-reporting a tail already covered by the URL/Windows patterns.
  /(?<![\w./:\\-])[\w-]+(?:\/[\w-]+)*\.(?:mjs|js|ts|json|md|sql|sh|py|yml|yaml)\b/g,
]

export function extractHighSignalTokens(text) {
  if (!text) return []
  const out = new Set()
  for (const re of HIGH_SIGNAL_PATTERNS) {
    for (const m of String(text).matchAll(re)) {
      const t = m[0].replace(/[.,;:。，、）)】\]]+$/, '')
      if (t.length >= 4) out.add(t)
    }
  }
  return [...out]
}

/**
 * @param {string} newContent content of the record doing the superseding
 * @param {Array<{rowid:number|string, content:string, peakLen?:number}>} olds rows being
 *   superseded. `peakLen` is the longest this entry has ever been (its own content and
 *   every prior version); when supplied it enables the ledger exemption below.
 * @returns {Array<{id,oldLen,newLen,ratio,dropped,droppedCount}>} one entry per suspicious pair
 */
// A token is still carried if the new text names it OR names something it is the
// tail of. Writing `memory/index.mjs` out and `C:/work/ws/memory/index.mjs` in
// is not a loss — it is the same file, said more precisely, and set difference
// alone calls it a drop.
//
// This matters more than it looks. Consolidating several memories almost always
// expands relative references into absolute ones, so the merge that a maintainer
// is most likely to perform is exactly the one that fires the most bogus
// warnings. A guard that cries wolf on good edits gets ignored on the bad ones,
// and this one exists to be read.
//
// Suffix must break on a separator: `send.mjs` is not carried by `feishu-send.mjs`
// (a different file), while `memory/index.mjs` is carried by `E:/x/memory/index.mjs`.
export function isStillCarried(token, newTokens) {
  if (newTokens.has(token)) return true
  for (const t of newTokens) {
    if (t.length > token.length && t.endsWith(token)) {
      const boundary = t[t.length - token.length - 1]
      if (boundary === '/' || boundary === '\\') return true
    }
  }
  return false
}

export function checkSupersedeShrink(newContent, olds) {
  const warnings = []
  const newTokens = new Set(extractHighSignalTokens(newContent))
  const newLen = (newContent || '').length
  // Length is only meaningful 1:1. Merging N rows into one legitimately compresses,
  // so an N:1 supersede is judged purely on which identifiers went missing.
  const oneToOne = olds.length === 1
  for (const old of olds) {
    const oldLen = (old.content || '').length

    // Ledger exemption — mirrors detectShrinkVictims in memory-health.mjs.
    // A rolling entry (daily log, running account) rotates yesterday's file names
    // out while the entry itself keeps GROWING past its own historical peak. That
    // is the shape working as intended, not a collapse. Without this the write-time
    // guard fires on every single daily-log supersede, and a gate that cries wolf
    // daily is a gate you stop reading.
    //
    // Judged against the all-time peak, not just the row being replaced: comparing
    // only to the immediate predecessor would exempt a genuine collapse that happens
    // to be a little longer than the already-shrunken version before it.
    //
    // 1:1 only. In an N:1 merge the result is naturally longer than any single
    // input, so "longer than what it replaced" carries no information about
    // rotation — applying it there silently swallowed real merge losses.
    const peakLen = Math.max(old.peakLen || 0, oldLen)
    if (oneToOne && newLen >= peakLen) continue

    const dropped = extractHighSignalTokens(old.content).filter(t => !isStillCarried(t, newTokens))
    const ratio = oldLen ? +(newLen / oldLen).toFixed(2) : 1
    const shrank = oneToOne && oldLen >= SHRINK_MIN_OLD_LEN && ratio < SHRINK_RATIO_FLOOR
    if (!dropped.length && !shrank) continue
    warnings.push({
      id: String(old.rowid),
      oldLen, newLen, ratio,
      dropped: dropped.slice(0, 20),
      droppedCount: dropped.length,
    })
  }
  return warnings
}
