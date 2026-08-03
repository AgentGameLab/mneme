#!/usr/bin/env node
// ============================================================
// mneme MCP Server v2.8.0
// Exposes recall/store/inspect/audit tools over MCP.
// On-demand recall for any MCP-compatible AI agent — saves 80-90% memory token costs
//
// Transport modes (decided by --transport flag):
//   default (no flag) — stdio (one server per cc session spawn, legacy)
//   --transport=http --port=18792 — HTTP Streamable, single daemon-managed
//     instance shared by all cc clients. Roots out the "N cc sessions ->
//     N spawned mcp-server processes -> WAL lock contention -> zombie
//     accumulation" failure mode (2026-04-27 实证 13 个并发 → engram.db 锁
//     竞争 → MCP disconnected). Required for the "single SQLite connection"
//     architecture diagram.
// ============================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  initMemory,
  recallMemories,
  getMemoriesByIds,
  storeMemory,
  recallForClients,
  storeMemoryAsync,
  storeMemoryQuarantined,
  listQuarantine,
  resolveQuarantine,
  buildMemoryContext,
  getRecallTrace,
  validateMemoryReferences,
  getMemoryStats,
  embedMissingVectors,
  indexSessionTranscripts,
  closeMemory,
  setLocation,
  getLocation,
  listLocations,
  deleteLocation,
} from './index.mjs'
import { parseHostTokens, resolveAuthMode, resolveHost } from './auth.mjs'

// ── Load .env.local BEFORE initMemory() ────────────────────────────────
// The MCP server is often spawned by a supervisor (watchdog / launcher) that
// doesn't inherit the user's shell env. Load `../.env.local` here so that
// EMBEDDING_API_* and any other config-file secrets reach initMemory() —
// without this, embeddings silently fall back to FTS5-only.
const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dirname, '..', '.env.local')
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*?)\r?$/)
    // Existing env wins — launcher-set values still override the file.
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim()
    } else if (m && m[2].trim() === '') {
      // ...except an explicitly empty value, which CLEARS the variable. Without
      // this, `MNEME_QUARANTINE_HOSTS=` cannot turn quarantine back off once
      // something upstream has set it — the file says off, the env says on, and
      // writes keep landing in a table recall never reads. "Existing env wins"
      // is right for supplying a value and wrong for withdrawing one.
      delete process.env[m[1]]
    }
  })
}

// Initialize memory system once at startup
initMemory()

// Startup self-heal sweep: backfill missing content_vector on active memories.
// Fire-and-forget, doesn't block server startup; no-op when embedding is
// unconfigured. Complements the .env.local load above so restarts patch the
// windows during which writes went through paths that skipped embedding.
embedMissingVectors(500).then(r => {
  if (r.embedded || r.failed) console.error(`[mneme] startup self-heal: embedded ${r.embedded}, failed ${r.failed}, scanned ${r.scanned}`)
}).catch(e => console.error(`[mneme] startup self-heal failed: ${e.message}`))

const SERVER_NAME = 'mneme'
const SERVER_VERSION = '2.8.0'

// ── Channel auth (migration 011) — token -> host map, resolved once at startup ──
// Multiple agent runtimes (cc / codex / ...) share this endpoint; each carries
// its own token (MNEME_HOST_TOKENS="cc=tok1,codex=tok2") and the server derives
// source_host from the token. Client-supplied host claims never exist in any tool
// schema — provenance is channel-derived by construction.
const HOST_TOKENS = parseHostTokens(process.env.MNEME_HOST_TOKENS)
const AUTH_MODE = resolveAuthMode(process.env.MNEME_AUTH, HOST_TOKENS)
const DEFAULT_HOST = process.env.MNEME_DEFAULT_HOST || 'cc'
if (HOST_TOKENS.size > 0) {
  console.error(`[mneme] channel auth: mode=${AUTH_MODE}, hosts=[${[...new Set(HOST_TOKENS.values())].join(', ')}], default=${DEFAULT_HOST}`)
}

// ── Quarantine routing (migration 012) — review authority is channel identity ──
// Hosts listed in MNEME_QUARANTINE_HOSTS write into memories_quarantine instead
// of the main pool, so recall cannot see them by construction. resolve_quarantine
// is only registered on primary-host sessions.
const QUARANTINE_HOSTS = new Set(
  (process.env.MNEME_QUARANTINE_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean)
)
const PRIMARY_HOST = process.env.MNEME_PRIMARY_HOST || DEFAULT_HOST
if (QUARANTINE_HOSTS.size > 0) {
  console.error(`[mneme] quarantine: hosts=[${[...QUARANTINE_HOSTS].join(', ')}], reviewer=${PRIMARY_HOST}`)
}

