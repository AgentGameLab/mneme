// tag-leak-repair.mjs — tool-call close-tag leak detection + repair
//
// When a caller closes a long `content` argument with the wrong tag
// (`</content>` instead of `</parameter>`, or opens a bare `<summary>`),
// the tool-call parser keeps reading and the sibling fields — summary,
// importance, category, tags — land inside `content` as raw XML. The
// fields themselves arrive empty, so the zod defaults (importance 6,
// category general) silently replace what the caller wrote.
//
// An instruction-level rule against this was in place for months and the
// leak kept happening, so the fix lives at the write path:
// detect the leak, split the tail back into its fields, report the repair.
//
// Detection is structural, not substring. The closing tag must be followed
// by a field tag AND the whole tail must parse as field tags to the end of
// the string. A memory that *describes* this bug quotes the same strings
// mid-prose (often in backticks) — that one must pass through untouched.

const FIELDS = [
  'summary', 'importance', 'category', 'tags', 'memory_type', 'memory_level',
  'supersedes', 'event_time', 'is_anchor', 'is_pinned',
]
const F = FIELDS.join('|')

const ENUMS = {
  category: ['general', 'people', 'project', 'decision', 'feedback', 'bug', 'relationship', 'skill', 'preference'],
  memory_type: ['working', 'short_term', 'long_term', 'permanent'],
  memory_level: ['concrete_trace', 'semi_abstract', 'meta_knowledge'],
}

// zod defaults in the store_memory schema. A passed value equal to one of
// these may be the default standing in for a value that leaked.
export const DEFAULTS = { importance: 6, category: 'general', memory_type: 'long_term', memory_level: 'semi_abstract' }

// Tail tokens, matched in place with sticky regexes — no slicing, tails can
// be tens of KB. Only field / `parameter` closers and the tool-call envelope
// (`invoke` / `function_calls`, optionally namespaced — real leaks usually
// end with it) count. A tail that ends in any other closer (`</entry>`,
// `</div>`) is markup, not a leak.
const WS = /\s*/y
const CLOSE = new RegExp(`</(?:parameter|${F}|(?:[A-Za-z]+:)?(?:invoke|function_calls))>`, 'y')
const OPEN = new RegExp(`<(?:parameter name="(${F})"|(${F}))>`, 'y')
const VALUE_END = new RegExp(`</parameter>|</(?:${F})>|<parameter name="|<(?:${F})>`, 'g')

// Parse field runs from `start` to the end of `s`. Returns { fields } when the
// whole tail is field openers / field closers / whitespace, else { failAt }:
// the position of the first token that isn't one.
function parseTail(s, start) {
  const out = {}
  let i = start
  while (true) {
    WS.lastIndex = i; WS.exec(s); i = WS.lastIndex
    if (i >= s.length) break
    CLOSE.lastIndex = i
    if (CLOSE.exec(s)) { i = CLOSE.lastIndex; continue }
    OPEN.lastIndex = i
    const m = OPEN.exec(s)
    if (!m) return { failAt: i }
    const name = m[1] || m[2]
    VALUE_END.lastIndex = OPEN.lastIndex
    const end = VALUE_END.exec(s)
    const stop = end ? end.index : s.length
    out[name] = s.slice(OPEN.lastIndex, stop).trim()
    i = stop
  }
  return { fields: out }
}

function coerce(name, raw) {
  if (name === 'importance') {
    const n = Number(raw)
    return Number.isFinite(n) && n >= 1 && n <= 10 ? n : undefined
  }
  if (ENUMS[name]) return ENUMS[name].includes(raw) ? raw : undefined
  if (name === 'tags' || name === 'supersedes') {
    try {
      const v = JSON.parse(raw)
      if (Array.isArray(v)) return v.map(String)
    } catch {}
    const parts = raw.split(/[,，]/).map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    return parts.length ? parts : undefined
  }
  if (name === 'is_anchor' || name === 'is_pinned') {
    return raw === 'true' ? true : raw === 'false' ? false : undefined
  }
  return raw || undefined
}

