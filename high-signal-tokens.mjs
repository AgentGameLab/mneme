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
// this a path swallows the rest of the sentence — "E:/Project/foo/。使用文档是".
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
 * @param {Array<{rowid:number|string, content:string}>} olds rows being superseded
 * @returns {Array<{id,oldLen,newLen,ratio,dropped,droppedCount}>} one entry per suspicious pair
 */
export function checkSupersedeShrink(newContent, olds) {
  const warnings = []
  const newTokens = new Set(extractHighSignalTokens(newContent))
  const newLen = (newContent || '').length
  // Length is only meaningful 1:1. Merging N rows into one legitimately compresses,
  // so an N:1 supersede is judged purely on which identifiers went missing.
  const oneToOne = olds.length === 1
  for (const old of olds) {
    const oldLen = (old.content || '').length
    const dropped = extractHighSignalTokens(old.content).filter(t => !newTokens.has(t))
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
