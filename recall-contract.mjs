import { createHash, randomUUID } from 'node:crypto'

export const MAX_RECALL_RESULTS = 20
export const MAX_RECALL_CANDIDATES = 100
export const MAX_RECALL_CONTEXT_CHARS = 12_000

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function planRecallBudget(requestedLimit, fallback = 10) {
  const requested = positiveInt(requestedLimit, fallback)
  const effective = Math.min(requested, MAX_RECALL_RESULTS)
  const candidates = Math.min(
    MAX_RECALL_CANDIDATES,
    Math.max(requested, effective * 3),
  )
  return { requested, effective, candidates }
}

export function enforceContextBudget(entries, opts = {}) {
  const maxEntries = positiveInt(opts.maxEntries, MAX_RECALL_RESULTS)
  const maxChars = positiveInt(opts.maxChars, MAX_RECALL_CONTEXT_CHARS)
  const render = opts.render || (items => items.join('\n'))
  const kept = []
  let reason = null

  for (const entry of entries) {
    if (kept.length >= maxEntries) {
      reason = 'maxEntries'
      break
    }
    const candidate = kept.concat(entry)
    if (render(candidate).length > maxChars) {
      reason = 'maxChars'
      break
    }
    kept.push(entry)
  }

  const rendered = render(kept)
  return {
    kept,
    dropped: entries.slice(kept.length),
    reason,
    chars: rendered.length,
    rendered,
  }
}

export function createRecallTrace({ query = '', requestedLimit = 10, source = 'api', mode = 'unknown' } = {}) {
  const budget = planRecallBudget(requestedLimit)
  const now = Date.now()
  return {
    traceId: randomUUID(),
    source,
    mode,
    queryHash: createHash('sha256').update(String(query)).digest('hex'),
    queryChars: String(query).length,
    requestedLimit: budget.requested,
    effectiveLimit: budget.effective,
    candidateLimit: budget.candidates,
    startedAt: now,
    endedAt: null,
    durationMs: null,
    keptIds: [],
    steps: [],
  }
}

export function traceRecallStep(trace, name, meta = {}) {
  if (!trace || trace.endedAt != null) return
  trace.steps.push({
    name,
    at: Date.now(),
    elapsedMs: Date.now() - trace.startedAt,
    meta,
  })
}

export function finishRecallTrace(trace, keptIds = []) {
  if (!trace) return null
  if (trace.endedAt == null) {
    trace.endedAt = Date.now()
    trace.durationMs = trace.endedAt - trace.startedAt
  }
  trace.keptIds = [...new Set(keptIds.map(String))]
  return trace
}

export function stripHallucinatedMemoryIds(text, validIds) {
  const allowed = new Set([...validIds].map(String))
  const rejectedIds = []
  const validReferencedIds = []
  // Match `[id:N]`, `[ID: N]`, `[ id:N]` (leading space), `[id : N]`, and other
  // reasonable formatting variants. A single stray space between `[` and `id`
  // used to bypass the allowlist entirely (mneme#7 P0 review).
  const cleanText = String(text || '').replace(/\[\s*id\s*:\s*([^\]\s]+)\s*\]/gi, (match, id) => {
    const normalized = String(id)
    if (allowed.has(normalized)) {
      if (!validReferencedIds.includes(normalized)) validReferencedIds.push(normalized)
      return match
    }
    if (!rejectedIds.includes(normalized)) rejectedIds.push(normalized)
    return '[]'
  })
  return { cleanText, validReferencedIds, rejectedIds }
}
