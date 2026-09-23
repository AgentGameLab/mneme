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

// Where a leak starts: a wrong closer, then a field opener. The closer is
// required — every corrupted row seen in the wild has one, and a bare field
// opener mid-prose would otherwise swallow the rest of the text as a value.
const leakStart = (closers) =>
  new RegExp(`</(?:${closers})>\\s*<(?:parameter name="(?:${F})"|(?:${F}))>`, 'g')
const OPEN = new RegExp(`^<(?:parameter name="(${F})"|(${F}))>`)
const VALUE_END = new RegExp(`</parameter>|</(?:${F})>|<parameter name="|<(?:${F})>`, 'g')
const CLOSERS = /^(?:\s*<\/[A-Za-z_:]+>)+/

// Parse `<field>value</…>` runs from `s` to the end. Returns null if anything
// other than field tags / closers / whitespace shows up — that means the
// match was prose, not a leak.
function parseTail(s) {
  const out = {}
  let i = 0
  while (true) {
    while (i < s.length && /\s/.test(s[i])) i++
    const closers = s.slice(i).match(CLOSERS)
    if (closers) { i += closers[0].length; continue }
    if (i >= s.length) break
    const m = s.slice(i).match(OPEN)
    if (!m) return null
    const name = m[1] || m[2]
    i += m[0].length
    VALUE_END.lastIndex = i
    const end = VALUE_END.exec(s)
    const stop = end ? end.index : s.length
    out[name] = s.slice(i, stop).trim()
    i = stop
  }
  return Object.keys(out).length ? out : null
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

// Find the first structural leak in `text`. Returns { head, fields } or
// { suspect: true } when a leak-shaped match exists but the tail is prose.
function splitLeak(text, closers) {
  if (typeof text !== 'string' || !text) return null
  const re = leakStart(closers)
  let m
  let suspect = false
  while ((m = re.exec(text))) {
    if (text[m.index - 1] === '`') continue  // quoted in inline code
    const tail = text.slice(m.index).replace(new RegExp(`^</(?:${closers})>`), '')
    const fields = parseTail(tail)
    if (fields) return { head: text.slice(0, m.index).trimEnd(), fields }
    // Leak-shaped but the tail didn't parse — flag it so the caller can
    // check the stored row.
    suspect = true
  }
  return suspect ? { suspect: true } : null
}

const isEmpty = v => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

/**
 * Repair a store_memory argument set whose fields leaked into content/summary.
 * Pure: returns a new args object, never mutates the input.
 *
 * Merge rule: fields that zod defaults when absent (importance, category,
 * memory_type, memory_level) take the leaked value — the passed value is the
 * default standing in for the one that leaked. Fields with no default
 * (summary, tags, supersedes, …) keep a non-empty passed value.
 *
 * @returns {{ repaired: boolean, suspect: boolean, args: object, moved: string[], from: string[] }}
 */
export function repairTagLeak(args) {
  const next = { ...args }
  const moved = []
  const from = []
  let suspect = false

  const apply = (fields, source) => {
    for (const [name, raw] of Object.entries(fields)) {
      if (name === 'summary' && source === 'summary') continue
      const v = coerce(name, raw)
      if (v === undefined) continue
      const defaulted = name === 'importance' || !!ENUMS[name]
      if (defaulted || isEmpty(next[name])) {
        next[name] = v
        moved.push(name)
      }
    }
    from.push(source)
  }

  const c = splitLeak(next.content, 'content|parameter')
  if (c?.fields) {
    next.content = c.head
    apply(c.fields, 'content')
  } else if (c?.suspect) suspect = true

  const s = splitLeak(next.summary, 'summary|parameter')
  if (s?.fields) {
    next.summary = s.head
    apply(s.fields, 'summary')
  } else if (s?.suspect) suspect = true

  return { repaired: from.length > 0, suspect, args: next, moved: [...new Set(moved)], from }
}
