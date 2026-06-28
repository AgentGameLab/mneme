# mneme

> **Save 80-90% memory-related token costs.** Persistent long-term memory for AI agents via MCP — on-demand recall instead of always-inject.  
> **Works with any MCP-compatible agent**: Claude Code, Cursor, Windsurf, Cline, Continue, and more.

[English](README.md) · [中文](README.zh-CN.md)

---

## The Problem: Memory Costs Tokens

AI agents are stateless. The common fix is injecting a context file on every prompt — but that means you pay token costs on **every single message**, even when the agent already knows the answer.

**How much does this waste?**

| Approach | Token cost per message | 100 messages/day |
|----------|----------------------|------------------|
| Pre-injection (always inject) | ~2,000-5,000 tokens | 200K-500K tokens/day |
| **mneme (on-demand)** | **0 tokens (most messages)** | **~20K-50K tokens/day** |

Most prompts don't need historical memory. mneme lets the agent decide when to look things up — saving **80-90% of memory-related token costs**.

---

## What's New in v2.0

### Memory Transfer Learning

Inspired by research on cross-context memory reuse (arxiv 2604.14004), memories now have 3 abstraction tiers:

| Level | Recall Weight | Description | Example |
|-------|--------------|-------------|---------|
| `meta_knowledge` | 1.3x | Patterns, heuristics, reusable principles | "When X happens, do Y" |
| `semi_abstract` | 1.0x | Semi-abstract with some context (default) | "Project X uses approach Y because Z" |
| `concrete_trace` | 0.7x | Specific operation logs | "On 04-16, ran migration script" |

**Key insight**: Concrete traces have low cross-context reuse value and can cause negative transfer. The system automatically weights meta-knowledge higher during recall, so distilled patterns surface above raw event logs.

### sqlite-vec Hybrid Search (FTS5 + KNN + RRF)

When configured with an embedding API, mneme now runs **dual-path retrieval**:

1. **FTS5 path**: Keyword/lexical matching (fast, exact)
2. **Vector path**: Semantic matching via sqlite-vec KNN (synonyms, paraphrases)
3. **RRF fusion**: Reciprocal Rank Fusion merges both result sets fairly using only rank positions (no scale normalization needed)

Falls back gracefully to FTS5-only when sqlite-vec or embedding API is not configured.

**Performance**: ~150ms total (FTS5 <10ms + one embedding API call ~120ms). sqlite-vec KNN is sub-millisecond locally.

### Compression Pipeline

Old conversation segments can be automatically compressed into summary memories:

- Uses a fast LLM (e.g., Claude Haiku) for summarization
- Tracks `compressed_from` source rowids for traceability
- Anti-cascade protection: compressed memories cannot be re-compressed (prevents hallucination amplification)
- Triggers: CLI command, hooks, or manual invocation

**Note**: In practice, we find that ingesting compact summaries from Claude Code's built-in `/compact` feature (via the SessionStart hook) is simpler and more effective than running a separate compression pipeline. Both approaches are supported.

### Compact Summary Ingestion

mneme can ingest summaries from Claude Code's `/compact` feature:

```bash
# Triggered by SessionStart hook when source=compact
TOKENMEM_COMPACT_SUMMARY="..." TOKENMEM_COMPACT_SESSION="session-id" \
  node index.mjs --store-compact-summary
```

This captures session knowledge automatically when Claude Code compacts context, creating a durable long-term memory from what would otherwise be lost.

### Breaking Changes

- `buildMemoryContext()` is now **async** (returns `Promise<string>`)
- `storeMemoryAsync()` now writes to the sqlite-vec virtual table when available
- New `memory_level` parameter in MCP `store_memory` tool
- DB path configurable via `TOKENMEM_DB_PATH` environment variable

---

## What's New in v2.1 (Memory Hygiene)

Three mechanisms borrowed from memory-decay literature, adapted to the **memory health layer only** — no prompt injection, no mood state machines, no persona modeling. The goal is "make memory ranking realistic over time", not "give the AI feelings".

### Power-Law Decay

Every memory now has a `decay_score` that updates periodically based on age, importance, and reuse:

```
w(t)  = (1 + t / τ)^(-b_eff)        τ = 24h,  b_base = 0.7
b_eff = b_base / (1 + importance / 10)
decay = min(1.0, w × (1 + min(10, access_count) × 0.3))
```

- High-importance + frequently-recalled records stay near **1.0** (reuse boost saves them)
- Low-importance + untouched records decay to **~0.2** over a few weeks — but **never disappear**. They still get queried, just rank lower.

Run via `runDecayCycle()` from a maintenance daemon's interval, alongside `expireMemories()` / `promoteMemories()`. CLI: there is no separate script — call from your own daemon or `setInterval`.

Recall scoring (both FTS and hybrid paths) now multiplies by `decay_score`, so naturally-fresh records bubble up without manual TTL tuning. Records that haven't been through a cycle default to `1.0` (backward-compatible).

### Surfaced Random Recall ("I Just Remembered")

When `recall_memory` returns fewer records than requested, there's a **25% chance** of pulling 1-3 records from the **cold pool**:

- `importance >= 8` (genuinely valuable, not noise)
- Last accessed > 30 days ago (truly cold)
- `decay_score >= 0.3` (not utterly buried)

Surfaced records carry `recall_source: 'surfaced_random'` so callers can distinguish them from query matches. `buildMemoryContext()` marks them with `[surfaced]` in the output.

This counters the "long tail of high-value memories that decay below the top of normal ranking" problem — useful patterns from months ago can resurface unprompted, modeling the "I just remembered" feeling.

### Supersede Paper Trail

When `store_memory` is called with a `supersedes` array (rowid strings of old records), the new record now:

1. **Inherits** the old records' `prior_versions[]` (chained absorption — full history preserved across multiple supersede generations: v1 → v2 → v3 keeps the v1 content too)
2. **Pushes** the old records' `content` / `summary` / `created_at` into its own `prior_versions[]`
3. **Updates** old records' `superseded_by` pointer (existing soft-link mechanism preserved)
4. `expireMemories()` soft-deletes the old chain on its next pass

Recall returns only the **latest** content. `prior_versions[]` (stored as JSON) is queryable for audit / root-cause / "what did I previously think?" analysis. No history loss when retracting.

### Migrations Directory

Schema changes are now versioned in `migrations/`:

```
migrations/
├── 001-add-superseded-by.sql        # supersede pointer column (paper trail prerequisite)
├── 003-add-decay-and-priors.sql     # decay_score + prior_versions + cold-pool index
└── 004-add-dedup-and-event-time.sql # content_hash dedup + event_time (v2.2)
```

Apply in order against an existing `tokenmem.db` for auditing. **Fresh installs don't need to run these by hand** — `initMemory()` applies the column additions inline (idempotent `ALTER TABLE` in try/catch). The schema is forward-compatible — pre-migration records get default values (`decay_score = 1.0`, `prior_versions = '[]'`) so existing recall calls keep working.

### Stronger Database Backup Protection

`.gitignore` now covers `*.db.bak` / `*.db.bak-*` / `*.db.bak.*` patterns — previous versions only blocked `*.db.backup-*` which let date-suffixed backups slip through accidentally.

---

## What's New in v2.2

### HTTP Streamable Transport (single shared daemon)

In addition to the default stdio transport (one server process per client), mneme can now run as a **single long-lived HTTP server** shared by all clients:

```bash
node mcp-server.mjs --transport=http --port=18792
```

Why: when N agent sessions each spawn their own stdio `mcp-server` process, they contend on the same SQLite WAL and can pile up into zombie processes. One daemon-managed HTTP instance with a single SQLite connection roots that out. Exposes `GET /health` (returns `embeddingConfigured` + `vectorCoverage` so a supervisor can detect a silently-degraded vector path).

### Store-Time Dedup + `event_time`

- **`content_hash` dedup**: a 5-minute window stops agents that retry-store the same content from bloating the table — the existing row's `access_count` is bumped instead, preserving the "told you already" signal.
- **`event_time`**: when the event *actually happened*, distinct from `created_at` (when it was recorded) — lets recall do temporal reasoning ("what did I do last June?") even for memories recorded later.