// ── Factory: each call returns a fresh McpServer with all 4 tools registered ──
// Why factory: HTTP stateful multi-client mode requires per-session McpServer
// (SDK design: transport ↔ server is 1:1, sharing tool registry across transports
// is unsafe). Stdio mode also calls createServer() once for symmetry.
function createServer(hostId = DEFAULT_HOST) {
  const s = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  })

  // ── Tool: recall_memory ─────────────────────────────────────
  s.tool(
    'recall_memory',
    'Retrieve relevant content from the agent\'s long-term memory. Must call when dealing with personal preferences, past work, project status, relationships, or decisions.',
    {
      query: z.string().describe('Query content — describe what you want to find in natural language'),
      limit: z.number().int().min(1).max(20).optional().default(8).describe('Number of results to return, default 8. Hard-capped at 20 by the recall contract; larger values are silently clamped.'),
      category: z.enum(['general', 'people', 'project', 'decision', 'feedback', 'bug', 'relationship', 'skill', 'preference']).optional().describe('Filter by category (optional)'),
    },
    async ({ query, limit = 8, category }) => {
      const ctx = await buildMemoryContext({
        query,
        memoryLimit: limit,
      })
      if (!ctx) {
        return { content: [{ type: 'text', text: '(no relevant memories found)' }] }
      }
      return { content: [{ type: 'text', text: ctx }] }
    }
  )

  s.tool(
    'get_recall_trace',
    'Inspect a bounded recall trace by trace-id. Returns content-free query metadata, candidate/filter counts, and the exact memory rowids exposed to the caller.',
    {
      trace_id: z.string().min(1).describe('Trace id emitted in the memory-citation-contract block'),
    },
    async ({ trace_id }) => {
      const trace = getRecallTrace(trace_id)
      return {
        content: [{
          type: 'text',
          text: trace ? JSON.stringify(trace, null, 2) : '(recall trace not found)',
        }],
      }
    }
  )

  s.tool(
    'validate_memory_references',
    'Validate a generated answer against the exact memory IDs exposed by one recall trace. Preserves allowed [id:N] citations and strips fabricated or out-of-trace IDs. A missing trace fails closed.',
    {
      trace_id: z.string().min(1).describe('Trace id emitted in the memory-citation-contract block'),
      text: z.string().max(100_000).describe('Generated text whose [id:N] citations should be validated'),
    },
    async ({ trace_id, text }) => ({
      content: [{
        type: 'text',
        text: JSON.stringify(validateMemoryReferences(text, trace_id), null, 2),
      }],
    })
  )

  // ── Tool: store_memory ──────────────────────────────────────
  s.tool(
    'store_memory',
    'Store important information in the agent\'s long-term memory. New preferences, decisions, key facts, and user feedback should be stored promptly. Default to semi_abstract; reserve meta_knowledge for genuinely cross-context heuristics (test: would it help in a completely unrelated project?). meta_knowledge with concrete bindings (project name / ISO date / memory rowid ref / commit hash / absolute path) is auto-downgraded to semi_abstract — the response shows the reasons so you can adjust wording next time. Importance is a weak prior for recall display ranking, NOT an input to decay / auto-forget — retention emerges from access_count / recency. The store also surfaces a near-duplicate warning when content closely matches an existing memory; supersede that one instead of duplicating. When you pass supersedes, write the FULL new version, not just what changed — supersede replaces the old entry wholesale, and a shrink warning tells you which URLs / env vars / API routes / file paths the new text stopped carrying.',
    {
      content: z.string().describe('Content to remember'),
      summary: z.string().optional().describe('One-line summary (optional)'),
      importance: z.number().min(1).max(10).optional().default(6).describe('Importance 1-10, default 6'),
      memory_type: z.enum(['working', 'short_term', 'long_term', 'permanent']).optional().default('long_term').describe('Retention level, default long_term'),
      memory_level: z.enum(['concrete_trace', 'semi_abstract', 'meta_knowledge']).optional().default('semi_abstract').describe('Abstraction level (Memory Transfer Learning): concrete_trace = specific operation logs (low recall weight, prone to negative transfer) / semi_abstract = semi-abstract description (default) / meta_knowledge = patterns/heuristics (high recall weight, most effective cross-context)'),
      category: z.enum(['general', 'people', 'project', 'decision', 'feedback', 'bug', 'relationship', 'skill', 'preference']).optional().default('general').describe('Category'),
      tags: z.array(z.string()).optional().describe('Tag list'),
      supersedes: z.array(z.string()).optional().describe('Old memory rowids this entry replaces (string array, e.g. ["325","348"]). Old rows soft-deleted by next expireMemories run; their content/summary chained into this row\'s prior_versions[] for paper trail. Preferred over the deprecated string convention in summary text.'),
      event_time: z.union([z.number(), z.string()]).optional().describe('When the event ACTUALLY happened (ISO 8601 string or ms timestamp). Distinct from created_at (when it was recorded). Lets temporal recall match "what did I do last June?" by event_time, not record time. Optional — defaults to NULL (recall falls back to created_at).'),
      is_anchor: z.boolean().optional().describe('Mark as anchor: identity/permanent-rule level. Hard-capped at 40 memories globally. If quota exhausted, the flag is silently dropped (memory still stored) and the response notes it — unpin another anchor first if you really need this one.'),
      is_pinned: z.boolean().optional().describe('Mark as pinned: recall floor / high-signal reference. Hard-capped at 30 memories globally. Same quota-drop semantics as is_anchor. Use for the handful of memories you always want surfaced — importance 1-10 alone is a weak prior and inflates.'),
    },
    async ({ content, summary, importance = 6, memory_type = 'long_term', memory_level = 'semi_abstract', category = 'general', tags = [], supersedes, event_time, is_anchor, is_pinned }) => {
      const out = {}

      // v2.9: not-yet-trusted hosts write into quarantine — a separate table
      // the recall pool never reads. Requested supersedes are recorded but
      // execute only if the reviewer approves.
      if (QUARANTINE_HOSTS.has(hostId)) {
        const qid = storeMemoryQuarantined({
          content, summary, importance,
          memoryType: memory_type,
          memoryLevel: memory_level,
          category,
          source: 'conversation',
          sourceHost: hostId,
          tags, supersedes,
          eventTime: event_time,
        }, { out })
        if (!qid) return { content: [{ type: 'text', text: 'Quarantine storage failed' }] }
        let qtext = `🔒 Quarantined (qid: ${qid}, host: ${hostId}) — pending review by '${PRIMARY_HOST}'. Not recallable until approved.`
        if (is_anchor || is_pinned) qtext += `\n(anchor/pinned flags are dropped for quarantined writes — the reviewer can re-add them after merge)`
        if (out.encodingWarning) {
          const e = out.encodingWarning
          qtext += `\n⚠️ ENCODING DAMAGE: ${e.qmarkCount} '?' chars (longest run ${e.maxRun}). CJK was likely lost to a non-UTF-8 code page (cp936) — this is IRREVERSIBLE, not a display glitch. If you just wrote Chinese, it did NOT save; re-store via a UTF-8-safe path (codex exec / CC-side), not Codex Desktop.`
        }
        if (out.metaDowngrade) {
          qtext += `\n📉 meta_knowledge → semi_abstract (write-gate: content has concrete bindings)`
            + `\n   reasons: ${out.metaDowngrade.reasons.join(' | ')}`
        }
        return { content: [{ type: 'text', text: qtext }] }
      }

      const id = await storeMemoryAsync({
        content,
        summary,
        importance,
        memoryType: memory_type,
        memoryLevel: memory_level,
        category,
        source: 'conversation',
        tags,
        supersedes,
        eventTime: event_time,
        isAnchor: is_anchor,
        isPinned: is_pinned,
        sourceHost: hostId,
      }, { out })

      if (!id) {
        return { content: [{ type: 'text', text: 'Storage failed' }] }
      }

      const finalLevel = out.metaDowngrade?.toLevel || memory_level
      const flags = []
      if (is_anchor && !out.quotaRejected?.find(q => q.flag === 'is_anchor')) flags.push('anchor')
      if (is_pinned && !out.quotaRejected?.find(q => q.flag === 'is_pinned')) flags.push('pinned')
      const flagStr = flags.length ? `, flags: [${flags.join(', ')}]` : ''
      let text = `Stored memory (id: ${id}, importance: ${importance}, type: ${memory_type}, level: ${finalLevel}${flagStr})`
      // First among the warnings on purpose: the others say a policy adjusted the
      // write, this one says the content that landed is already damaged.
      if (out.encodingWarning) {
        const e = out.encodingWarning
        text += `\n⚠️ ENCODING DAMAGE: ${e.qmarkCount} '?' chars (longest run ${e.maxRun}). CJK was likely lost to a non-UTF-8 code page (cp936) — this is IRREVERSIBLE, not a display glitch. If you just wrote Chinese, it did NOT save; re-store via a UTF-8-safe path (codex exec / CC-side), not Codex Desktop.`
      }
      if (out.quotaRejected?.length) {
        for (const q of out.quotaRejected) {
          text += `\n🚫 ${q.flag} quota exhausted (${q.current}/${q.limit}) — flag dropped, memory still stored`
        }
        text += `\n   to make room: recall an existing ${out.quotaRejected[0].flag} row and clear its flag with a direct sql UPDATE`
      }
      if (out.metaDowngrade) {
        text += `\n📉 meta_knowledge → semi_abstract (write-gate: content has concrete bindings)`
          + `\n   reasons: ${out.metaDowngrade.reasons.join(' | ')}`
          + `\n   next time: extract the cross-project heuristic without the specific name/date/id, or accept semi_abstract`
      }
      if (out.supersedeShrink?.length) {
        text += `\n⚠️ supersede shrink — the new version dropped things the old one carried:`
        for (const w of out.supersedeShrink.slice(0, 3)) {
          text += `\n  #${w.id}: ${w.oldLen}B → ${w.newLen}B (${Math.round(w.ratio * 100)}%)`
          if (w.droppedCount) {
            const shown = w.dropped.slice(0, 6).join(', ')
            text += `\n    dropped: ${shown}${w.droppedCount > 6 ? ` …+${w.droppedCount - 6} more` : ''}`
          }
        }
        text += `\n   supersede replaces the old entry wholesale. prior_versions keeps the paper trail,`
          + `\n   but FTS only indexes content/summary/tags — dropped facts become unrecallable.`
          + `\n   intentional split/consolidation? ignore. otherwise re-store the full text,`
          + `\n   or move the volatile part (counts, progress) into its own memory.`
      }
      if (out.nearDuplicates?.length) {
        const top = out.nearDuplicates.slice(0, 3)
        text += `\n⚠️ near-duplicate(s) detected — consider superseding instead of a new entry:\n`
          + top.map(d => `  #${d.id} (cos ${d.cosine}) ${d.summary}`).join('\n')
          + `\n(if this updates one of them, re-store with supersedes:["${top[0].id}"])`
      }
      return { content: [{ type: 'text', text }] }
    }
  )

  // ── Tool: recall_by_id ──────────────────────────────────────
  s.tool(
    'recall_by_id',
    'Retrieve specific memories by their rowid(s). Use when you have an id from a previous recall_memory hit and want the full content (not the truncated preview), when you need to inspect a memory before supersede/merge/audit operations, or when following prior_versions[].source_rowid pointers. Returns raw content + summary + full metadata with no truncation; does NOT increment access_count.',
    {
      ids: z.array(z.union([z.number(), z.string()])).describe('Memory rowid(s) to fetch (numbers or numeric strings)'),
      include_deleted: z.boolean().optional().default(false).describe('Include soft-deleted memories. Default false. Use true for audit / prior_versions chain inspection.'),
    },
    async ({ ids, include_deleted = false }) => {
      const rows = getMemoriesByIds(ids, { includeDeleted: include_deleted })
      if (rows.length === 0) {
        return { content: [{ type: 'text', text: '(no memories found for the given ids)' }] }
      }
      const text = rows.map(r => {
        const tags = r.tags?.length ? ` [${r.tags.join(', ')}]` : ''
        const priors = r.prior_versions?.length ? ` (${r.prior_versions.length} prior versions)` : ''
        return `[id:${r.rowid} ★${r.importance} ${r.memory_type} ${r.memory_level}${r.source_host ? ` host:${r.source_host}` : ''}]${tags}${priors}\n${r.summary ? '📌 ' + r.summary + '\n' : ''}${r.content}`
      }).join('\n\n---\n\n')
      return { content: [{ type: 'text', text }] }
    }
  )

  // ── Tool: review_quarantine (migration 012) ──────────────────────────
  // All hosts can list; non-primary sessions are locked to their OWN rows
  // (covers "what did I just store?" continuity on the quarantined side).
  s.tool(
    'review_quarantine',
    'List quarantined memories (writes from not-yet-trusted hosts, invisible to recall until approved). Primary host sees all hosts and full content for review; other hosts see only their own entries. Use resolve_quarantine to approve/reject (primary host only).',
    {
      status: z.enum(['pending', 'approved', 'rejected', 'all']).optional().default('pending').describe('Filter by review status, default pending'),
      limit: z.number().optional().default(5).describe('Max entries (full content is shown for review quality — keep small), default 5'),
    },
    async ({ status = 'pending', limit = 5 }) => {
      const isPrimary = hostId === PRIMARY_HOST
      const rows = listQuarantine({ status, host: isPrimary ? undefined : hostId, limit })
      if (rows.length === 0) {
        return { content: [{ type: 'text', text: `(quarantine: no ${status} entries${isPrimary ? '' : ` for host '${hostId}'`})` }] }
      }
      const now = Date.now()
      const text = rows.map(r => {
        const ageH = Math.floor((now - r.created_at) / 3600_000)
        const ageStr = ageH < 1 ? '<1h' : ageH < 48 ? `${ageH}h` : `${Math.floor(ageH / 24)}d`
        const tags = r.tags?.length ? ` [${r.tags.join(', ')}]` : ''
        const sup = r.supersedes_requested?.length
          ? `\n⚠ requests supersede of main-pool rowid(s): [${r.supersedes_requested.join(', ')}] — executes only on approve`
          : ''
        const reviewed = r.review_status !== 'pending'
          ? `\n→ ${r.review_status}${r.merged_rowid ? ` as main-pool id ${r.merged_rowid}` : ''}${r.review_note ? ` | note: ${r.review_note}` : ''}`
          : ''
        return `[qid:${r.qid} host:${r.source_host || '(null)'} ${r.review_status} ★${r.importance} ${r.memory_type} ${r.memory_level} ${ageStr} ago]${tags}${sup}${reviewed}\n${r.summary ? '📌 ' + r.summary + '\n' : ''}${r.content}`
      }).join('\n\n---\n\n')
      const footer = isPrimary && status === 'pending'
        ? `\n\n(review question per entry: would I have stored this? — judgment / importance anchor / stance / wording. resolve_quarantine(qid, approve|reject, note) to act; reject requires a note.)`
        : ''
      return { content: [{ type: 'text', text: text + footer }] }
    }
  )

  // ── Tool: resolve_quarantine (migration 012, PRIMARY HOST ONLY) ──────
  // Registration is gated on the session's channel-derived host — review
  // authority comes from the credential, not from a tool argument.
  if (hostId === PRIMARY_HOST) {
    s.tool(
      'resolve_quarantine',
      'Approve or reject a quarantined memory (primary host only). Approve moves it into the main pool preserving source_host provenance and the original created_at, then executes any requested supersedes. Reject requires a note — rejection reasons are part of the trust record that decides when a host graduates to direct writes.',
      {
        qid: z.union([z.number(), z.string()]).describe('Quarantine id from review_quarantine'),
        action: z.enum(['approve', 'reject']).describe('approve = merge into main pool; reject = keep out, record reason'),
        note: z.string().optional().describe('Review note. REQUIRED for reject (the reason feeds rejection-rate stats); optional for approve'),
      },
      async ({ qid, action, note }) => {
        if (action === 'reject' && !note?.trim()) {
          return { content: [{ type: 'text', text: '❌ reject requires a note — 驳回原因进信任统计，不能空着' }] }
        }
        const r = await resolveQuarantine(qid, { action, note })
        if (!r.ok) return { content: [{ type: 'text', text: `❌ ${r.error}` }] }
        if (r.action === 'rejected') {
          return { content: [{ type: 'text', text: `🚫 qid ${r.qid} rejected — reason recorded in trust stats` }] }
        }
        let t = `✅ qid ${r.qid} approved → main-pool id ${r.merged_rowid} (source_host + original created_at preserved)`
        if (r.metaDowngrade) {
          t += `\n📉 merged as semi_abstract (write-gate re-check): ${r.metaDowngrade.reasons.join(' | ')}`
        }
        return { content: [{ type: 'text', text: t }] }
      }
    )
  }

  // ── Tool: memory_stats ──────────────────────────────────────
  s.tool(
    'memory_stats',
    'View agent memory system statistics: total memories, layer distribution, conversations, active goals, health metrics.',
    {},
    async () => {
      const stats = getMemoryStats()
      const text = [
        `Total memories: ${stats.memories.total_active}`,
        `  working: ${stats.memories.working} | short_term: ${stats.memories.short_term} | long_term: ${stats.memories.long_term} | permanent: ${stats.memories.permanent}`,
        `Conversations: ${stats.conversations}`,
        `Active goals: ${stats.activeGoals}`,
        `Compression pressure: ${stats.compressionPressure} ${stats.compressionPressure > 1 ? '(warning: temporary memories piling up)' : '(normal)'}`,
        `Dead knowledge (30d unaccessed): ${stats.deadKnowledge}${stats.deadKnowledge > 10 ? ' (consider cleanup)' : ''}`,
        `Search misses (7d): ${stats.recentSearchMisses}${stats.recentSearchMisses > 5 ? ' (knowledge blind spots detected)' : ''}`,
        `Vector search: ${stats.embeddingConfigured ? 'configured' : 'not configured (FTS5 only)'}`,
      ].join('\n')
      return { content: [{ type: 'text', text }] }
    }
  )

  // ── Tool: resolve_path ──────────────────────────────────────
  // v2.8 locations layer: exact-match KV, separate from the RRF-ranked recall
  // path so that "which directory did I mean by X" gets a definite answer.
  s.tool(
    'resolve_path',
    'Resolve a short handle (name or alias) to its registered path. Use this BEFORE guessing a path, running Glob against a large root, or asking the user "where is X". Returns { name, path, kind, aliases, notes } or null. Exact-match — not FTS, not semantic. If null, either the alias is not registered yet (call set_path) or the user meant something else (fall back to recall_memory).',
    {
      name_or_alias: z.string().describe('Either the location primary name or one of its aliases'),
    },
    async ({ name_or_alias }) => {
      const row = getLocation(name_or_alias)
      if (!row) {
        return { content: [{ type: 'text', text: `(no location registered for "${name_or_alias}")` }] }
      }
      const al = row.aliases.length ? ` · aliases: ${row.aliases.join(', ')}` : ''
      const notes = row.notes ? `\nnotes: ${row.notes}` : ''
      return { content: [{ type: 'text', text: `${row.name} → ${row.path}  [${row.kind}]${al}${notes}` }] }
    }
  )

  // ── Tool: set_path ──────────────────────────────────────────
  s.tool(
    'set_path',
    'Register a path alias so future turns (and other sessions) can resolve it with resolve_path. Kinds: dir (default), file, glob_root, executable, url, other. `force: true` overwrites an existing name; without it, changing a registered path errors so you notice the conflict. `aliases` accepts alternate names that also resolve to this path.',
    {
      name: z.string().describe('Primary handle, e.g. "download", "godot", "workspace"'),
      path: z.string().describe('Absolute path or URL. mneme stores it verbatim; no expansion.'),
      kind: z.enum(['dir', 'file', 'glob_root', 'executable', 'url', 'other']).optional().default('dir').describe('What kind of location this is. `glob_root` signals "commonly globbed from"; `executable` marks something you spawn; `url` for docs/dashboards.'),
      aliases: z.array(z.string()).optional().describe('Alternate names that should also resolve to this path'),
      notes: z.string().optional().describe('Free-form remark (why this exists, what to remember about it)'),
      force: z.boolean().optional().describe('Overwrite an existing entry even if its path changed'),
    },
    async ({ name, path, kind = 'dir', aliases, notes, force }) => {
      try {
        const res = setLocation({ name, path, kind, aliases, notes, force })
        const al = res.aliases.length ? ` · aliases: ${res.aliases.join(', ')}` : ''
        const verb = res.created ? 'created' : 'updated'
        return { content: [{ type: 'text', text: `${verb} ${res.name} → ${res.path}  [${res.kind}]${al}` }] }
      } catch (e) {
        return { content: [{ type: 'text', text: `error: ${e.message}` }] }
      }
    }
  )

  // ── Tool: list_paths ────────────────────────────────────────
  s.tool(
    'list_paths',
    'List every registered path alias. Optionally filter by kind. Useful before setting a new alias (avoid duplicates) or when you want to remind yourself what handles exist.',
    {
      kind: z.enum(['dir', 'file', 'glob_root', 'executable', 'url', 'other']).optional().describe('Filter by kind'),
    },
    async ({ kind }) => {
      const rows = listLocations({ kind })
      if (rows.length === 0) {
        return { content: [{ type: 'text', text: '(no path aliases registered yet)' }] }
      }
      const w = Math.max(4, ...rows.map(r => r.name.length))
      const lines = rows.map(r => {
        const al = r.aliases.length ? ` · aliases: ${r.aliases.join(', ')}` : ''
        return `  ${r.name.padEnd(w)}  [${r.kind}]  ${r.path}${al}`
      })
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    }
  )

  // ── Tool: delete_path ───────────────────────────────────────
  s.tool(
    'delete_path',
    'Remove a registered path alias by primary name. Returns whether a row was actually removed.',
    {
      name: z.string().describe('Primary name to remove (aliases follow the row and are removed with it)'),
    },
    async ({ name }) => {
      const removed = deleteLocation(name)
      return { content: [{ type: 'text', text: removed ? `removed ${name}` : `no location named "${name}"` }] }
    }
  )

  return s
}

