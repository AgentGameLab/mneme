#!/usr/bin/env node
// ============================================================
// mneme MCP Server v2.5.0
// Exposes recall_memory / store_memory / recall_by_id / memory_stats tools
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
  storeMemoryAsync,
  buildMemoryContext,
  getMemoryStats,
  embedMissingVectors,
  indexSessionTranscripts,
  closeMemory,
} from './index.mjs'

// ── Load .env.local BEFORE initMemory() ────────────────────────────────
// [2026-05-29 千夏] 根因修复：常驻 HTTP MCP server 由 watchdog spawn，
// 子进程 env 不含 .env.local，导致 initMemory() 读不到 EMBEDDING_API_*，
// _embeddingConfig=null → 语义召回静默降级回 FTS5（实测掉线 6 周）。
// daemon.mjs 本来就 load .env.local，但 MCP server 进程是独立的，必须自己 load。
// 不依赖谁来 spawn / 是否注入 env，进程自给自足最鲁棒。
// 写法照搬 daemon.mjs:155-164（含 CRLF \r? 兼容）。
const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dirname, '..', '.env.local')  // memory/ 的上一级 = chinatsu-workspace/
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*?)\r?$/)
    // 已存在的 env 优先（允许 launcher 显式覆盖），只补缺失项
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
  })
}

// Initialize memory system once at startup
initMemory()

// [2026-05-29 千夏] 启动自愈 sweep：补宕机/降级期间漏写的 NULL 向量。
// fire-and-forget，不阻塞 server 启动；无 embedding 配置时内部直接 no-op。
// 配合 .env.local 加载（上方）+ store_memory 走 storeMemoryAsync，
// 让"绕过 async 写入路径导致永久缺向量"这条漏在每次重启时被兜住。
embedMissingVectors(500).then(r => {
  if (r.embedded || r.failed) console.error(`[mneme] startup self-heal: embedded ${r.embedded}, failed ${r.failed}, scanned ${r.scanned}`)
}).catch(e => console.error(`[mneme] startup self-heal failed: ${e.message}`))

const SERVER_NAME = 'mneme'
const SERVER_VERSION = '2.5.0'

// ── Factory: each call returns a fresh McpServer with all 4 tools registered ──
// Why factory: HTTP stateful multi-client mode requires per-session McpServer
// (SDK design: transport ↔ server is 1:1, sharing tool registry across transports
// is unsafe). Stdio mode also calls createServer() once for symmetry.
function createServer() {
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
      limit: z.number().optional().default(8).describe('Number of results to return, default 8'),
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

  // ── Tool: store_memory ──────────────────────────────────────
  s.tool(
    'store_memory',
    'Store important information in the agent\'s long-term memory. New preferences, decisions, key facts, and user feedback should be stored promptly. Default to semi_abstract; reserve meta_knowledge for genuinely cross-context heuristics (test: would it help in a completely unrelated project?). Importance is a weak prior, not a ranking lever — true salience emerges from recall frequency. The store surfaces a near-duplicate warning when content closely matches an existing memory; supersede that one instead of duplicating.',
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
    },
    async ({ content, summary, importance = 6, memory_type = 'long_term', memory_level = 'semi_abstract', category = 'general', tags = [], supersedes, event_time }) => {
      const out = {}
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
      }, { out })

      if (!id) {
        return { content: [{ type: 'text', text: 'Storage failed' }] }
      }

      let text = `Stored memory (id: ${id}, importance: ${importance}, type: ${memory_type}, level: ${memory_level})`
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
        return `[id:${r.rowid} ★${r.importance} ${r.memory_type} ${r.memory_level}]${tags}${priors}\n${r.summary ? '📌 ' + r.summary + '\n' : ''}${r.content}`
      }).join('\n\n---\n\n')
      return { content: [{ type: 'text', text }] }
    }
  )

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
      // [2026-05-29 千夏] 暴露 embedding 配置 + 向量覆盖率，供 watchdog 主动告警
      // （静默降级元修复：不靠人偶然调 memory_stats 才发现 'FTS5 only'）。
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
    // MCP endpoint
    if (req.url === '/mcp' || req.url?.startsWith('/mcp?')) {
      try {
        const sessionId = req.headers['mcp-session-id']
        let entry = sessionId ? sessions.get(sessionId) : null
        if (entry) entry.lastUsed = Date.now()  // 复用 session：刷新活跃时间

        if (!entry) {
          // New session: open transport + connect a fresh server instance
          // Note: a single McpServer instance shared across multiple transports
          // is unsafe for tool registry (SDK design), so each session gets a new
          // server with the same tools registered.
          const newServer = createServer()
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