### `recall_by_id`

Fetch exact memories by rowid (CLI + MCP tool), without bumping `access_count` — for citation / audit / "show me memory #N" without polluting the recall-frequency signal.

---

## How It Works

```
┌────────────────────────────────────────────────┐
│           Any MCP-Compatible Agent             │
│      (Claude Code / Cursor / Windsurf / ...)   │
│                                                │
│  User prompt → "Do I already know this?"       │
│                     │                          │
│              ┌──────┴──────┐                   │
│              ↓ Yes         ↓ No                │
│         Answer directly    recall_memory()     │
│         (0 extra tokens)       ↓               │
│                          MCP Server            │
│                              ↓                 │
│                    FTS5 + sqlite-vec KNN       │
│                    + RRF fusion scoring        │
│                       (tokenmem.db)            │
│                              ↓                 │
│                    ← ranked results            │
│                                                │
│  store_memory("important fact",                │
│    level: "meta_knowledge") → MCP Server       │
│                                      ↓         │
│                     INSERT + embedding → vec   │
└────────────────────────────────────────────────┘
```

**MCP tools exposed:**

| Tool | Purpose |
|------|---------|
| `recall_memory(query, limit?, category?)` | Hybrid search: FTS5 + vector KNN + RRF fusion scoring |
| `store_memory(content, level?, ...)` | Store with abstraction level (meta_knowledge / semi_abstract / concrete_trace) |
| `recall_by_id(ids)` | Fetch exact memories by rowid (no access_count bump) — citation / audit |
| `memory_stats()` | Stats including compression pressure, dead knowledge, search miss rate, vector coverage |

---

## Why MCP Makes This Universal

