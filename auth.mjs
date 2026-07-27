// ============================================================
// mneme channel auth (v2.8, provenance layer)
//
// Purpose: `source_host` on every write must be derived from the CHANNEL
// (bearer token → host map), never from client/LLM self-report. An LLM
// saying "I am the codex host" is not ground truth; the credential it
// connected with is. Same principle as "completion assertions need
// evidence" — provenance is evidence, so it comes from infrastructure.
//
// Config (env):
//   MNEME_HOST_TOKENS  "cc=tok1,codex=tok2" — host=token pairs
//   MNEME_AUTH         off | soft | enforce (default: soft when tokens
//                      configured, off otherwise)
//   MNEME_DEFAULT_HOST fallback host label for untokened writes (default 'cc')
//
// Modes:
//   off     — no tokens configured; every session gets the default host.
//             Same trust level as pre-v2.8 (any local process could write).
//   soft    — valid token → mapped host; missing/unknown token → default
//             host, request still served. Zero-break migration mode: deploy
//             server first, hand out tokens second.
//   enforce — missing/unknown token → 401. Turn on once every client
//             carries a token.
// ============================================================

// Host labels are identifiers, not prose — keep them safe to embed in
// recall headers and SQL-adjacent logs.
export const HOST_LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i

/** "cc=tok1,codex=tok2" → Map(token → host). Malformed pairs are skipped. */
export function parseHostTokens(raw) {
  const map = new Map()
  if (!raw) return map
  for (const pair of String(raw).split(',')) {
    const idx = pair.indexOf('=')
    if (idx <= 0) continue
    const host = pair.slice(0, idx).trim()
    const token = pair.slice(idx + 1).trim()
    if (!host || !token || !HOST_LABEL_RE.test(host)) continue
    map.set(token, host)
  }
  return map
}

/** Explicit env wins; otherwise soft iff any tokens are configured. */
export function resolveAuthMode(envMode, tokenMap) {
  const m = String(envMode || '').trim().toLowerCase()
  if (m === 'off' || m === 'soft' || m === 'enforce') return m
  return tokenMap.size > 0 ? 'soft' : 'off'
}

/**
 * Resolve the writing host from an Authorization header value.
 * @returns {{ok: boolean, host: string|null, authed: boolean, reason?: string}}
 *   ok=false only in enforce mode (caller should respond 401).
 *   authed=true only when a known token matched — callers can log
 *   soft-mode fallbacks without blocking them.
 */
export function resolveHost(authHeader, tokenMap, { mode = 'off', defaultHost = 'cc' } = {}) {
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader || '').trim())
  const token = m ? m[1].trim() : null
  if (token && tokenMap.has(token)) {
    return { ok: true, host: tokenMap.get(token), authed: true }
  }
  const reason = token ? 'unknown token' : 'missing bearer token'
  if (mode === 'enforce') {
    return { ok: false, host: null, authed: false, reason }
  }
  return { ok: true, host: defaultHost, authed: false, reason: `${reason} (${mode}: default host)` }
}