// ── Transport selection ─────────────────────────────────────
// Default: stdio (legacy, one mcp-server per cc session spawn).
// `--transport=http --port=18792`: HTTP Streamable, single daemon-managed
// instance shared by all cc clients (recommended for production).
const args = process.argv.slice(2)
const useHttp = args.includes('--transport=http')
const portArg = args.find(a => a.startsWith('--port='))
const PORT = portArg ? parseInt(portArg.split('=')[1], 10) : 18792
const HOST = '127.0.0.1' // Hard-bind localhost only (per MCP spec, prevents DNS rebinding)

let httpServer = null

const gracefulExit = (reason) => {
  try { if (httpServer) httpServer.close() } catch {}
  try { closeMemory() } catch {}
  process.exit(0)
}

// Session idle cleanup (2026-05-27 加，cover onsessionclosed 不 fire 导致的 leak)
// 短命 cc/hook 进程退出时不通知 server，依赖 idle timeout 兜底
const SESSION_IDLE_MS = 10 * 60 * 1000   // 10 min 没请求视为 client 已退出
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000  // 每分钟扫一次

if (useHttp) {
  // ── HTTP transport (stateful, per-session transport map) ───────
  // Multi-client: each cc client gets its own transport instance keyed by sessionId
  //   - First init request: sessionIdGenerator assigns a uuid, transport added to map
  //   - Subsequent requests carry Mcp-Session-Id header → look up transport in map
  //   - SDK note: stateless mode requires fresh transport per request (high overhead),
  //     so we go stateful here.
  const sessions = new Map() // sessionId → { transport, server, lastUsed }

  httpServer = http.createServer(async (req, res) => {
    // Origin check: only localhost allowed (MCP spec hard requirement)
    const origin = req.headers.origin
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Forbidden origin')
      return
    }
    // Health check endpoint (independent of MCP protocol)
    if (req.url === '/health' && req.method === 'GET') {
      const now = Date.now()
      let idleCount = 0
      for (const entry of sessions.values()) {
        if (now - entry.lastUsed > SESSION_IDLE_MS) idleCount++
      }
      // Expose embedding config + vector coverage so watchdogs can alert
      // proactively instead of waiting for someone to run memory_stats.
      let embeddingConfigured = null, vectorCoverage = null
      try { const st = getMemoryStats(); embeddingConfigured = st.embeddingConfigured; vectorCoverage = st.vectorCoverage } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true, server: SERVER_NAME, version: SERVER_VERSION, transport: 'http',
        active_sessions: sessions.size,
        idle_pending_cleanup: idleCount,
        idle_timeout_ms: SESSION_IDLE_MS,
        embeddingConfigured,
        vectorCoverage,
      }))
      return
    }

    // ── POST /recall — plain-JSON recall for out-of-process callers ──
    // The auto-recall hooks used to shell out to `node index.mjs --recall` on
    // every prompt and matching tool call. Measured on a warm 8k-row DB: the
    // query itself is ~6ms, the surrounding node startup (boot, DB open,
    // sqlite-vec + tokenizer extension load, embedding config) is ~1585ms —
    // 99.6% of the wall time, on the critical path before the model sees the
    // prompt. This server already holds all of that warm, so the same recall
    // costs a local round trip instead.
    //
    // Deliberately NOT MCP: a hook is a 30-line script that should not have to
    // speak a session-oriented protocol to ask one question.
    if (req.url === '/recall' && req.method === 'POST') {
      const auth = resolveHost(req.headers['authorization'], HOST_TOKENS, { mode: AUTH_MODE, defaultHost: DEFAULT_HOST })
      if (!auth.ok) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Unauthorized: ${auth.reason}` }))
        return
      }
      let body = ''
      let tooBig = false
      req.on('data', chunk => {
        body += chunk
        // A recall query is a sentence. Anything past this is a client bug or
        // an attempt to make the server hold a large buffer.
        if (body.length > 64 * 1024) { tooBig = true; req.destroy() }
      })
      req.on('end', async () => {
        if (tooBig) return
        try {
          const p = JSON.parse(body || '{}')
          if (typeof p.query !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'query (string) is required' }))
            return
          }
          const result = await recallForClients({
            query: p.query,
            limit: Number.isFinite(p.limit) ? p.limit : 10,
            minImportance: Number.isFinite(p.min_importance) ? p.min_importance : 0,
            levels: Array.isArray(p.levels) ? p.levels : (typeof p.level === 'string' && p.level ? p.level.split(',') : []),
            requireVec: !!p.require_vec,
            // Provenance stays channel-derived: the caller may label WHICH hook
            // it is, but the host comes from the token, never from the body.
            source: typeof p.source === 'string' ? p.source.slice(0, 64) : 'http',
            sessionId: typeof p.session_id === 'string' ? p.session_id.slice(0, 128) : null,
          })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    // MCP endpoint
    if (req.url === '/mcp' || req.url?.startsWith('/mcp?')) {
      try {
        // migration 011: resolve the writing host from the bearer token BEFORE
        // touching sessions. In enforce mode a missing/unknown token is a hard
        // 401; in soft/off mode it falls back to DEFAULT_HOST so existing
        // untokened clients keep working during rollout.
        const auth = resolveHost(req.headers['authorization'], HOST_TOKENS, { mode: AUTH_MODE, defaultHost: DEFAULT_HOST })
        if (!auth.ok) {
          res.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Bearer realm="mneme"' })
          res.end(`Unauthorized: ${auth.reason}`)
          return
        }

        const sessionId = req.headers['mcp-session-id']
        let entry = sessionId ? sessions.get(sessionId) : null
        if (entry) {
          entry.lastUsed = Date.now()  // 复用 session：刷新活跃时间
          // A session's host is bound at creation and every write on it is stamped
          // with that host. If a later request on the same session presents a token
          // mapping to a different host, the binding and the evidence disagree —
          // exactly the case channel-derived provenance exists to prevent. Reject
          // under enforce; keep the binding but say so loudly otherwise, because
          // the silent version is provenance drifting with no signal at all.
          if (auth.authed && entry.host !== auth.host) {
            if (AUTH_MODE === 'enforce') {
              res.writeHead(401, { 'Content-Type': 'text/plain' })
              res.end(`Unauthorized: session bound to host '${entry.host}', token maps to '${auth.host}'`)
              return
            }
            console.error(`[mneme] host mismatch on session ${String(sessionId).slice(0, 8)}: bound=${entry.host}, token=${auth.host} (keeping binding)`)
          }
        }

        if (!entry) {
          // New session: open transport + connect a fresh server instance
          // Note: a single McpServer instance shared across multiple transports
          // is unsafe for tool registry (SDK design), so each session gets a new
          // server with the same tools registered.
          const newServer = createServer(auth.host || DEFAULT_HOST)
          const newTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              sessions.set(newSessionId, { transport: newTransport, server: newServer, lastUsed: Date.now() })
              console.error(`[mneme] session opened: ${newSessionId.slice(0, 8)} (total=${sessions.size})`)
            },
            onsessionclosed: (closedSessionId) => {
              sessions.delete(closedSessionId)
              console.error(`[mneme] session closed: ${closedSessionId.slice(0, 8)} (total=${sessions.size})`)
            },
          })
          await newServer.connect(newTransport)
          entry = { transport: newTransport, server: newServer, lastUsed: Date.now() }
        }
        await entry.transport.handleRequest(req, res)
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end(`MCP transport error: ${e.message}`)
        }
        console.error(`[mneme] handler error: ${e.message}`)
      }
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  })

  httpServer.listen(PORT, HOST, () => {
    console.error(`[mneme] HTTP MCP server listening on http://${HOST}:${PORT}/mcp (PID ${process.pid})`)
    console.error(`[mneme] Health: http://${HOST}:${PORT}/health`)
    console.error(`[mneme] Session idle cleanup: ${SESSION_IDLE_MS / 60000}min timeout, scan every ${SESSION_CLEANUP_INTERVAL_MS / 1000}s`)
  })

  // Idle session cleanup interval — kicks dead transports out of sessions Map
  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    let cleaned = 0
    for (const [id, entry] of sessions) {
      if (now - entry.lastUsed > SESSION_IDLE_MS) {
        try { entry.transport?.close?.() } catch {}
        sessions.delete(id)
        cleaned++
      }
    }
    if (cleaned > 0) {
      console.error(`[mneme] idle cleanup: -${cleaned} sessions, ${sessions.size} remaining`)
    }
  }, SESSION_CLEANUP_INTERVAL_MS)
  cleanupTimer.unref?.()  // 不阻止 process exit

  const httpGracefulExit = (reason) => {
    try { clearInterval(cleanupTimer) } catch {}
    gracefulExit(reason)
  }
  process.on('SIGINT', () => httpGracefulExit('SIGINT'))
  process.on('SIGTERM', () => httpGracefulExit('SIGTERM'))
  process.on('SIGHUP', () => httpGracefulExit('SIGHUP'))
} else {
  // ── stdio transport (legacy fallback) ────────────────────────
  const stdioServer = createServer()
  const transport = new StdioServerTransport()
  await stdioServer.connect(transport)

  // Guard: cc session exits typically just close stdio without sending signals,
  // so we must listen for stdin end/close to actively exit. Otherwise mcp-server
  // processes pile up as zombies (2026-04-27 实证 13 并发 → engram.db 锁竞争 →
  // MCP disconnected). HTTP mode avoids this entirely (single daemon-managed instance).
  process.on('SIGINT', () => gracefulExit('SIGINT'))
  process.on('SIGTERM', () => gracefulExit('SIGTERM'))
  process.on('SIGHUP', () => gracefulExit('SIGHUP'))
  process.stdin.on('end', () => gracefulExit('stdin-end'))
  process.stdin.on('close', () => gracefulExit('stdin-close'))
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') gracefulExit('stdout-EPIPE')
  })
}