mneme is a standard **MCP server**, supporting both **stdio** (default, one process per client) and **HTTP Streamable** transport (`--transport=http`, a single shared daemon). Any AI agent or IDE that supports the [Model Context Protocol](https://modelcontextprotocol.io/) can connect to it — no code changes needed.

**Tested with:**

| Agent | Setup |
|-------|-------|
| Claude Code | `claude mcp add --scope user mneme -- node /path/to/mcp-server.mjs` |
| Cursor | Add to `.cursor/mcp.json` |
| Windsurf | Add to MCP server config |
| Cline / Continue | Add to MCP settings |

---

## Features

### Memory Layers with Auto-Promotion

| Layer | TTL | Auto-promotes when |
|-------|-----|--------------------|
| `working` | 6 hours | Accessed 3+ times or importance >= 7 |
| `short_term` | 7 days | Accessed 8+ times or importance >= 8 |
| `long_term` | No expiry | — |
| `permanent` | No expiry, no deletion | — |

### Composite Scoring (AIRI-inspired)

```
score = FTS_relevance (40%) + importance (30%) + recency (20%) + access_frequency (10%)
```

With Memory Transfer Learning overlay:
```
final_score = base_score × level_weight × decay_score
  where level_weight = { meta_knowledge: 1.3, semi_abstract: 1.0, concrete_trace: 0.7 }
        decay_score  = power-law decay × reuse boost   (v2.1, defaults to 1.0)
```

In hybrid mode (FTS5 + vector):
```
score = (RRF_score × 0.7 + importance × 0.2 + recency × 0.1) × level_weight × decay_score
```

The `× decay_score` multiplier (v2.1) lets long-untouched records rank lower naturally, without manual TTL tuning. See [What's New in v2.1](#whats-new-in-v21-memory-hygiene) above.

### 9 Memory Categories

`general` · `people` · `project` · `decision` · `feedback` · `bug` · `relationship` · `skill` · `preference`

### Chinese Tokenization *(Optional)*

Built-in support for Chinese via [wangfenjin/simple](https://github.com/wangfenjin/simple) — a native SQLite extension using cppjieba for word-level segmentation. Falls back gracefully to character-level FTS5 if the extension isn't installed.

**Non-Chinese users: skip this entirely.** The default FTS5 tokenizer works well for English and other languages.

### Health Metrics

`memory_stats()` now reports:
- **Compression pressure**: ratio of temporary to permanent memories (>1.0 = piling up)
- **Dead knowledge**: long-term memories not accessed in 30 days
- **Search miss rate**: queries that returned zero results (knowledge blind spots)

---

## Quick Start

### Prerequisites

- Node.js 18+
- Any MCP-compatible AI agent

### Optional Native Extensions

For enhanced functionality, you can add these SQLite extensions (place in `lib/` directory):

- **[sqlite-vec](https://github.com/asg017/sqlite-vec)**: KNN vector search for hybrid retrieval
- **[wangfenjin/simple](https://github.com/wangfenjin/simple)**: Chinese word-level tokenization

Both are optional — mneme works fully with just FTS5 out of the box.

### Install

```bash
git clone https://github.com/AgentGameLab/mneme.git
cd mneme
npm install
```

### Configure Embeddings (Optional)

For hybrid search (FTS5 + vector), set these environment variables:

```bash
export EMBEDDING_API_BASE_URL="https://api.openai.com/v1"  # or any OpenAI-compatible API
export EMBEDDING_API_KEY="your-key"
export EMBEDDING_MODEL="text-embedding-3-small"  # default
export EMBEDDING_DIMENSION="1536"  # default
```

You can also put these in a `.env.local` file in the project root.

### Initialize

```bash
node index.mjs --stats
# Creates tokenmem.db on first run
```

### Connect to Your Agent

**Claude Code:**
```bash
claude mcp add --scope user mneme -- node /absolute/path/to/mcp-server.mjs
```

**Cursor / Windsurf / Other MCP clients:**
```json
{
  "mcpServers": {
    "mneme": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server.mjs"]
    }
  }
}
```

### Add Agent Instructions

mneme stores and recalls, but *when* and *how* your agent stores is driven by its
instruction file — not by mneme. A few well-chosen lines keep the memory sharp instead of
bloated. See **[docs/configuring-your-agent.md](docs/configuring-your-agent.md)** for the
full guide: the instruction block plus where each agent (Claude Code, Codex, Cursor, Cline,
Gemini CLI, Windsurf, Amp) reads it.

The short version — paste into `CLAUDE.md` / `AGENTS.md` / `.cursor/rules` / `GEMINI.md` / etc.:

```markdown
## Memory (mneme MCP)

You have persistent memory via `mneme`: `recall_memory`, `store_memory`, `memory_stats`.

- **Recall** only when context lacks a confident answer (past work, decisions, people,
  preferences, project history). Skip if context already answers, the question is generic,
  or you already asked this session.
- **Store is a write gate, not a reflex**: store only what will change future behavior or be
  useful in a different session — not passing chatter or one-off confirmations.
- **Default `semi_abstract`.** `meta_knowledge` is *earned* — reserve it for heuristics that
  would help even in a completely unrelated project. Importance is a weak prior (anchor it:
  9-10 identity/rules · 7-8 active decisions · 5-6 context · ≤4 traces), not a ranking lever —
  salience emerges from recall frequency, not the number you assign at write time.
- On a **near-duplicate** warning, `supersedes: ["<id>"]` the existing entry instead of duplicating.
```

---

## CLI Usage

mneme also works as a standalone CLI tool — useful for hooks, scripts, and debugging:

```bash
# Check stats
node index.mjs --stats

# Recall memories
node index.mjs --recall "food preferences" --limit 5

# Store a memory with abstraction level
node index.mjs --store "When encountering X, always check Y first" \
  --importance 8 --type long_term --category skill \
  --level meta_knowledge

# Build context for injection (useful in hooks)
node index.mjs --context "current project status"

# Compress old conversations (requires claude CLI)
node index.mjs --compress <chat_id> --days 30
node index.mjs --compress-all

# Ingest compact summary (called by SessionStart hook)
TOKENMEM_COMPACT_SUMMARY="..." node index.mjs --store-compact-summary

# Backfill embeddings for existing memories
node backfill-embeddings.mjs --concurrency 3
node backfill-embeddings.mjs --dry-run  # count only
```

---

## Utilities

### `backfill-embeddings.mjs`

Batch-generates embedding vectors for existing memories that don't have them yet. Useful when first enabling vector search on an existing database.

### `migrate-claude-memories.mjs`

Imports Claude Code's auto-memory `.md` files (`~/.claude/projects/*/memory/*.md`) into the SQLite database. Idempotent — safe to re-run. Does not delete original files.

---

## File Structure

```
mneme/
├── mcp-server.mjs              # MCP server entry point (stdio transport)
├── index.mjs                   # Core engine: store, recall, hybrid search, compression, decay
├── schema.sql                  # SQLite schema (memories, conversations, FTS5, goals)
├── migrations/                 # Versioned schema migrations (apply in order)
│   ├── 001-add-superseded-by.sql
│   └── 003-add-decay-and-priors.sql
├── package.json                # 3 dependencies only
├── backfill-embeddings.mjs     # Batch embedding backfill script
├── migrate-claude-memories.mjs # Claude auto-memory migration tool
├── tokenmem.db                 # SQLite database (auto-created, gitignored)
└── lib/                        # Optional: native extension binaries (gitignored)
    ├── libsimple-windows-x64/  #   Chinese tokenizer (wangfenjin/simple)
    └── sqlite-vec-windows-x64/ #   Vector search (asg017/sqlite-vec)
```

**~1,800 lines of code. 3 dependencies. No build step.**

---

## Design Decisions

**Why SQLite, not a vector database?**  
For personal agent memory, FTS5 + sqlite-vec provides sufficient semantic recall without operational overhead. The hybrid approach (FTS5 for exact matching + sqlite-vec for semantic) covers both query styles.

**Why on-demand, not pre-injection?**  
Pre-injection wastes tokens on every message. On-demand lets the agent skip the lookup when it already has the answer — which is most of the time.

**Why MCP, not a custom API?**  
MCP is the emerging standard for agent-tool communication. One implementation works across Claude Code, Cursor, Windsurf, and any future MCP-compatible agent.

**Why Memory Transfer Learning?**  
Research shows that concrete execution traces transfer poorly across contexts and can even cause negative transfer. By automatically weighting meta-knowledge higher during recall, the system surfaces reusable patterns over raw event logs.

**Why RRF for hybrid search?**  
Reciprocal Rank Fusion uses only rank positions, not raw scores. This means FTS5 BM25 scores and vector distances — which have completely different scales — can be merged fairly without normalization.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TOKENMEM_DB_PATH` | `./tokenmem.db` | Path to SQLite database |
| `EMBEDDING_API_BASE_URL` | — | OpenAI-compatible embedding API base URL |
| `EMBEDDING_API_KEY` | — | API key for embedding service |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model name |
| `EMBEDDING_DIMENSION` | `1536` | Vector dimension |
| `ENTITY_LLM_API_BASE_URL` | — | OpenAI-compatible chat base URL for the optional entity layer (v2.5; dormant if unset) |
| `ENTITY_LLM_API_KEY` | — | API key for entity extraction |
| `ENTITY_LLM_MODEL` | `gpt-4o-mini` | Chat model for entity extraction |
| `CLAUDE_BIN` | `claude` | Path to Claude CLI (for compression pipeline) |
| `TOKENMEM_COMPACT_SUMMARY` | — | Compact summary text (for SessionStart hook) |
| `TOKENMEM_COMPACT_SESSION` | — | Session ID for compact summary |

---

## References

- [moeru-ai/airi](https://github.com/moeru-ai/airi) — Memory architecture inspiration (composite scoring model)
- [wangfenjin/simple](https://github.com/wangfenjin/simple) — Chinese tokenizer for SQLite FTS5 (cppjieba-based)
- [asg017/sqlite-vec](https://github.com/asg017/sqlite-vec) — SQLite vector search extension
- [SQLite FTS5](https://www.sqlite.org/fts5.html) — Full-text search extension with BM25 ranking
- [Model Context Protocol](https://modelcontextprotocol.io/) — The standard for agent-tool communication
- [Memory Transfer Learning (arxiv 2604.14004)](https://arxiv.org/abs/2604.14004) — Cross-context memory reuse research

---

## License

MIT