// Find the first structural leak in `text`: a closer from `closerNames`, then
// a field opener, then a tail that parses as fields to the end of the string.
// Returns { head, fields }, { suspect: true } when a leak-shaped match exists
// but nothing parsed cleanly, or null.
function splitLeak(text, closerNames) {
  if (typeof text !== 'string' || !text) return null
  const re = new RegExp(`</(${closerNames})>\\s*<(?:parameter name="(?:${F})"|(?:${F}))>`, 'g')

  // A leaked closer has no opener in the text — the caller's own opening tag
  // was consumed by the tool-call parser. A closer that closes an element
  // opened earlier (`<content>…</content>` in a quoted Atom entry, say) is
  // markup. Open/close depth per name, advanced as matches move right.
  const tagRe = new RegExp(`<(/?)(${closerNames})(?=[\\s>])`, 'g')
  const depth = Object.fromEntries(closerNames.split('|').map(n => [n, 0]))
  let scanned = 0
  const advanceTo = (to) => {
    tagRe.lastIndex = scanned
    let t
    while ((t = tagRe.exec(text)) && t.index < to) depth[t[2]] += t[1] ? -1 : 1
    scanned = to
  }

  let m
  let suspect = false
  while ((m = re.exec(text))) {
    if (text[m.index - 1] === '`') continue  // quoted in inline code
    advanceTo(m.index)
    if (depth[m[1]] > 0) continue
    const r = parseTail(text, m.index + m[1].length + 3)
    if (r.fields) return { head: text.slice(0, m.index).trimEnd(), fields: r.fields }
    suspect = true
    // Any later start before failAt runs into the same non-field token, so
    // skip past it — keeps the scan linear on long, repetitive content.
    re.lastIndex = Math.max(re.lastIndex, r.failAt)
  }
  return suspect ? { suspect: true } : null
}

const isEmpty = v => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

/**
 * Repair a store_memory argument set whose fields leaked into content/summary.
 * Pure: returns a new args object, never mutates the input.
 *
 * Merge rule: a leaked value only replaces a value the caller didn't really
 * choose — an empty one, or one equal to the zod default (`defaults`). An
 * explicitly passed non-default value always wins. When content and summary
 * both leak the same field, the content-side value is kept.
 *
 * The text is only truncated when the split pays for itself: at least one
 * field is recovered and something of the original text is left. Otherwise
 * the args pass through unchanged and the result is flagged `suspect`.
 *
 * @returns {{ repaired: boolean, suspect: boolean, args: object, moved: string[], from: string[] }}
 */
export function repairTagLeak(args, defaults = DEFAULTS) {
  const next = { ...args }
  const moved = new Set()
  const from = []
  let suspect = false

  const replaceable = (name) => isEmpty(next[name]) || (name in defaults && next[name] === defaults[name])

  for (const [field, closerNames] of [['content', 'content|parameter'], ['summary', 'summary|parameter']]) {
    const hit = splitLeak(next[field], closerNames)
    if (!hit) continue
    if (hit.suspect) { suspect = true; continue }
    // `accounted`: tail fields that are valid and either applied now or
    // already recovered from the other side — proof the tail is a real leak.
    const updates = {}
    let accounted = 0
    for (const [name, raw] of Object.entries(hit.fields)) {
      if (name === field) continue
      const v = coerce(name, raw)
      if (v === undefined) continue
      if (moved.has(name)) { accounted++; continue }
      if (replaceable(name)) { updates[name] = v; accounted++ }
    }
    if (!accounted || !hit.head.trim()) { suspect = true; continue }
    next[field] = hit.head
    Object.assign(next, updates)
    for (const k of Object.keys(updates)) moved.add(k)
    from.push(field)
  }

  return { repaired: from.length > 0, suspect, args: next, moved: [...moved], from }
}
