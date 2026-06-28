// ============================================================
// tokenmem v2.0 (SQLite + FTS5 + sqlite-vec)
// Token-efficient persistent memory for AI agents
// Inspired by: AIRI (moeru-ai/airi) memory architecture
//
// Core capabilities:
//   - Structured memory storage (layers + categories + importance scoring)
//   - FTS5 full-text search (built-in, zero dependencies)
//   - Hybrid retrieval: FTS5 + sqlite-vec KNN + RRF fusion
//   - Memory Transfer Learning (meta_knowledge / semi_abstract / concrete_trace)
//   - Composite scoring (AIRI-style: importance + relevance + recency)
//   - Context window expansion (recall surrounding messages)
//   - Auto-expiry & memory promotion (working -> long_term)
//   - Compression pipeline (LLM-based summarization)
//   - Optional: vector similarity via sqlite-vec or JSON-stored embeddings
//
// Dependencies: better-sqlite3 (sync API, high performance)
// Data file: tokenmem.db (configurable via TOKENMEM_DB_PATH env var)
// ============================================================

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { verifyAndRecord } from '../lib/team-registry-verify.mjs'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
// Path resolution order (v2.1.2):
//   1. $TOKENMEM_DB_PATH if set (explicit override)
//   2. Existing engram.db beside this module (back-compat for users coming from
//      the pre-rename era — silent migration would create a split-brain second
//      DB; we'd rather keep using the populated one)
//   3. tokenmem.db (default for fresh installs)
const DB_PATH = process.env.TOKENMEM_DB_PATH
  || (existsSync(resolve(__dirname, 'engram.db'))
        ? resolve(__dirname, 'engram.db')
        : resolve(__dirname, 'tokenmem.db'))
const SCHEMA_PATH = resolve(__dirname, 'schema.sql')
// wangfenjin/simple Chinese tokenizer extension (optional)
const SIMPLE_EXT_DIR = resolve(__dirname, 'lib/libsimple-windows-x64')
const SIMPLE_EXT_PATH = resolve(SIMPLE_EXT_DIR, 'simple')  // .dll suffix handled by loadExtension
const SIMPLE_DICT_PATH = resolve(SIMPLE_EXT_DIR, 'dict')

// asg017/sqlite-vec vector search extension (optional)
const VEC_EXT_DIR = resolve(__dirname, 'lib/sqlite-vec-windows-x64')
const VEC_EXT_PATH = resolve(VEC_EXT_DIR, 'vec0')

const log = (msg) => process.stderr.write(`[${new Date().toISOString()}] [Memory] ${msg}\n`)

// ── DB Instance ─────────────────────────────────────────────
let _db = null
let _embeddingConfig = null
let _entityLlmConfig = null  // v2.5: optional OpenAI-compatible chat LLM for async entity extraction
let _entityCache = null       // v2.5.1: cached entity list for the recall path (parsed aliases)
let _entityCacheSig = ''       // cheap change signature (count:maxId) — refreshes cross-process
let _simpleLoaded = false  // whether the simple extension loaded successfully
let _vecLoaded = false     // whether the sqlite-vec extension loaded successfully

/**
 * Get or create DB instance (loads optional extensions)
 */
function getDb() {
  if (_db) return _db
  const Database = require('better-sqlite3')
  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  _db.pragma('busy_timeout = 5000')  // wait 5s on concurrent writes instead of immediate error

  // Load Chinese tokenizer extension (optional)
  try {
    if (existsSync(SIMPLE_EXT_PATH + '.dll') || existsSync(SIMPLE_EXT_PATH)) {
      _db.loadExtension(SIMPLE_EXT_PATH)
      _db.prepare('SELECT jieba_dict(?)').run(SIMPLE_DICT_PATH)
      _simpleLoaded = true
      log('Chinese tokenizer extension (libsimple + jieba) loaded')
    }
  } catch (e) {
    log(`Chinese tokenizer load failed (falling back to character matching): ${e.message}`)
  }

  // Load sqlite-vec vector search extension (optional)
  try {
    if (existsSync(VEC_EXT_PATH + '.dll') || existsSync(VEC_EXT_PATH)) {
      _db.loadExtension(VEC_EXT_PATH)
      const ver = _db.prepare('SELECT vec_version() AS v').get()?.v || 'unknown'
      _vecLoaded = true
      log(`sqlite-vec extension loaded (${ver})`)
    }
  } catch (e) {
    log(`sqlite-vec load failed (falling back to FTS5 only): ${e.message}`)
  }

  return _db
}

// ── Initialization ──────────────────────────────────────────

/**
 * Initialize memory system: create tables, FTS indexes
 */
export function initMemory() {
  const db = getDb()
  const schema = readFileSync(SCHEMA_PATH, 'utf-8')

  // PRAGMAs must be executed outside transactions
  const pragmaLines = schema.match(/^PRAGMA\s+[^;]+;/gm) || []
  for (const p of pragmaLines) {
    try { db.exec(p) } catch {}
  }

  // Execute remaining DDL (better-sqlite3 supports multi-statement exec)
  const ddl = schema.replace(/^PRAGMA\s+[^;]+;\s*$/gm, '')
  try {
    db.exec(ddl)
  } catch (e) {
    // First run creates normally; subsequent runs may report "already exists"
    if (!e.message.includes('already exists')) {
      log(`Schema exec: ${e.message.slice(0, 200)}`)
    }
  }

  log(`Initialized — DB at ${DB_PATH}`)

  // ── FTS migration: if simple extension loaded but FTS uses old tokenizer, rebuild ──
  if (_simpleLoaded) {
    try {
      const ftsRow = db.prepare(`SELECT sql FROM sqlite_master WHERE name='memories_fts'`).get()
      const currentSql = ftsRow?.sql || ''
      const currentTokenizer = currentSql.match(/tokenize\s*=\s*'([^']+)'/)?.[1] || 'none'
      if (!currentTokenizer.includes('simple')) {
        log(`FTS migrating: ${currentTokenizer} -> simple (rebuilding index...)`)
        db.exec(`
          DROP TRIGGER IF EXISTS trg_mem_fts_insert;
          DROP TRIGGER IF EXISTS trg_mem_fts_delete;
          DROP TRIGGER IF EXISTS trg_mem_fts_update;
          DROP TRIGGER IF EXISTS trg_conv_fts_insert;
          DROP TRIGGER IF EXISTS trg_conv_fts_delete;
          DROP TRIGGER IF EXISTS trg_conv_fts_update;
          DROP TABLE IF EXISTS memories_fts;
          DROP TABLE IF EXISTS conversations_fts;

          CREATE VIRTUAL TABLE memories_fts USING fts5(
            content, summary, tags,
            content='memories', content_rowid='rowid',
            tokenize='simple 0'
          );

          CREATE VIRTUAL TABLE conversations_fts USING fts5(
            content, from_name,
            content='conversations', content_rowid='rowid',
            tokenize='simple 0'
          );

          CREATE TRIGGER trg_mem_fts_insert AFTER INSERT ON memories BEGIN
            INSERT INTO memories_fts(rowid, content, summary, tags)
            VALUES (new.rowid, new.content, new.summary, new.tags);
          END;
          CREATE TRIGGER trg_mem_fts_delete AFTER DELETE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags)
            VALUES ('delete', old.rowid, old.content, old.summary, old.tags);
          END;
          CREATE TRIGGER trg_mem_fts_update AFTER UPDATE OF content, summary, tags ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags)
            VALUES ('delete', old.rowid, old.content, old.summary, old.tags);
            INSERT INTO memories_fts(rowid, content, summary, tags)
            VALUES (new.rowid, new.content, new.summary, new.tags);
          END;

          CREATE TRIGGER trg_conv_fts_insert AFTER INSERT ON conversations BEGIN
            INSERT INTO conversations_fts(rowid, content, from_name)
            VALUES (new.rowid, new.content, new.from_name);
          END;
          CREATE TRIGGER trg_conv_fts_delete AFTER DELETE ON conversations BEGIN
            INSERT INTO conversations_fts(conversations_fts, rowid, content, from_name)
            VALUES ('delete', old.rowid, old.content, old.from_name);
          END;
          CREATE TRIGGER trg_conv_fts_update AFTER UPDATE OF content ON conversations BEGIN
            INSERT INTO conversations_fts(conversations_fts, rowid, content, from_name)
            VALUES ('delete', old.rowid, old.content, old.from_name);
            INSERT INTO conversations_fts(rowid, content, from_name)
            VALUES (new.rowid, new.content, new.from_name);
          END;
        `)
        // Rebuild FTS indexes with existing data
        db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`)
        db.exec(`INSERT INTO conversations_fts(conversations_fts) VALUES('rebuild')`)
        const memCount = db.prepare(`SELECT COUNT(*) AS c FROM memories_fts`).get().c
        log(`FTS migration complete, rebuilt ${memCount} memory indexes (tokenize=simple)`)
      } else {
        log(`FTS already using simple tokenizer, no migration needed`)
      }
    } catch (e) {
      log(`FTS migration failed (non-critical, falling back to character matching): ${e.message}`)
    }
  }

  // Detect embedding configuration
  if (process.env.EMBEDDING_API_BASE_URL && process.env.EMBEDDING_API_KEY) {
    _embeddingConfig = {
      baseUrl: process.env.EMBEDDING_API_BASE_URL,
      apiKey: process.env.EMBEDDING_API_KEY,
      model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
      dimension: parseInt(process.env.EMBEDDING_DIMENSION || '1536', 10),
    }
    log(`Embedding API: ${_embeddingConfig.model} (${_embeddingConfig.dimension}d)`)
  } else {
    log('No embedding API — using FTS5 full-text search only')
  }

  // Detect entity-extraction LLM (v2.5, optional, OpenAI-compatible chat completions).
  // Dormant if unset — the entity layer just stays empty and recall falls back to
  // FTS5 + vector RRF (current behaviour). Extraction never runs on the recall hot path.
  if (process.env.ENTITY_LLM_API_BASE_URL && process.env.ENTITY_LLM_API_KEY) {
    _entityLlmConfig = {
      baseUrl: process.env.ENTITY_LLM_API_BASE_URL,
      apiKey: process.env.ENTITY_LLM_API_KEY,
      model: process.env.ENTITY_LLM_MODEL || 'gpt-4o-mini',
    }
    log(`Entity LLM: ${_entityLlmConfig.model}`)
  }

  // ── Incremental schema migrations ───────────────────────────
  // New columns: compressed_from, is_compressed (compression pipeline)
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN compressed_from TEXT DEFAULT '[]'`)
    log('Migration: added compressed_from column')
  } catch {}  // "duplicate column name" = already exists, ignore
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN is_compressed INTEGER NOT NULL DEFAULT 0`)
    log('Migration: added is_compressed column')
  } catch {}
  // Abstraction level (Memory Transfer Learning)
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN memory_level TEXT NOT NULL DEFAULT 'semi_abstract'`)
    log('Migration: added memory_level column')
  } catch {}  // already exists
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_level ON memories(memory_level) WHERE deleted_at IS NULL`)
  } catch {}
  // Store-time dedup + event_time (migration 004). Inline so fresh installs get them
  // without manually applying migrations/004 — storeMemory's dedup path needs content_hash.
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN content_hash TEXT`)
    log('Migration: added content_hash column')
  } catch {}  // already exists
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN event_time INTEGER`)
    log('Migration: added event_time column')
  } catch {}
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_content_hash ON memories(content_hash, created_at DESC) WHERE content_hash IS NOT NULL AND deleted_at IS NULL`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_event_time ON memories(event_time DESC) WHERE event_time IS NOT NULL AND deleted_at IS NULL`)
  } catch {}
  // migration 006: source_conversation_id — 把一条 L1 记忆链回它形成时的 L0 对话（conversations.rowid）。
  // 借鉴 Tencent Agent Memory 的「full traceability drill-down」：召回一条记忆能回查原始对话佐证。
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN source_conversation_id INTEGER`)
    log('Migration: added source_conversation_id column')
  } catch {}  // already exists
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_source_conv ON memories(source_conversation_id) WHERE source_conversation_id IS NOT NULL`)
  } catch {}
  // migration 007 (v2.5): entity layer — `entities` + `mentions` (memory<->entity), plus a
  // memories.entities_extracted_at marker (NULL = not yet processed, mirrors content_vector IS NULL).
  // A 3rd retrieval signal beside FTS5 + vector. Extraction is async / store-time, NEVER on the
  // recall hot path; recall joins `mentions` and feeds an RRF 4th ranked list (NOT an additive
  // boost — additive would re-drown relevance, see the v2.4 rrf*10 note). Same SQLite file, no
  // graph DB. Soft-delete only (no tombstone), consistent with the rest of the store.
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN entities_extracted_at INTEGER`)
    log('Migration 007: added entities_extracted_at column')
  } catch {}  // already exists
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        normalized TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'other',
        aliases TEXT NOT NULL DEFAULT '[]',
        mention_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        deleted_at INTEGER
      )
    `)
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_norm ON entities(normalized, type) WHERE deleted_at IS NULL`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name) WHERE deleted_at IS NULL`)
    db.exec(`
      CREATE TABLE IF NOT EXISTS mentions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_rowid INTEGER NOT NULL,
        entity_id INTEGER NOT NULL REFERENCES entities(id),
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      )
    `)
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mentions_pair ON mentions(memory_rowid, entity_id)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mentions_entity ON mentions(entity_id)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mentions_memory ON mentions(memory_rowid)`)
    log('Migration 007: entity layer (entities + mentions) ready')
  } catch (e) { log(`Migration 007 (entities) failed: ${e.message}`) }
  // migration 003: decay_score + prior_versions (power-law decay + supersede paper trail).
  // Inline so upgrading an OLD db gets them without manually applying migrations/003 —
  // otherwise recall's `AND decay_score >= ?` (strict/cold-pool path) throws "no such column".
  // (2026-06-10: caught during 爱芮 engram v1.1→v2.2 upgrade — 003 was the only file not inlined.)
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN decay_score REAL NOT NULL DEFAULT 1.0`)
    log('Migration: added decay_score column')
  } catch {}  // already exists
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN prior_versions TEXT NOT NULL DEFAULT '[]'`)
    log('Migration: added prior_versions column')
  } catch {}
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_surface_pool ON memories(importance, last_accessed, decay_score) WHERE deleted_at IS NULL AND superseded_by IS NULL AND importance >= 8`)
  } catch {}

  // Vector search virtual table (sqlite-vec)
  // Dimension determined by _embeddingConfig; skip if not available
  if (_vecLoaded && _embeddingConfig) {
    try {
      const dim = _embeddingConfig.dimension
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
          memory_rowid INTEGER PRIMARY KEY,
          embedding FLOAT[${dim}]
        )
      `)
      log(`Vector table memories_vec ready (dim=${dim})`)
    } catch (e) {
      log(`memories_vec creation failed: ${e.message}`)
    }
  }
  // New table: search_misses (search miss tracking)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS search_misses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'recall',
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      )
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_miss_query ON search_misses(query)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_miss_created ON search_misses(created_at DESC)`)
  } catch {}

  // Migration: memories.source CHECK constraint add 'compression'
  // SQLite doesn't support ALTER CHECK -> check if current CHECK includes 'compression', rebuild if not
  try {
    const memSchema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'`).get()?.sql || ''
    if (memSchema && !memSchema.includes("'compression'")) {
      log('Migration: rebuilding memories table to add compression source')
      db.exec(`
        BEGIN TRANSACTION;

        -- Disable FTS triggers during rebuild
        DROP TRIGGER IF EXISTS trg_mem_fts_insert;
        DROP TRIGGER IF EXISTS trg_mem_fts_delete;
        DROP TRIGGER IF EXISTS trg_mem_fts_update;

        ALTER TABLE memories RENAME TO memories_old;

        CREATE TABLE memories (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          content TEXT NOT NULL CHECK (length(content) > 0),
          summary TEXT,
          memory_type TEXT NOT NULL DEFAULT 'working'
            CHECK (memory_type IN ('working', 'short_term', 'long_term', 'permanent')),
          category TEXT NOT NULL DEFAULT 'general'
            CHECK (category IN ('general', 'people', 'project', 'decision', 'feedback',
                                 'bug', 'relationship', 'skill', 'preference')),
          importance INTEGER NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
          emotional_impact INTEGER NOT NULL DEFAULT 0 CHECK (emotional_impact BETWEEN -10 AND 10),
          source TEXT NOT NULL DEFAULT 'conversation'
            CHECK (source IN ('conversation', 'observation', 'manual', 'extraction', 'compression')),
          source_id TEXT,
          source_platform TEXT DEFAULT 'unknown',
          tags TEXT DEFAULT '[]',
          compressed_from TEXT DEFAULT '[]',
          is_compressed INTEGER NOT NULL DEFAULT 0,
          memory_level TEXT NOT NULL DEFAULT 'semi_abstract'
            CHECK (memory_level IN ('concrete_trace', 'semi_abstract', 'meta_knowledge')),
          metadata TEXT DEFAULT '{}',
          content_vector TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          last_accessed INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          access_count INTEGER NOT NULL DEFAULT 0,
          expires_at INTEGER,
          deleted_at INTEGER
        );

        -- Copy data with explicit column names, fill NULLs with defaults
        INSERT INTO memories (
          id, content, summary, memory_type, category, importance, emotional_impact,
          source, source_id, source_platform, tags, compressed_from, is_compressed,
          memory_level, metadata, content_vector, created_at, updated_at, last_accessed,
          access_count, expires_at, deleted_at
        )
        SELECT
          id, content, summary, memory_type, category, importance, emotional_impact,
          source, source_id, source_platform, tags,
          COALESCE(compressed_from, '[]') AS compressed_from,
          COALESCE(is_compressed, 0) AS is_compressed,
          'semi_abstract' AS memory_level,
          metadata, content_vector, created_at, updated_at, last_accessed, access_count,
          expires_at, deleted_at
        FROM memories_old;
        DROP TABLE memories_old;

        -- Rebuild indexes
        CREATE INDEX IF NOT EXISTS idx_mem_type ON memories(memory_type) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_mem_category ON memories(category) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_mem_importance ON memories(importance DESC) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_mem_created ON memories(created_at DESC) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_mem_accessed ON memories(last_accessed DESC) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_mem_source ON memories(source_platform, source) WHERE deleted_at IS NULL;

        -- Rebuild FTS triggers
        CREATE TRIGGER trg_mem_fts_insert AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content, summary, tags)
          VALUES (new.rowid, new.content, new.summary, new.tags);
        END;
        CREATE TRIGGER trg_mem_fts_delete AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags)
          VALUES ('delete', old.rowid, old.content, old.summary, old.tags);
        END;
        CREATE TRIGGER trg_mem_fts_update AFTER UPDATE OF content, summary, tags ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags)
          VALUES ('delete', old.rowid, old.content, old.summary, old.tags);
          INSERT INTO memories_fts(rowid, content, summary, tags)
          VALUES (new.rowid, new.content, new.summary, new.tags);
        END;

        COMMIT;
      `)
      // Rebuild FTS index (triggers were disabled during migration)
      db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`)
      log('Migration: memories table rebuilt, FTS reindexed')
    }
  } catch (e) {
    log(`Migration memories CHECK failed: ${e.message}`)
    try { db.exec('ROLLBACK') } catch {}
  }

  // Clean up expired memories
  expireMemories()

  // Show stats
  const stats = getMemoryStats()
  log(`Stats: ${stats.memories.total_active} memories, ${stats.conversations} conversations, ${stats.activeGoals} active goals`)
}

// ── Embedding (Optional) ────────────────────────────────────

/**
 * Generate embedding vector (OpenAI-compatible API)
 */
async function generateEmbedding(text) {
  if (!_embeddingConfig) return null
  try {
    const res = await fetch(`${_embeddingConfig.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_embeddingConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: _embeddingConfig.model,
        input: text.slice(0, 8000),
        dimensions: _embeddingConfig.dimension,
        encoding_format: 'float',
      }),
    })
    const data = await res.json()
    return data?.data?.[0]?.embedding || null
  } catch (e) {
    log(`Embedding failed: ${e.message}`)
    return null
  }
}

// ── Entity extraction (v2.5, async / store-time — NEVER on the recall hot path) ──
// Optional: dormant unless ENTITY_LLM_* is configured. Extraction is an OpenAI-compatible
// chat call; the resulting entities feed an RRF 4th retrieval path (see recall), not an
// additive boost. Recall itself does zero LLM — query→entity matching is pure SQL.

async function callEntityLlm(prompt) {
  if (!_entityLlmConfig) return null
  try {
    const res = await fetch(`${_entityLlmConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_entityLlmConfig.apiKey}` },
      body: JSON.stringify({
        model: _entityLlmConfig.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 600,
      }),
    })
    const data = await res.json()
    return data?.choices?.[0]?.message?.content || null
  } catch (e) {
    log(`Entity LLM call failed: ${e.message}`)
    return null
  }
}

const ENTITY_PROMPT = `你是命名实体抽取器。从下面这条记忆里**只抽具体的命名实体**(专有名词),用作检索锚点。
只抽这五类(必须是特定的、可复用指代某个东西的专名):
- person: 具体人名
- project: 具体项目/产品/代号名(如 TANDEM / Fire-Seed / engram / mneme / KOS / GClaw)
- org: 具体组织/公司/团队名
- tech: 具体工具/库/服务/协议名(如 codex / DeepSeek / sqlite-vec / MCP / jieba)
- place: 具体地名
**绝不抽**:通用技术词(timeout / metric / cache / dedup / supersede / fail-soft / CLI 等)、动词、形容词、泛泛概念、角色词(owner / 负责人 / 用户)。
判据:这个词是不是一个**特定的、能反复指代同一个东西的专名**?不是就丢。宁缺毋滥,最多 6 个,中英文都抽。
每个给 name(规范名)、type(上面五类之一)、aliases(同义/简称,没有则 [])。
严格只输出 JSON 数组,无其他文字:[{"name":"","type":"","aliases":[]}]
记忆内容:
`

function parseEntityJson(text) {
  if (!text) return []
  const m = text.match(/\[[\s\S]*\]/)  // tolerate ```json fences / surrounding prose
  if (!m) return []
  let arr
  try { arr = JSON.parse(m[0]) } catch { return [] }
  if (!Array.isArray(arr)) return []
  // strict whitelist of types — drop (not remap) anything else, since the generic-concept
  // junk the LLM occasionally emits ("metric", "timeout"...) makes useless broad-match anchors.
  const TYPES = new Set(['person', 'project', 'org', 'tech', 'place'])
  return arr
    .filter(e => e && typeof e.name === 'string' && e.name.trim() && TYPES.has(e.type))
    .map(e => ({
      name: e.name.trim().slice(0, 120),
      type: e.type,
      aliases: Array.isArray(e.aliases)
        ? e.aliases.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim().slice(0, 80)).slice(0, 6)
        : [],
    }))
    .slice(0, 6)
}

async function extractEntitiesFromContent(content) {
  return parseEntityJson(await callEntityLlm(ENTITY_PROMPT + String(content).slice(0, 4000)))
}

function normalizeEntityName(name) {
  return String(name).toLowerCase().replace(/\s+/g, ' ').trim()
}

// Upsert by (normalized, type); merge aliases; bump mention_count. Returns entity id (or null).
function upsertEntity(db, { name, type, aliases }) {
  const normalized = normalizeEntityName(name)
  if (!normalized) return null
  const now = Date.now()
  const existing = db.prepare(`SELECT id, aliases FROM entities WHERE normalized = ? AND type = ? AND deleted_at IS NULL`).get(normalized, type)
  if (existing) {
    if (aliases?.length) {
      const cur = safeJsonParse(existing.aliases, [])
      const merged = Array.from(new Set([...cur, ...aliases]))
      if (merged.length !== cur.length) {
        db.prepare(`UPDATE entities SET aliases = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(merged), now, existing.id)
      }
    }
    db.prepare(`UPDATE entities SET mention_count = mention_count + 1, updated_at = ? WHERE id = ?`).run(now, existing.id)
    return existing.id
  }
  return db.prepare(`INSERT INTO entities (name, normalized, type, aliases, mention_count, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`)
    .run(name.slice(0, 120), normalized, type, JSON.stringify(aliases || []), now, now).lastInsertRowid
}

/**
 * Async batch: extract entities for memories not yet processed (entities_extracted_at IS NULL).
 * Off the store + recall hot paths. No-op if no entity LLM configured.
 * @param {number} limit  max memories per run (bounds LLM cost)
 */
export async function extractMissingEntities(limit = 100, concurrency = 8) {
  if (!_entityLlmConfig) return { scanned: 0, processed: 0, entities: 0, mentions: 0, failed: 0, skipped: 'no_entity_llm' }
  const db = getDb()
  const rows = db.prepare(`
    SELECT rowid, content FROM memories
    WHERE entities_extracted_at IS NULL AND deleted_at IS NULL
    ORDER BY rowid DESC LIMIT ?
  `).all(limit)
  if (rows.length === 0) return { scanned: 0, processed: 0, entities: 0, mentions: 0, failed: 0 }
  let processed = 0, entCount = 0, mentCount = 0, failed = 0
  const markStmt = db.prepare(`UPDATE memories SET entities_extracted_at = ? WHERE rowid = ?`)
  const linkStmt = db.prepare(`INSERT OR IGNORE INTO mentions (memory_rowid, entity_id, created_at) VALUES (?, ?, ?)`)
  // The slow part is the per-memory LLM call (network). Run them CONCURRENTLY in batches,
  // then commit each memory's entities SEQUENTIALLY (better-sqlite3 is synchronous — DB writes
  // can't and shouldn't overlap). Brings a full backfill from hours to ~minutes.
  for (let i = 0; i < rows.length; i += concurrency) {
    const batch = rows.slice(i, i + concurrency)
    const extracted = await Promise.all(batch.map(row =>
      extractEntitiesFromContent(row.content).then(ents => ({ row, ents })).catch(() => ({ row, ents: null }))
    ))
    for (const { row, ents } of extracted) {
      if (ents === null) { failed++; continue }
      // dedup per memory (LLM may repeat) so mention_count isn't double-bumped
      const seen = new Set()
      const uniq = ents.filter(e => { const k = normalizeEntityName(e.name) + '|' + e.type; if (!k || seen.has(k)) return false; seen.add(k); return true })
      const now = Date.now()
      const tx = db.transaction(() => {
        for (const e of uniq) {
          const eid = upsertEntity(db, e)
          if (eid != null) { const r = linkStmt.run(row.rowid, Number(eid), now); if (r.changes > 0) mentCount++ }
        }
        markStmt.run(now, row.rowid)
      })
      try { tx(); processed++; entCount += uniq.length } catch { failed++ }
    }
  }
  log(`extractMissingEntities: processed=${processed}/${rows.length} entities=${entCount} mentions=${mentCount} failed=${failed}`)
  return { scanned: rows.length, processed, entities: entCount, mentions: mentCount, failed }
}

/**
 * Cosine similarity (application-layer computation)
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dotProduct = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dotProduct / denom
}

// ── Conversation Recording ──────────────────────────────────

/**
 * Record a conversation message
 * @param {Object} msg
 * @param {string} msg.platform
 * @param {string} msg.chatId
 * @param {string} [msg.messageId]
 * @param {string} msg.fromId
 * @param {string} msg.fromName
 * @param {string} msg.role - user | assistant | system
 * @param {string} msg.content
 * @param {boolean} [msg.isReply]
 * @param {string} [msg.replyToId]
 * @param {Object} [msg.metadata]
 * @returns {string|null} conversation id
 */
export function recordConversation(msg) {
  // G7 family · 千夏 segment: sender_id verify against team-registry
  // Fail-soft: log + metric, never blocks main flow
  try {
    verifyAndRecord(msg)
  } catch (_) {
    // Defensive: verify-hook errors must never affect recording
  }

  const db = getDb()
  try {
    const stmt = db.prepare(`
      INSERT INTO conversations
        (platform, chat_id, message_id, from_id, from_name, role, content, is_reply, reply_to_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const info = stmt.run(
      msg.platform || 'unknown',
      msg.chatId,
      msg.messageId || null,
      msg.fromId,
      msg.fromName || '',
      msg.role || 'user',
      msg.content,
      msg.isReply ? 1 : 0,
      msg.replyToId || null,
      JSON.stringify(msg.metadata || {}),
    )
    return info.lastInsertRowid ? String(info.lastInsertRowid) : null
  } catch (e) {
    // UNIQUE constraint = deduplication, silent
    if (e.message.includes('UNIQUE')) return null
    log(`recordConversation failed: ${e.message}`)
    return null
  }
}

/**
 * Async version: record conversation + generate embedding vector
 */
export async function recordConversationAsync(msg) {
  const id = recordConversation(msg)
  if (!id) return null

  // Background embedding generation
  const embedding = await generateEmbedding(msg.content)
  if (embedding) {
    try {
      getDb().prepare(`UPDATE conversations SET content_vector = ? WHERE rowid = ?`)
        .run(JSON.stringify(embedding), id)
    } catch {}
  }
  return id
}

// ── Memory Storage ──────────────────────────────────────────

// migration 004 (v2.2): 5-min window dedup config
const DEDUP_WINDOW_MS = 5 * 60_000

// migration 004 (v2.2): event_time accepts ms number, ISO string, or Date object
function _parseEventTime(v) {
  if (v == null) return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string') {
    const ms = Date.parse(v)
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

/**
 * Store a memory
 * @param {Object} mem
 * @returns {string|null} memory id
 */
export function storeMemory(mem) {
  const db = getDb()
  const now = Date.now()

  // Default TTL
  let expiresAt = mem.expiresAt || null
  if (!expiresAt && !mem.ttlMs) {
    if (mem.memoryType === 'working') expiresAt = now + 6 * 3600_000      // 6h
    else if (mem.memoryType === 'short_term') expiresAt = now + 7 * 86400_000  // 7d
  } else if (mem.ttlMs) {
    expiresAt = now + mem.ttlMs
  }

  // Compression pipeline: compressed_from marks source memories, is_compressed marks products
  const compressedFrom = mem.compressedFrom || []
  const isCompressed = compressedFrom.length > 0 ? 1 : 0

  // Anti-cascade: reject if compressedFrom contains already-compressed memories (prevent hallucination amplification)
  if (compressedFrom.length > 0) {
    const cascadeCheck = db.prepare(
      `SELECT rowid FROM memories WHERE rowid IN (${compressedFrom.map(() => '?').join(',')}) AND is_compressed = 1`
    ).all(...compressedFrom)
    if (cascadeCheck.length > 0) {
      log(`storeMemory: rejected cascade compression (${cascadeCheck.length} sources are already compressed)`)
      return null
    }
  }

  // Abstraction level (Memory Transfer Learning):
  // - concrete_trace: specific operation logs -> low recall weight
  // - semi_abstract:  "did X because Y" -> default
  // - meta_knowledge: "when encountering X, do Y" -> high recall weight
  const validLevels = ['concrete_trace', 'semi_abstract', 'meta_knowledge']
  const memoryLevel = validLevels.includes(mem.memoryLevel) ? mem.memoryLevel : 'semi_abstract'

  // Structured supersede (migration 001): when caller passes mem.supersedes (array of
  // rowid strings), the new record's id will be UPDATEd into old records' superseded_by
  // pointer. expireMemories soft-deletes the chain on its next pass.
  const supersedes = Array.isArray(mem.supersedes)
    ? mem.supersedes.filter(s => typeof s === 'string' && /^\d+$/.test(s.trim())).map(s => s.trim())
    : []

  // migration 004 (v2.2): content hash + event_time
  const contentHash = createHash('sha256').update(String(mem.content || '')).digest('hex').slice(0, 16)
  const eventTime = _parseEventTime(mem.eventTime)

  // migration 004 (v2.2): 5-min window dedup
  // If the same content was stored within the last DEDUP_WINDOW_MS,
  // skip INSERT, bump existing row's access_count, return its id.
  // Avoids retry-store loops bloating the table while preserving the
  // "told you again" signal via access_count.
  // Skipped when caller passes supersedes (explicit retraction path takes
  // precedence) or compressedFrom (compression products are intentionally
  // new rows even if content overlaps).
  if (supersedes.length === 0 && compressedFrom.length === 0) {
    try {
      const cutoff = now - DEDUP_WINDOW_MS
      const dup = db.prepare(`
        SELECT rowid FROM memories
        WHERE content_hash = ? AND created_at > ?
          AND deleted_at IS NULL AND superseded_by IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      `).get(contentHash, cutoff)
      if (dup) {
        db.prepare(`UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE rowid = ?`)
          .run(now, dup.rowid)
        log(`storeMemory: dedup hit -> existing rowid=${dup.rowid} (5-min window, access_count bumped)`)
        return String(dup.rowid)
      }
    } catch (e) {
      // Dedup is best-effort — fall through to insert if the query fails
      log(`storeMemory: dedup check failed (continuing to insert): ${e.message}`)
    }
  }

  try {
    const insertStmt = db.prepare(`
      INSERT INTO memories
        (content, summary, memory_type, category, importance, emotional_impact,
         source, source_id, source_platform, tags, metadata, expires_at,
         compressed_from, is_compressed, memory_level, content_hash, event_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const supersedeStmt = db.prepare(
      `UPDATE memories SET superseded_by = ? WHERE rowid = ? AND deleted_at IS NULL AND superseded_by IS NULL`
    )
    // migration 003: paper trail — on supersede, push old content/summary/ts into the
    // new record's prior_versions[] (chained: absorbs old's own prior_versions too)
    const priorsLoadStmt = db.prepare(
      `SELECT rowid, content, summary, created_at, prior_versions FROM memories WHERE rowid = ?`
    )
    const priorsUpdateStmt = db.prepare(
      `UPDATE memories SET prior_versions = ? WHERE rowid = ?`
    )

    let newId = null
    const tx = db.transaction(() => {
      const info = insertStmt.run(
        mem.content,
        mem.summary || null,
        mem.memoryType || 'working',
        mem.category || 'general',
        mem.importance || 5,
        mem.emotionalImpact || 0,
        mem.source || 'conversation',
        mem.sourceId || null,
        mem.sourcePlatform || 'unknown',
        JSON.stringify(mem.tags || []),
        JSON.stringify(mem.metadata || {}),
        expiresAt,
        JSON.stringify(compressedFrom),
        isCompressed,
        memoryLevel,
        contentHash,    // migration 004 (v2.2)
        eventTime,      // migration 004 (v2.2)
      )
      newId = info.lastInsertRowid ? String(info.lastInsertRowid) : null

      if (newId && supersedes.length > 0) {
        // Build prior_versions[] from old records (chained absorption)
        const priors = []
        for (const oldRowid of supersedes) {
          const old = priorsLoadStmt.get(oldRowid)
          if (!old) continue
          try {
            const oldPriors = JSON.parse(old.prior_versions || '[]')
            if (Array.isArray(oldPriors)) priors.push(...oldPriors)
          } catch {}
          priors.push({
            content: old.content,
            summary: old.summary || null,
            merged_at: now,
            source_rowid: old.rowid,
            created_at: old.created_at,
          })
        }
        if (priors.length > 0) {
          try { priorsUpdateStmt.run(JSON.stringify(priors), newId) } catch (e) {
            log(`storeMemory: prior_versions update failed for ${newId}: ${e.message}`)
          }
        }
        // Point old records' superseded_by to the new id (chain pointer mechanism)
        let supCount = 0
        for (const oldRowid of supersedes) {
          const r = supersedeStmt.run(newId, oldRowid)
          if (r.changes > 0) supCount++
        }
        if (supCount > 0) log(`storeMemory: ${newId} supersedes ${supCount}/${supersedes.length} old memories (priors=${priors.length})`)
      }
    })
    tx()
    return newId
  } catch (e) {
    log(`storeMemory failed: ${e.message}`)
    return null
  }
}

// v2.4 (2026-06-22): store-time near-duplicate write-gate (R3 from the store-time research).
// DETECTION ONLY — never auto-blocks or auto-supersedes. engram has no LLM in the store
// path (local-first), and silently dropping a store risks losing a nuanced update, so the
// mechanical layer just surfaces the nearest existing memory; the caller (the agent, already
// in the loop) decides APPEND / UPDATE (re-store with supersedes) / ABORT. The CLAUDE.md
// "will this be recalled in another session?" gate is the prompt half of the same R3.
// Cosine is computed exactly on content_vector (metric-explicit) over the vec-KNN shortlist.
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}
function findNearDuplicates(db, embedding, excludeId, { topK = 5, threshold = 0.92 } = {}) {
  if (!_vecLoaded || !embedding) return []
  let cands
  try {
    cands = db.prepare(`
      SELECT m.rowid AS id, m.summary, m.content, m.content_vector
      FROM (SELECT memory_rowid, distance FROM memories_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
      JOIN memories m ON m.rowid = v.memory_rowid
      WHERE m.rowid != ? AND m.deleted_at IS NULL AND m.content_vector IS NOT NULL AND m.content_vector != ''
    `).all(new Float32Array(embedding), topK + 1, excludeId)
  } catch { return [] }
  const out = []
  for (const c of cands) {
    let v; try { v = JSON.parse(c.content_vector) } catch { continue }
    const cos = cosineSim(embedding, v)
    if (cos >= threshold) out.push({ id: c.id, cosine: +cos.toFixed(4), summary: c.summary || (c.content || '').slice(0, 60) })
  }
  return out.sort((a, b) => b.cosine - a.cosine)
}

/**
 * Async version: store memory + generate embedding vector.
 * opts.out (object): if provided, near-duplicate write-gate writes opts.out.nearDuplicates = [{id,cosine,summary}].
 * opts.dupThreshold (number): cosine floor for surfacing near-dups (default 0.92).
 */
export async function storeMemoryAsync(mem, opts = {}) {
  const id = storeMemory(mem)
  if (!id) return null

  const embedding = await generateEmbedding(mem.content)
  if (embedding) {
    const db = getDb()
    try {
      // Store JSON string in memories.content_vector (cross-tool visible + backup)
      db.prepare(`UPDATE memories SET content_vector = ? WHERE rowid = ?`)
        .run(JSON.stringify(embedding), id)
    } catch {}

    // Sync to sqlite-vec virtual table (for KNN queries)
    if (_vecLoaded) {
      try {
        db.prepare(`INSERT OR REPLACE INTO memories_vec(memory_rowid, embedding) VALUES (?, ?)`)
          .run(BigInt(id), new Float32Array(embedding))
      } catch (e) {
        log(`memories_vec insert failed (id=${id}): ${e.message}`)
      }
    }

    // Write-gate: surface near-duplicates (detection only) so caller can supersede vs bloat.
    if (opts.out) {
      try {
        const dups = findNearDuplicates(db, embedding, id, { threshold: opts.dupThreshold ?? 0.92 })
        if (dups.length) opts.out.nearDuplicates = dups
      } catch (e) { log(`near-dup check failed (id=${id}): ${e.message}`) }
    }
  }
  return id
}

/**
 * [2026-05-29 千夏] Self-heal sweep：给缺 content_vector 的活跃记忆补向量。
 * 堵漏——绕过 storeMemoryAsync 的写入路径（同步 storeMemory / CLI / staging 批处理）
 * 会让新记忆永久缺向量、对语义召回失明。MCP server 启动时 fire-and-forget 跑一遍，
 * 把"宕机/降级期间漏写的 NULL 向量"扫掉。幂等（只扫 NULL）、有 cap、维度校验拒绝混维。
 * @param {number} limit 单次最多补多少条（防一次性打爆 embedding API）
 * @returns {Promise<{scanned:number, embedded:number, failed:number, skipped?:string}>}
 */
export async function embedMissingVectors(limit = 200) {
  if (!_embeddingConfig) return { scanned: 0, embedded: 0, failed: 0, skipped: 'no_embedding_config' }
  const db = getDb()
  const rows = db.prepare(`
    SELECT rowid, content FROM memories
    WHERE deleted_at IS NULL AND (content_vector IS NULL OR content_vector = '')
    ORDER BY importance DESC, created_at DESC
    LIMIT ?
  `).all(limit)
  if (rows.length === 0) return { scanned: 0, embedded: 0, failed: 0 }
  const dim = _embeddingConfig.dimension
  const updateStmt = db.prepare(`UPDATE memories SET content_vector = ? WHERE rowid = ?`)
  let embedded = 0, failed = 0
  for (const row of rows) {
    try {
      const vec = await generateEmbedding(row.content)
      if (!vec || vec.length !== dim) { failed++; continue }  // 维度不符 → 拒绝写脏向量
      updateStmt.run(JSON.stringify(vec), row.rowid)
      if (_vecLoaded) {
        try {
          db.prepare(`INSERT OR REPLACE INTO memories_vec(memory_rowid, embedding) VALUES (?, ?)`)
            .run(BigInt(row.rowid), new Float32Array(vec))
        } catch (e) { log(`embedMissingVectors: memories_vec insert failed (${row.rowid}): ${e.message}`) }
      }
      embedded++
    } catch (e) { failed++; log(`embedMissingVectors: rowid ${row.rowid} failed: ${e.message}`) }
  }
  if (embedded || failed) log(`embedMissingVectors: scanned ${rows.length}, embedded ${embedded}, failed ${failed}`)
  return { scanned: rows.length, embedded, failed }
}

// ── Memory Retrieval (Core! AIRI-style composite scoring) ───

/**
 * Retrieve relevant memories
 *
 * Scoring strategy (AIRI-inspired):
 *   score = FTS_relevance * 0.4
 *         + importance/10 * 0.3
 *         + time_decay * 0.2
 *         + access_frequency * 0.1
 *
 * With Memory Transfer Learning overlay:
 *   final_score = base_score * level_weight
 *   where level_weight = { meta_knowledge: 1.3, semi_abstract: 1.0, concrete_trace: 0.7 }
 *
 * @param {Object} opts
 * @param {string} [opts.query] - query text
 * @param {string[]} [opts.types] - filter by memory types
 * @param {string[]} [opts.categories] - filter by categories
 * @param {string[]} [opts.tags] - tag filter (any match)
 * @param {number} [opts.minImportance] - minimum importance
 * @param {number} [opts.limit] - result count
 * @returns {Array}
 */
export function recallMemories(opts = {}) {
  const db = getDb()
  const { query: queryText, types, categories, tags, minImportance, limit = 10 } = opts
  const now = Date.now()
  const THIRTY_DAYS_MS = 30 * 86400_000

  let rows

  if (queryText) {
    // FTS5 search + structured filtering
    const ftsQueryParam = queryText.trim()

    const structuredConditions = ['m.deleted_at IS NULL']
    const structuredParams = []
    if (types?.length) {
      structuredConditions.push(`m.memory_type IN (${types.map(() => '?').join(',')})`)
      structuredParams.push(...types)
    }
    if (categories?.length) {
      structuredConditions.push(`m.category IN (${categories.map(() => '?').join(',')})`)
      structuredParams.push(...categories)
    }
    if (minImportance) {
      structuredConditions.push('m.importance >= ?')
      structuredParams.push(minImportance)
    }

    // Try FTS search
    if (ftsQueryParam) {
      try {
        // With simple extension: jieba OR query (filter stop words, any word match)
        // Without: fall back to character-level OR query
        const orQuery = _simpleLoaded
          ? buildJiebaOrQuery(ftsQueryParam)
          : queryText.replace(/["\u201c\u201d\u2018\u2019\u3010\u3011\uff08\uff09\u300a\u300b\uff0c\u3002\uff01\uff1f\u3001\uff1b\uff1a\s]+/g, ' ').trim()
              .split(/\s+/).filter(w => w.length > 0).map(w => `"${w}"`).join(' OR ')

        if (orQuery) {
          const sql = `
            SELECT m.rowid AS rowid, m.*, mf.rank AS fts_rank
            FROM memories m
            JOIN memories_fts mf ON mf.rowid = m.rowid
            WHERE memories_fts MATCH ?
              AND ${structuredConditions.join(' AND ')}
            ORDER BY mf.rank
            LIMIT ?
          `
          rows = db.prepare(sql).all(orQuery, ...structuredParams, limit * 3)
        }
      } catch (e) {
        log(`FTS query failed: ${e.message}`)
        rows = []
      }
    }

    // FTS returned nothing -> fallback to LIKE + structured filtering
    if (!rows || rows.length === 0) {
      const keywords = tokenizeForLike(queryText)
      const likeConditions = keywords.map(() => 'm.content LIKE ?')
      const likeParams = keywords.map(w => `%${w}%`)

      const sql = `
        SELECT m.rowid AS rowid, m.*, 0 AS fts_rank
        FROM memories m
        WHERE ${structuredConditions.join(' AND ')}
          ${likeConditions.length ? `AND (${likeConditions.join(' OR ')})` : ''}
        ORDER BY m.importance DESC, m.created_at DESC
        LIMIT ?
      `
      rows = db.prepare(sql).all(...structuredParams, ...likeParams, limit * 3)
    }
  } else {
    // No query text: sort by importance + time
    const conditions = ['deleted_at IS NULL']
    const params = []
    if (types?.length) {
      conditions.push(`memory_type IN (${types.map(() => '?').join(',')})`)
      params.push(...types)
    }
    if (categories?.length) {
      conditions.push(`category IN (${categories.map(() => '?').join(',')})`)
      params.push(...categories)
    }
    if (minImportance) {
      conditions.push('importance >= ?')
      params.push(minImportance)
    }

    const sql = `
      SELECT rowid, *, 0 AS fts_rank FROM memories
      WHERE ${conditions.join(' AND ')}
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `
    params.push(limit)
    rows = db.prepare(sql).all(...params)
  }

  // Composite scoring (AIRI-style + Memory Transfer Learning level weighting)
  const LEVEL_WEIGHT = { meta_knowledge: 1.3, semi_abstract: 1.0, concrete_trace: 0.7 }
  const scored = rows.map(row => {
    const ftsScore = row.fts_rank ? Math.min(1, Math.abs(row.fts_rank) / 10) : 0
    const importanceScore = row.importance / 10
    // migration 004 (v2.2): age based on event_time when set, else created_at fallback.
    // Lets temporal queries ("what did I do last June?") match by when the event happened,
    // not when it was recorded.
    const effectiveTime = row.event_time != null ? row.event_time : row.created_at
    const age = now - effectiveTime
    const timeScore = Math.max(0, 1 - age / THIRTY_DAYS_MS)
    // v2.4 (2026-06-22): align with hybrid path. ftsScore (already 0-1 ranged, unlike RRF)
    // leads at 0.55; importance demoted to weak prior 0.1; frequency log-damped (same form
    // as hybrid freqScore) at 0.2. R1: don't let saturated self-rated importance drive order.
    const accessScore = Math.min(1, Math.log1p(row.access_count || 0) / Math.log1p(20))
    const levelWeight = LEVEL_WEIGHT[row.memory_level] || 1.0

    const baseScore = (ftsScore * 0.55) + (accessScore * 0.2) + (timeScore * 0.15) + (importanceScore * 0.1)
    // migration 003: decay_score as multiplier (periodically updated by runDecayCycle)
    // Defaults to 1.0 for records that haven't been through a decay cycle — backward compatible
    const decay = (row.decay_score != null) ? row.decay_score : 1.0
    const score = baseScore * levelWeight * decay

    return { ...row, score, tags: safeJsonParse(row.tags, []), metadata: safeJsonParse(row.metadata, {}) }
  })

  // Tag filtering (application-layer, since SQLite has no array overlap operator)
  let filtered = scored
  if (tags?.length) {
    filtered = scored.filter(r => tags.some(t => r.tags.includes(t)))
  }

  // Sort by score descending, take top N
  filtered.sort((a, b) => b.score - a.score)
  let result = filtered.slice(0, limit)

  // migration 003: surfaced_random — when result < limit, 25% chance of pulling
  // 1-3 records from the cold pool (importance >= 8 AND 30d untouched AND decay >= 0.3)
  // Skipped when called internally by recallMemoriesHybrid (avoid double-surfacing)
  if (!opts._internal && queryText && result.length < limit) {
    const surfaced = surfaceRandomMemories(db, result.map(r => r.rowid), limit - result.length, now)
    if (surfaced.length > 0) result = result.concat(surfaced)
  }

  // Update last_accessed
  if (result.length > 0) {
    const updateStmt = db.prepare(`
      UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE rowid = ?
    `)
    const updateMany = db.transaction((items) => {
      for (const item of items) updateStmt.run(now, item.rowid)
    })
    try { updateMany(result) } catch {}
  }

  // Search miss tracking: queried but found nothing = knowledge blind spot signal
  if (queryText && result.length === 0) {
    try {
      db.prepare('INSERT INTO search_misses (query, source, hit_count) VALUES (?, ?, 0)')
        .run(queryText.slice(0, 500), 'recall')
    } catch {}
  }

  return result
}

// ── Hybrid Retrieval: FTS5 + Vector + RRF Fusion ────────────
//
// Principle:
//   1. FTS5 path: keyword/lexical matching (strong for exact queries)
//   2. Vector path: semantic matching (synonyms, paraphrases)
//   3. RRF (Reciprocal Rank Fusion): score = sum(1/(k + rank)), k=60
//      Uses only ranks, not raw scores — merges lists of different scales fairly
//
// Performance:
//   - One embedding API call (~120ms for query vector)
//   - Local FTS + vec KNN parallel, both sub-millisecond
//   - Total latency ~150ms (FTS alone <10ms, rest is embedding API network)

const RRF_K = 60

/**
 * Hybrid retrieval: FTS5 + Vector + RRF Fusion
 * @param {Object} opts  same as recallMemories
 * @returns {Promise<Array>}
 */
// Entity retrieval path (v2.5): query → matched entities (pure SQL, ZERO LLM) → memories that
// mention them, filtered to LIVE rows (deleted_at IS NULL AND superseded_by IS NULL — keeps
// soft-deleted/superseded memories from resurfacing via a stale mention edge). Returned as a
// ranked list; the caller feeds it into RRF as a 4th source (never an additive boost).
// Cached entity list (aliases pre-parsed) for the recall path. Loading all entities every
// recall was ~5ms at 6k entities — over the latency budget. A cheap count:maxId signature
// detects changes (incl. from the separate backfill/extraction process) and reloads only then.
function getEntityList(db) {
  let sig
  try {
    const r = db.prepare(`SELECT COUNT(*) c, COALESCE(MAX(id), 0) m FROM entities WHERE deleted_at IS NULL`).get()
    sig = `${r.c}:${r.m}`
  } catch { return [] }  // entities table absent (pre-migration-007 db) → no entity path, graceful
  if (_entityCache && _entityCacheSig === sig) return _entityCache
  _entityCache = db.prepare(`SELECT id, normalized, aliases FROM entities WHERE deleted_at IS NULL`)
    .all().map(e => ({ id: e.id, normalized: e.normalized, aliases: safeJsonParse(e.aliases, []).map(normalizeEntityName) }))
  _entityCacheSig = sig
  return _entityCache
}

function findEntityMatchedMemories(db, queryText, limit) {
  const qNorm = normalizeEntityName(queryText)
  if (qNorm.length < 2) return []
  const ents = getEntityList(db)
  if (!ents.length) return []
  const matchedIds = []
  for (const e of ents) {
    if (e.normalized && e.normalized.length >= 2 && qNorm.includes(e.normalized)) { matchedIds.push(e.id); continue }
    if (e.aliases.some(n => n.length >= 2 && qNorm.includes(n))) matchedIds.push(e.id)
  }
  if (!matchedIds.length) return []
  const ph = matchedIds.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT m.rowid AS rowid, m.*, COUNT(DISTINCT me.entity_id) AS ent_hits
    FROM mentions me JOIN memories m ON m.rowid = me.memory_rowid
    WHERE me.entity_id IN (${ph}) AND m.deleted_at IS NULL AND m.superseded_by IS NULL
    GROUP BY m.rowid
    ORDER BY ent_hits DESC, m.last_accessed DESC
    LIMIT ?
  `).all(...matchedIds, limit)
  return rows.map(r => ({ ...r, tags: safeJsonParse(r.tags, []), metadata: safeJsonParse(r.metadata, {}) }))
}

export async function recallMemoriesHybrid(opts = {}) {
  const { query: queryText, limit = 10 } = opts

  // No query or extensions not ready -> fall back to sync version
  if (!queryText || !_vecLoaded || !_embeddingConfig) {
    return recallMemories(opts)
  }

  const db = getDb()
  const now = Date.now()
  const THIRTY_DAYS_MS = 30 * 86400_000
  const LEVEL_WEIGHT = { meta_knowledge: 1.3, semi_abstract: 1.0, concrete_trace: 0.7 }

  // Parallel: vector query (get embedding) + FTS query
  // _internal=true so the FTS path doesn't also surface random records (hybrid surfaces once at the end)
  const [queryEmbedding, ftsRows] = await Promise.all([
    generateEmbedding(queryText),
    Promise.resolve(recallMemories({ ...opts, limit: limit * 3, _internal: true })),
  ])

  // Vector path: KNN top N
  let vecRows = []
  if (queryEmbedding) {
    try {
      vecRows = db.prepare(`
        SELECT m.rowid AS rowid, m.*, v.distance AS vec_distance
        FROM (
          SELECT memory_rowid, distance
          FROM memories_vec
          WHERE embedding MATCH ?
          ORDER BY distance
          LIMIT ?
        ) AS v
        JOIN memories m ON m.rowid = v.memory_rowid
        WHERE m.deleted_at IS NULL
      `).all(new Float32Array(queryEmbedding), limit * 3)
      vecRows = vecRows.map(r => ({
        ...r,
        tags: safeJsonParse(r.tags, []),
        metadata: safeJsonParse(r.metadata, {}),
      }))
    } catch (e) {
      log(`Vec KNN failed: ${e.message}`)
    }
  }

  // RRF Fusion
  const rrfScores = new Map()
  const addRanks = (rows, source) => {
    rows.forEach((row, idx) => {
      const rowid = row.rowid
      if (!rowid) return
      const contribution = 1 / (RRF_K + idx + 1)
      const existing = rrfScores.get(rowid)
      if (existing) {
        existing.rrf += contribution
        existing.sources.push(source)
        // First-seen row object wins the merge (usually the FTS row), which lacks
        // vec_distance — graft it from the vec-list duplicate so downstream
        // consumers (semantic-inject gating) can threshold on it.
        if (row.vec_distance != null && existing.row.vec_distance == null) {
          existing.row.vec_distance = row.vec_distance
        }
      } else {
        rrfScores.set(rowid, { row, rrf: contribution, sources: [source] })
      }
    })
  }
  addRanks(ftsRows, 'fts')
  addRanks(vecRows, 'vec')
  // v2.5: entity path as RRF 4th source (ranked list, NOT an additive boost — additive at any
  // weight > the rrf*10 spread (~0.16) would re-drown relevance, the exact v2.4 fix). Pure SQL.
  // opts._noEntity skips it (A/B harness baseline only).
  if (!opts._noEntity) addRanks(findEntityMatchedMemories(db, queryText, limit * 3), 'entity')

  // Apply Memory Transfer Learning level weighting + importance + time decay + decay_score (migration 003)
  const merged = Array.from(rrfScores.values()).map(({ row, rrf, sources }) => {
    const levelWeight = LEVEL_WEIGHT[row.memory_level] || 1.0
    const importanceScore = row.importance / 10
    // migration 004 (v2.2): age based on event_time when set, else created_at fallback
    const effectiveTime = row.event_time != null ? row.event_time : row.created_at
    const age = now - effectiveTime
    const timeScore = Math.max(0, 1 - age / THIRTY_DAYS_MS)
    // v2.4 (2026-06-22): relevance-leads rescale. The old `rrf * 0.7` drowned relevance:
    // RRF magnitude is ~0.016 (1/(60+rank)) so its spread across a candidate list is
    // ~0.0016, while importance*0.2 spread is ~0.06 — importance out-weighed relevance
    // ~37x. A/B (7 queries on a live-DB copy): under old weights the single most-relevant
    // item landed at avg rank 16/30. Rescaling rrf to x10 puts it at rank 2.1 and drops
    // importance to a weak prior (R1 from the 2026-06-22 store-time research: don't let
    // self-rated importance drive ranking — it's 92.5% saturated >=7, i.e. pure noise).
    // freqScore: HMO hit-frequency (arXiv 2604.01670, ln+cap dampens the
    // recalled->access++->ranked-higher loop), now the primary structural tiebreak.
    const freqScore = Math.min(1, Math.log1p(row.access_count || 0) / Math.log1p(20))
    const decay = (row.decay_score != null) ? row.decay_score : 1.0
    const score = (rrf * 10 + freqScore * 0.10 + timeScore * 0.06 + importanceScore * 0.05) * levelWeight * decay
    return { ...row, score, rrf, recall_sources: sources }
  })

  merged.sort((a, b) => b.score - a.score)
  let result = merged.slice(0, limit)

  // migration 003: surfaced_random — when hybrid result < limit, 25% chance of cold pool surface
  if (result.length < limit) {
    const surfaced = surfaceRandomMemories(db, result.map(r => r.rowid), limit - result.length, now)
    if (surfaced.length > 0) result = result.concat(surfaced)
  }

  // Update last_accessed
  if (result.length > 0) {
    const stmt = db.prepare(`UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE rowid = ?`)
    const tx = db.transaction((items) => { for (const item of items) stmt.run(now, item.rowid) })
    try { tx(result) } catch {}
  }

  // Search miss tracking (both paths empty = miss)
  if (result.length === 0) {
    try {
      db.prepare('INSERT INTO search_misses (query, source, hit_count) VALUES (?, ?, 0)')
        .run(queryText.slice(0, 500), 'hybrid')
    } catch {}
  }

  return result
}

// ── Conversation History Retrieval ──────────────────────────

/**
 * Get recent N conversations (AIRI-style findLastNMessages)
 */
export function getRecentConversations(chatId, limit = 20) {
  const db = getDb()
  try {
    return db.prepare(`
      SELECT id, platform, from_id, from_name, role, content, created_at, metadata
      FROM conversations
      WHERE chat_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(chatId, limit).reverse()
  } catch (e) {
    log(`getRecentConversations failed: ${e.message}`)
    return []
  }
}

/**
 * Search relevant conversations + context window expansion (AIRI-style findRelevantMessages)
 */
export function searchConversations(queryText, opts = {}) {
  const db = getDb()
  const { chatId, limit = 3, contextWindow = 3 } = opts

  if (!queryText?.trim()) return []

  try {
    let anchorSQL, anchorParams
    if (_simpleLoaded) {
      const convOrQuery = buildJiebaOrQuery(queryText) || queryText.trim()
      anchorSQL = `
        SELECT c.rowid, c.chat_id, c.created_at, cf.rank AS fts_rank
        FROM conversations c
        JOIN conversations_fts cf ON cf.rowid = c.rowid
        WHERE conversations_fts MATCH ?
          ${chatId ? 'AND c.chat_id = ?' : ''}
        ORDER BY cf.rank
        LIMIT ?
      `
      anchorParams = [convOrQuery]
    } else {
      const ftsQuery = queryText
        .replace(/["\u201c\u201d\u2018\u2019\u3010\u3011\uff08\uff09\u300a\u300b\uff0c\u3002\uff01\uff1f\u3001\uff1b\uff1a]/g, ' ')
        .split(/\s+/).filter(w => w.length > 0).map(w => `"${w}"`).join(' OR ')
      if (!ftsQuery) return []
      anchorSQL = `
        SELECT c.rowid, c.chat_id, c.created_at, cf.rank AS fts_rank
        FROM conversations c
        JOIN conversations_fts cf ON cf.rowid = c.rowid
        WHERE conversations_fts MATCH ?
          ${chatId ? 'AND c.chat_id = ?' : ''}
        ORDER BY cf.rank
        LIMIT ?
      `
      anchorParams = [ftsQuery]
    }
    if (chatId) anchorParams.push(chatId)
    anchorParams.push(limit)

    const anchors = db.prepare(anchorSQL).all(...anchorParams)
    if (anchors.length === 0) {
      try {
        db.prepare('INSERT INTO search_misses (query, source, hit_count) VALUES (?, ?, 0)')
          .run(queryText.slice(0, 500), 'search_conversations')
      } catch {}
      return []
    }

    const contextStmt = db.prepare(`
      SELECT id, platform, from_id, from_name, role, content, created_at
      FROM (
        SELECT * FROM conversations WHERE chat_id = ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?
      )
      UNION ALL
      SELECT id, platform, from_id, from_name, role, content, created_at
      FROM (
        SELECT * FROM conversations WHERE chat_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT ?
      )
      ORDER BY created_at ASC
    `)

    return anchors.map(anchor => ({
      score: Math.abs(anchor.fts_rank),
      messages: contextStmt.all(
        anchor.chat_id, anchor.created_at, contextWindow + 1,
        anchor.chat_id, anchor.created_at, contextWindow,
      ),
    }))
  } catch (e) {
    log(`searchConversations failed: ${e.message}`)
    return []
  }
}

// ── Build Memory Context (core function for system prompt injection) ──

/**
 * Build memory context for current message
 * Combines: relevant memories + relevant conversation history + active goals
 *
 * @param {Object} opts
 * @param {string} opts.query - current user message
 * @param {string} [opts.chatId] - current chat ID
 * @param {number} [opts.memoryLimit] - number of memories to recall
 * @returns {Promise<string>} formatted memory context (empty string if none)
 */
export async function buildMemoryContext(opts = {}) {
  const { query: queryText, chatId, memoryLimit = 8 } = opts
  const sections = []

  // 1. Relevant memories (use hybrid when query available; inject high-importance base memories otherwise)
  const memories = queryText
    ? await recallMemoriesHybrid({ query: queryText, limit: memoryLimit, minImportance: 3 })
    : recallMemories({ limit: memoryLimit, minImportance: 7 })

  if (memories.length > 0) {
    const memLines = memories.map(m => {
      const prefix = { permanent: '[PIN]', long_term: '[LT]', short_term: '[ST]', working: '[W]' }[m.memory_type] || '[?]'
      const levelMark = { meta_knowledge: ' [pattern]', semi_abstract: '', concrete_trace: ' [trace]' }[m.memory_level] || ''
      // migration 003: mark surfaced_random records so callers know it's an "out of context" recall
      const surfaceMark = m.recall_source === 'surfaced_random' ? ' [surfaced]' : ''
      const tagStr = m.tags?.length ? ` [${m.tags.join(', ')}]` : ''
      const age = Math.floor((Date.now() - m.created_at) / 86400_000)
      const ageStr = age === 0 ? 'today' : age === 1 ? 'yesterday' : `${age}d ago`
      const text = m.summary || m.content.slice(0, 200)
      return `${prefix}${levelMark}${surfaceMark} (${m.category}, importance:${m.importance}, ${ageStr})${tagStr}\n   ${text}`
    })
    sections.push(`<recalled-memories>\n${memLines.join('\n')}\n</recalled-memories>`)
  }

  // 2. Relevant conversation history segments
  if (queryText) {
    const segments = searchConversations(queryText, { chatId, limit: 2, contextWindow: 3 })
    if (segments.length > 0) {
      const convLines = segments.map(seg => {
        return seg.messages.map(m => {
          const time = new Date(Number(m.created_at)).toISOString().slice(0, 16)
          return `  [${time}] ${m.from_name || m.role}: ${m.content.slice(0, 150)}`
        }).join('\n')
      })
      sections.push(`<relevant-conversations>\n${convLines.join('\n---\n')}\n</relevant-conversations>`)
    }
  }

  // 3. Active goals
  try {
    const goals = getDb().prepare(`
      SELECT title, description, priority, progress, status
      FROM goals
      WHERE deleted_at IS NULL AND status IN ('planned', 'in_progress')
      ORDER BY priority DESC LIMIT 5
    `).all()

    if (goals.length > 0) {
      const goalLines = goals.map(g =>
        `- [${g.status === 'in_progress' ? 'in progress' : 'planned'}] ${g.title} (P${g.priority}, ${g.progress}%)${g.description ? ': ' + g.description.slice(0, 80) : ''}`
      )
      sections.push(`<active-goals>\n${goalLines.join('\n')}\n</active-goals>`)
    }
  } catch {}

  if (sections.length === 0) return ''

  return [
    '',
    '## Agent Memory System (auto-recalled)',
    'The following are memories and history relevant to the current conversation. Reference as needed:',
    '',
    ...sections,
  ].join('\n')
}

// ── migration 003: surfaced_random pool ─────────────────────
// When recall result count < limit, with 25% probability, surface 1-3 records
// from the cold pool: importance >= 8 AND last_accessed < (now - 30d)
//   AND decay_score >= 0.3 AND deleted_at IS NULL AND superseded_by IS NULL.
// Models the "I just remembered something" feeling — covers cold-recall blind
// spots and lets long-decayed but still-important memories resurface.
const SURFACE_RANDOM_PROB = 0.25
const SURFACE_RANDOM_MAX = 3
const SURFACE_AGE_MS = 30 * 86400_000
const SURFACE_DECAY_FLOOR = 0.3
const SURFACE_IMPORTANCE_MIN = 8

function surfaceRandomMemories(db, excludeRowids, slotsAvailable, nowMs) {
  if (slotsAvailable <= 0) return []
  if (Math.random() > SURFACE_RANDOM_PROB) return []
  const cutoff = nowMs - SURFACE_AGE_MS
  const take = Math.min(SURFACE_RANDOM_MAX, slotsAvailable)
  const excludeClause = excludeRowids?.length
    ? `AND rowid NOT IN (${excludeRowids.map(() => '?').join(',')})`
    : ''
  try {
    const rows = db.prepare(`
      SELECT rowid, * FROM memories
      WHERE deleted_at IS NULL
        AND superseded_by IS NULL
        AND importance >= ?
        AND last_accessed < ?
        AND decay_score >= ?
        ${excludeClause}
      ORDER BY RANDOM()
      LIMIT ?
    `).all(SURFACE_IMPORTANCE_MIN, cutoff, SURFACE_DECAY_FLOOR, ...(excludeRowids || []), take)
    return rows.map(r => ({
      ...r,
      score: 0,
      tags: safeJsonParse(r.tags, []),
      metadata: safeJsonParse(r.metadata, {}),
      recall_source: 'surfaced_random',  // callers can distinguish from query matches
    }))
  } catch (e) {
    log(`surfaceRandomMemories failed: ${e.message}`)
    return []
  }
}

// ── Memory Management ───────────────────────────────────────

/** Clean up expired memories (both TTL path and supersede chain) */
export function expireMemories() {
  const db = getDb()
  try {
    // Path 1: TTL-based expiry
    const r1 = db.prepare(`
      UPDATE memories
      SET deleted_at = unixepoch() * 1000
      WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at < unixepoch() * 1000
    `).run()
    // Path 2: superseded_by soft-delete (migration 001)
    const r2 = db.prepare(`
      UPDATE memories
      SET deleted_at = unixepoch() * 1000
      WHERE deleted_at IS NULL AND superseded_by IS NOT NULL
    `).run()
    if (r1.changes > 0 || r2.changes > 0) {
      log(`Expired: ${r1.changes} ttl + ${r2.changes} superseded`)
    }
    return r1.changes + r2.changes
  } catch { return 0 }
}

/** Memory promotion: working -> short_term -> long_term */
export function promoteMemories() {
  const db = getDb()
  try {
    const r1 = db.prepare(`
      UPDATE memories
      SET memory_type = 'short_term',
          expires_at = unixepoch() * 1000 + 604800000,
          updated_at = unixepoch() * 1000
      WHERE memory_type = 'working' AND deleted_at IS NULL
        AND (access_count >= 3 OR importance >= 7)
    `).run()

    const r2 = db.prepare(`
      UPDATE memories
      SET memory_type = 'long_term',
          expires_at = NULL,
          updated_at = unixepoch() * 1000
      WHERE memory_type = 'short_term' AND deleted_at IS NULL
        AND (access_count >= 8 OR importance >= 8)
    `).run()

    if (r1.changes || r2.changes) {
      log(`Promoted: ${r1.changes} -> short_term, ${r2.changes} -> long_term`)
    }
  } catch (e) {
    log(`promoteMemories failed: ${e.message}`)
  }
}

// migration 003: power-law decay cycle
//   w(t) = (1 + t/tau)^(-b_eff)
//   tau    = 24h (configurable)
//   b_base = 0.7
//   b_eff  = b_base / (1 + importance / 10)
//     importance=1  -> b_eff ~ 0.64 (decays faster)
//     importance=10 -> b_eff ~ 0.35 (decays slower)
//
//   final = min(1.0, w * (1 + min(10, access_count) * 0.3))
//     access_count is capped at 10 to prevent runaway boost on hot records.
//
// Intended to run alongside expireMemories / promoteMemories on a periodic
// schedule (e.g. setInterval in a maintenance daemon).
//
// Options:
//   { tauHours = 24, bBase = 0.7, dryRun = false }
// Returns:
//   { processed, distribution: {high, mid, low, cold}, sample? }
export function runDecayCycle(opts = {}) {
  const { tauHours = 24, bBase = 0.7, dryRun = false } = opts
  const db = getDb()
  const now = Date.now()
  const tauMs = tauHours * 3600_000
  let processed = 0
  const distribution = { high: 0, mid: 0, low: 0, cold: 0 }  // >=0.7 / 0.3-0.7 / 0.1-0.3 / <0.1
  const sample = []

  try {
    const rows = db.prepare(`
      SELECT rowid, importance, access_count, created_at
      FROM memories
      WHERE deleted_at IS NULL AND superseded_by IS NULL
    `).all()

    const items = rows.map(r => {
      const t = Math.max(0, now - r.created_at)
      const importance = r.importance || 5
      const bEff = bBase / (1 + importance / 10)
      const w = Math.pow(1 + t / tauMs, -bEff)
      const reuseBoost = 1 + Math.min(10, r.access_count || 0) * 0.3
      const score = Math.min(1.0, w * reuseBoost)
      if (score >= 0.7) distribution.high++
      else if (score >= 0.3) distribution.mid++
      else if (score >= 0.1) distribution.low++
      else distribution.cold++
      return { rowid: r.rowid, score }
    })

    if (dryRun) {
      const stride = Math.max(1, Math.floor(items.length / 10))
      for (let i = 0; i < items.length; i += stride) sample.push(items[i])
      return { processed: items.length, distribution, sample, dryRun: true }
    }

    const updateStmt = db.prepare(`UPDATE memories SET decay_score = ? WHERE rowid = ?`)
    const tx = db.transaction((batch) => {
      for (const it of batch) updateStmt.run(it.score, it.rowid)
    })
    tx(items)
    processed = items.length
    log(`runDecayCycle: ${processed} memories updated (high=${distribution.high} mid=${distribution.mid} low=${distribution.low} cold=${distribution.cold})`)
    return { processed, distribution }
  } catch (e) {
    log(`runDecayCycle failed: ${e.message}`)
    return { processed, distribution, error: e.message }
  }
}

// v2.4 (2026-06-22): frequency-driven memory_level hysteresis migration.
// Store-time level self-assessment caused 84% meta inflation — the writing agent
// over-rates its own output. This re-levels by OBSERVED recall frequency (access_count)
// + age, not by what the caller declared. Deliberately demote-biased (that's what
// fights inflation). Promotion to meta stays a deliberate human/curation act — frequency
// alone does not make something a cross-context heuristic, and auto-promoting to meta
// would just re-inflate it; only concrete->semi auto-migrates upward. No symmetric
// auto-transition crosses the same boundary, so levels can't flap (implicit hysteresis).
// Skips memory_type='permanent' (isStatic-style invariants), superseded, deleted.
//
// Rules:
//   meta -> semi     : access_count=0 AND age>30d, OR access_count<=2 AND age>90d   (stale, never/barely recalled)
//   concrete -> semi : access_count>=6                                               (heavily recalled, mis-leveled)
//   concrete imp>5   : clamp importance to 5                                          (concrete-importance invariant)
//
// Options: { limit = Infinity, dryRun = false, anchorPath = null }
//   limit      — bound nightly autosleep (e.g. 30); omit for the one-time backfill.
//   anchorPath — write a JSONL rollback anchor {rowid, old_level, old_importance} BEFORE mutating.
//                Roll back with: UPDATE memories SET memory_level=?, importance=? WHERE rowid=? per line.
// Returns { scanned, candidates, demoted, promoted, clamped, anchor }
export function runLevelMigration(opts = {}) {
  const { limit = Infinity, dryRun = false, anchorPath = null } = opts
  const db = getDb()
  const now = Date.now()
  const D30 = 30 * 86400_000, D90 = 90 * 86400_000
  const out = { scanned: 0, candidates: 0, demoted: 0, promoted: 0, clamped: 0, anchor: anchorPath || null }
  try {
    const rows = db.prepare(`
      SELECT rowid, memory_level, importance, access_count, created_at
      FROM memories
      WHERE deleted_at IS NULL AND superseded_by IS NULL AND memory_type != 'permanent'
    `).all()
    out.scanned = rows.length
    const changes = []
    for (const r of rows) {
      const age = now - r.created_at
      const ac = r.access_count || 0
      let newLevel = r.memory_level, newImp = r.importance
      if (r.memory_level === 'meta_knowledge') {
        if ((ac === 0 && age > D30) || (ac <= 2 && age > D90)) newLevel = 'semi_abstract'
      } else if (r.memory_level === 'concrete_trace') {
        if (ac >= 6) newLevel = 'semi_abstract'
        if (newImp > 5) newImp = 5
      }
      if (newLevel !== r.memory_level || newImp !== r.importance) {
        changes.push({ rowid: r.rowid, old_level: r.memory_level, new_level: newLevel, old_importance: r.importance, new_importance: newImp })
      }
    }
    const bounded = Number.isFinite(limit) ? changes.slice(0, limit) : changes
    out.candidates = bounded.length
    const tally = (c) => {
      if (c.new_level !== c.old_level) { if (c.old_level === 'meta_knowledge') out.demoted++; else out.promoted++ }
      if (c.new_importance !== c.old_importance) out.clamped++
    }
    if (dryRun) {
      for (const c of bounded) tally(c)
      return { ...out, dryRun: true, sample: bounded.slice(0, 8) }
    }
    // Persist rollback anchor BEFORE mutating (crash-safe: anchor on disk first).
    if (anchorPath && bounded.length) {
      writeFileSync(anchorPath, bounded.map(c =>
        JSON.stringify({ rowid: c.rowid, old_level: c.old_level, old_importance: c.old_importance })).join('\n') + '\n')
    }
    const stmt = db.prepare(`UPDATE memories SET memory_level = ?, importance = ?, updated_at = ? WHERE rowid = ?`)
    const tx = db.transaction((batch) => { for (const c of batch) { stmt.run(c.new_level, c.new_importance, now, c.rowid); tally(c) } })
    tx(bounded)
    log(`runLevelMigration: scanned=${out.scanned} demoted=${out.demoted} promoted=${out.promoted} clamped=${out.clamped}${anchorPath ? ' anchor=' + anchorPath : ''}`)
    return out
  } catch (e) {
    log(`runLevelMigration failed: ${e.message}`)
    return { ...out, error: e.message }
  }
}

// migration 004 follow-up (v2.2): inspect memories by rowid(s) — no recall scoring,
// no access_count bump, raw fetch. Use cases:
//   - caller got [id:N] from recall_memory and wants full content (no preview truncation)
//   - supersede flow: preview old rowids before committing
//   - follow prior_versions[].source_rowid for audit / chain inspection
export function getMemoriesByIds(ids, opts = {}) {
  if (!Array.isArray(ids) || ids.length === 0) return []
  const { includeDeleted = false } = opts
  const db = getDb()
  // Accept string or number; rowid is INTEGER but storeMemory returns String(lastInsertRowid)
  const normalized = ids.map(String).filter(s => /^\d+$/.test(s))
  if (normalized.length === 0) return []
  const placeholders = normalized.map(() => '?').join(',')
  const deletedClause = includeDeleted ? '' : ' AND deleted_at IS NULL'
  const rows = db.prepare(`
    SELECT rowid, * FROM memories
    WHERE rowid IN (${placeholders})${deletedClause}
  `).all(...normalized)
  // Preserve caller's input order (callers expect 1:1 correspondence)
  const byId = new Map(rows.map(r => [String(r.rowid), r]))
  return normalized.map(id => byId.get(id)).filter(Boolean).map(r => ({
    ...r,
    tags: safeJsonParse(r.tags, []),
    metadata: safeJsonParse(r.metadata, {}),
    prior_versions: safeJsonParse(r.prior_versions, []),
  }))
}

// ── Goal Management ─────────────────────────────────────────

export function upsertGoal(goal) {
  const db = getDb()
  if (goal.id) {
    db.prepare(`
      UPDATE goals SET title = coalesce(?, title), description = coalesce(?, description),
        priority = coalesce(?, priority), progress = coalesce(?, progress),
        status = coalesce(?, status), updated_at = unixepoch() * 1000
      WHERE id = ?
    `).run(goal.title, goal.description, goal.priority, goal.progress, goal.status, goal.id)
    return goal.id
  } else {
    const info = db.prepare(`
      INSERT INTO goals (title, description, priority, progress, status, category)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(goal.title, goal.description || '', goal.priority || 5, goal.progress || 0,
           goal.status || 'planned', goal.category || 'project')
    return info.lastInsertRowid ? String(info.lastInsertRowid) : null
  }
}

// ── Statistics ───────────────────────────────────────────────

export function getMemoryStats() {
  const db = getDb()
  try {
    const mem = db.prepare(`
      SELECT
        SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS total_active,
        SUM(CASE WHEN memory_type = 'working' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS working,
        SUM(CASE WHEN memory_type = 'short_term' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS short_term,
        SUM(CASE WHEN memory_type = 'long_term' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS long_term,
        SUM(CASE WHEN memory_type = 'permanent' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS permanent
      FROM memories
    `).get()
    const conv = db.prepare(`SELECT COUNT(*) AS count FROM conversations`).get()

    // [2026-05-29 千夏] 向量覆盖率：active 记忆中有 content_vector 的比例。
    // 用于 /health 主动告警——掉线/漏写时 coverage 会跌，watchdog 据此报警，
    // 而不是靠人偶然调 memory_stats 才发现"FTS5 only"。
    const vecCov = db.prepare(`
      SELECT
        SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN deleted_at IS NULL AND content_vector IS NOT NULL AND content_vector != '' THEN 1 ELSE 0 END) AS with_vec
      FROM memories
    `).get()
    const vectorCoverage = vecCov?.active ? +((vecCov.with_vec || 0) / vecCov.active).toFixed(4) : null
    const goals = db.prepare(`
      SELECT COUNT(*) AS count FROM goals WHERE deleted_at IS NULL AND status IN ('planned', 'in_progress')
    `).get()

    const raw = (mem?.working || 0) + (mem?.short_term || 0)
    const terminal = Math.max(1, (mem?.long_term || 0) + (mem?.permanent || 0))
    const compressionPressure = +(raw / terminal).toFixed(2)

    const thirtyDaysAgo = Date.now() - 30 * 86400_000
    const deadKnowledge = db.prepare(`
      SELECT COUNT(*) AS count FROM memories
      WHERE deleted_at IS NULL
        AND memory_type IN ('long_term', 'permanent')
        AND last_accessed < ?
    `).get(thirtyDaysAgo)

    const sevenDaysAgo = Date.now() - 7 * 86400_000
    let recentMisses = 0
    try {
      recentMisses = db.prepare(
        'SELECT COUNT(*) AS count FROM search_misses WHERE created_at > ?'
      ).get(sevenDaysAgo)?.count || 0
    } catch {}

    return {
      memories: {
        total_active: mem?.total_active || 0,
        working: mem?.working || 0,
        short_term: mem?.short_term || 0,
        long_term: mem?.long_term || 0,
        permanent: mem?.permanent || 0,
      },
      conversations: conv?.count || 0,
      activeGoals: goals?.count || 0,
      compressionPressure,
      deadKnowledge: deadKnowledge?.count || 0,
      recentSearchMisses: recentMisses,
      embeddingConfigured: !!_embeddingConfig,
      vectorCoverage,
    }
  } catch (e) {
    return { error: e.message }
  }
}

// ── Session Transcript Indexing ──────────────────────────────

/**
 * Index Claude Code session .jsonl files into conversations table
 * Scans ~/.claude/projects/ for all .jsonl files, extracts user + assistant text
 */
export function indexSessionTranscripts() {
  const db = getDb()
  const projectsDir = resolve(process.env.HOME || process.env.USERPROFILE || '', '.claude/projects')

  if (!existsSync(projectsDir)) {
    log('Session indexing: projects dir not found')
    return { indexed: 0, skipped: 0 }
  }

  let indexed = 0, skipped = 0

  const { readdirSync, statSync } = require('node:fs')
  const jsonlFiles = []

  function scanDir(dir) {
    try {
      for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry)
        try {
          const st = statSync(full)
          if (st.isDirectory()) scanDir(full)
          else if (entry.endsWith('.jsonl')) jsonlFiles.push(full)
        } catch {}
      }
    } catch {}
  }
  scanDir(projectsDir)

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO conversations
      (id, platform, chat_id, from_id, from_name, role, content, created_at, metadata)
    VALUES (?, 'claude-code', ?, ?, ?, ?, ?, ?, '{}')
  `)

  const insertMany = db.transaction((msgs) => {
    for (const m of msgs) {
      insertStmt.run(m.id, m.chatId, m.fromId, m.fromName, m.role, m.content, m.createdAt)
    }
  })

  for (const file of jsonlFiles) {
    const sessionId = file.match(/([a-f0-9-]{36})\.jsonl$/)?.[1]
    if (!sessionId) continue

    const existing = db.prepare('SELECT 1 FROM conversations WHERE chat_id = ? AND platform = ? LIMIT 1')
      .get(sessionId, 'claude-code')
    if (existing) { skipped++; continue }

    try {
      const content = readFileSync(file, 'utf-8')
      const batch = []

      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line)
          if (!obj.timestamp || !obj.message?.content) continue

          const ts = new Date(obj.timestamp).getTime()
          if (isNaN(ts)) continue

          if (obj.type === 'user' && typeof obj.message.content === 'string') {
            const text = obj.message.content.trim()
            if (text.length > 0 && text.length < 5000) {
              batch.push({
                id: obj.uuid || `cc-${sessionId}-${ts}`,
                chatId: sessionId,
                fromId: 'user',
                fromName: 'user',
                role: 'user',
                content: text,
                createdAt: ts,
              })
            }
          } else if (obj.type === 'assistant') {
            const blocks = Array.isArray(obj.message.content) ? obj.message.content : []
            const textParts = blocks
              .filter(b => b.type === 'text' && b.text)
              .map(b => b.text.trim())
              .filter(t => t.length > 0)
            const fullText = textParts.join('\n').slice(0, 5000)
            if (fullText.length > 0) {
              batch.push({
                id: obj.uuid || `cc-${sessionId}-${ts}`,
                chatId: sessionId,
                fromId: 'assistant',
                fromName: 'claude',
                role: 'assistant',
                content: fullText,
                createdAt: ts,
              })
            }
          }
        } catch {}
      }

      if (batch.length > 0) {
        insertMany(batch)
        indexed++
        log(`Session indexed: ${sessionId} (${batch.length} messages)`)
      }
    } catch (e) {
      log(`Session index failed for ${sessionId}: ${e.message}`)
    }
  }

  return { indexed, skipped, totalFiles: jsonlFiles.length }
}

// ── Conversation Compression ────────────────────────────────
// Summarize old conversation segments into 1 long_term memory
// Trigger: CLI command, hooks, or manual invocation

/**
 * Compress old conversations for a given chat_id into a summary memory
 * Uses a fast LLM (e.g., Claude Haiku) for summarization
 *
 * @param {Object} opts
 * @param {string} opts.chatId - target chat_id
 * @param {number} opts.olderThanDays - compress conversations older than this, default 30
 * @param {number} opts.minMessages - minimum messages to trigger compression, default 20
 * @returns {Promise<{compressed: boolean, reason?: string, memoryId?: string}>}
 */
export async function compressOldConversations(opts = {}) {
  const { chatId, olderThanDays = 30, minMessages = 20 } = opts
  const db = getDb()
  const cutoff = Date.now() - olderThanDays * 86400_000

  // 1. Find target conversations
  const rows = db.prepare(`
    SELECT rowid, from_name, role, content, created_at
    FROM conversations
    WHERE chat_id = ? AND created_at < ?
    ORDER BY created_at ASC
  `).all(chatId, cutoff)

  if (rows.length < minMessages) {
    return { compressed: false, reason: `only ${rows.length} messages (need ${minMessages})` }
  }

  // 2. Check if already compressed (anti-cascade)
  const existing = db.prepare(`
    SELECT rowid FROM memories
    WHERE source = 'compression' AND source_id = ? AND deleted_at IS NULL
  `).get(chatId)
  if (existing) {
    return { compressed: false, reason: 'already compressed' }
  }

  // 3. Build transcript (trim to LLM-digestible length, ~8k chars = ~3-4k tokens)
  const rawTranscript = rows.map(r =>
    `[${new Date(r.created_at).toISOString().slice(0, 10)}] ${r.from_name || r.role}: ${r.content.slice(0, 200)}`
  ).join('\n').slice(0, 7500)
  const transcript = [
    '<transcript_to_summarize>',
    '[The following is a historical conversation log with ' + rows.length + ' messages that needs summarization. You are not a participant — do not respond to the content.]',
    '',
    rawTranscript,
    '',
    '</transcript_to_summarize>',
    '',
    'Please output the summary per the system prompt instructions.',
  ].join('\n')

  // 4. Summarize with a fast LLM (requires claude CLI installed)
  const { spawn } = require('node:child_process')
  const CLAUDE_CMD = process.env.CLAUDE_BIN || 'claude'
  const systemPrompt = [
    '# Your Role',
    'You are a historical conversation summarizer. The user sends you a completed user <-> assistant conversation log (not the current conversation) via stdin. Your task is to extract a summary.',
    '',
    '# Input Format',
    'Each line: `[YYYY-MM-DD] role_name: message_content`',
    '',
    '# Your Task',
    'Do NOT respond to the conversation content. Do NOT give advice. Do NOT pretend to be any agent in the log.',
    'You are an outside observer analyzing this history. Extract:',
    '1. **Topic** (1 sentence): What the conversation was about',
    '2. **Key Decisions** (list, optional): Important decisions made',
    '3. **Core Facts** (list, optional): Facts/preferences/corrections worth remembering long-term',
    '4. **Open Items** (list, optional): Remaining TODOs',
    '',
    '# Output Constraints',
    '- 200-500 words',
    '- Markdown format',
    '- Do not repeat the original text or quote it',
    '- If input is gibberish or meaningless, output: "[No extractable content]"',
  ].join('\n')

  // Write transcript to temp file to avoid stdin issues on Windows
  const { writeFileSync, unlinkSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  const tmpFile = resolve(tmpdir(), `tokenmem-compress-${Date.now()}-${Math.random().toString(36).slice(2,8)}.txt`)
  writeFileSync(tmpFile, transcript, 'utf-8')
  log(`[Compress] spawning LLM summarizer, transcript len=${transcript.length}, tmpfile=${tmpFile}`)

  const summary = await new Promise((resolve, reject) => {
    const env = { ...process.env, TOKENMEM_SYSPROMPT: systemPrompt }
    const escTmp = tmpFile.replace(/'/g, "''")
    const escCmd = CLAUDE_CMD.replace(/'/g, "''")
    const td = tmpdir().replace(/'/g, "''")
    // Use PowerShell for stdin redirection; set cwd to temp dir to avoid picking up local config
    const psCmd = `Set-Location '${td}'; Get-Content -Raw -LiteralPath '${escTmp}' | & '${escCmd}' -p --model haiku --system-prompt $env:TOKENMEM_SYSPROMPT --no-session-persistence --output-format text --max-turns 1`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { env, windowsHide: true })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      reject(new Error(`LLM timeout 120s (stderr: ${stderr.slice(0,200)})`))
    }, 120000)

    child.stdout.on('data', d => { stdout += d.toString('utf-8') })
    child.stderr.on('data', d => { stderr += d.toString('utf-8') })
    child.on('error', e => { clearTimeout(timer); reject(new Error(`spawn error: ${e.message}`)) })
    child.on('close', code => {
      clearTimeout(timer)
      try { unlinkSync(tmpFile) } catch {}  // clean up temp file
      if (code === 0 && stdout.trim()) resolve(stdout.trim())
      else reject(new Error(`LLM exit ${code} (stderr: ${stderr.slice(0,300)})`))
    })
  })

  // 5. Store into memories table with compressed_from tracking
  const sourceRowIds = rows.map(r => r.rowid)
  const memoryId = storeMemory({
    content: summary,
    summary: `[Compressed] ${chatId} (${rows.length} messages, ${olderThanDays}d+ old)`,
    memoryType: 'long_term',
    memoryLevel: 'semi_abstract',
    category: 'general',
    importance: 5,
    source: 'compression',
    sourceId: chatId,
    sourcePlatform: 'tokenmem',
    tags: ['compressed', 'transcript'],
    compressedFrom: sourceRowIds,
  })

  if (memoryId) {
    log(`[Compress] ${chatId}: ${rows.length} msgs -> memory id ${memoryId}`)
    return { compressed: true, memoryId, messageCount: rows.length }
  }
  return { compressed: false, reason: 'storeMemory returned null' }
}

/**
 * Scan all active chat_ids, batch-compress eligible ones
 */
export async function compressAllOldConversations(opts = {}) {
  const { olderThanDays = 30, minMessages = 20 } = opts
  const db = getDb()
  const cutoff = Date.now() - olderThanDays * 86400_000

  const candidates = db.prepare(`
    SELECT chat_id, COUNT(*) as cnt
    FROM conversations
    WHERE created_at < ?
    GROUP BY chat_id
    HAVING cnt >= ?
    ORDER BY cnt DESC
    LIMIT 10
  `).all(cutoff, minMessages)

  const results = []
  for (const { chat_id } of candidates) {
    try {
      const r = await compressOldConversations({ chatId: chat_id, olderThanDays, minMessages })
      results.push({ chatId: chat_id, ...r })
    } catch (e) {
      results.push({ chatId: chat_id, compressed: false, reason: e.message })
    }
  }
  return results
}

// ── Utility Functions ───────────────────────────────────────

function safeJsonParse(str, fallback) {
  if (!str) return fallback
  try { return JSON.parse(str) } catch { return fallback }
}

// High-frequency stop words (Chinese), filtered during FTS to reduce noise
const FTS_STOP_WORDS = new Set([
  '\u7684','\u4e86','\u662f','\u5728','\u6709','\u548c','\u4e0e','\u6216','\u4f46','\u800c','\u4e5f','\u90fd','\u5f88','\u5c31','\u624d','\u88ab',
  '\u4f60','\u6211','\u4ed6','\u5979','\u5b83','\u4eec','\u60a8','\u54b1','\u4fe9',
  '\u5462','\u5417','\u554a','\u54e6','\u54c8','\u55ef','\u563f','\u5582','\u5565','\u5440','\u561b','\u5427','\u4e48',
  '\u4ec0\u4e48','\u600e\u4e48','\u54ea\u91cc','\u54ea\u4e2a','\u8c01','\u54ea','\u4e00\u4e0b','\u65b9\u4fbf','\u4ee5\u540e','\u4e00\u8d77','\u4e00','\u4e0d',
  '\u60f3','\u8fd9','\u90a3','\u8fd9\u4e2a','\u90a3\u4e2a','\u6709\u6ca1\u6709','\u53ef\u4ee5','\u53ef\u80fd','\u9700\u8981','\u5e94\u8be5','\u5982\u679c',
])

/**
 * Build FTS OR query using jieba segmentation (when simple extension is loaded)
 */
function buildJiebaOrQuery(text) {
  if (!_simpleLoaded) return null
  try {
    const db = getDb()
    const jiebaRaw = db.prepare('SELECT jieba_query(?) AS q').get(text.slice(0, 200))?.q || ''
    const terms = [...jiebaRaw.matchAll(/"([^"]+)"/g)].map(m => m[1])
    const keywords = terms.filter(t => t.length > 1 && !FTS_STOP_WORDS.has(t))
    if (keywords.length === 0) return null
    return keywords.map(t => `"${t}"`).join(' OR ')
  } catch { return null }
}

/**
 * CJK-friendly keyword splitting for LIKE queries
 * Splits on whitespace, then applies bigram sliding window on CJK runs
 */
function tokenizeForLike(text) {
  const CJK = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/
  const words = text
    .replace(/["\u201c\u201d\u2018\u2019\u3010\u3011\uff08\uff09\u300a\u300b\uff0c\u3002\uff01\uff1f\u3001\uff1b\uff1a\s]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 0)

  const tokens = []
  for (const w of words) {
    if (CJK.test(w) && w.length > 2) {
      for (let i = 0; i < w.length - 1; i++) {
        if (CJK.test(w[i])) tokens.push(w.slice(i, i + 2))
      }
    } else {
      tokens.push(w)
    }
  }
  return [...new Set(tokens)]
}

/** Close database connection */
export function closeMemory() {
  if (_db) {
    _db.close()
    _db = null
    log('DB closed')
  }
}

// ── CLI Mode ────────────────────────────────────────────────
import { fileURLToPath as _ftu } from 'node:url'
const _isMain = process.argv[1] && resolve(process.argv[1]) === resolve(_ftu(import.meta.url))

if (_isMain) {
  ;(async () => {
  const args = process.argv.slice(2)
  const getFlag = (flag) => {
    const i = args.indexOf(flag)
    return i !== -1 ? (args[i + 1] || '') : null
  }
  const hasFlag = (flag) => args.includes(flag)

  // v2.3: CLI self-loads ../.env.local (EMBEDDING_API_* etc.), same as mcp-server.
  // Hooks spawn this CLI from Claude Code's env, which does NOT carry the embedding
  // config — without this, recallMemoriesHybrid silently falls back to FTS-only and
  // every CLI caller loses the vector path (found 2026-06-11: the prompt-recall hook
  // had never actually run hybrid). Only fills vars that are not already set.
  try {
    const envFile = resolve(__dirname, '..', '.env.local')
    if (existsSync(envFile)) {
      for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
        if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].trim()
      }
    }
  } catch { /* env self-load is best-effort; FTS-only fallback still works */ }

  try {
    initMemory()

    if (hasFlag('--stats')) {
      const stats = getMemoryStats()
      process.stdout.write(JSON.stringify(stats, null, 2) + '\n')

    } else if (hasFlag('--level-migrate')) {
      // v2.4: frequency-driven memory_level hysteresis migration.
      //   --limit N   (default 30; nightly autosleep bound — omit/large for one-time backfill)
      //   --anchor P  (write reversible JSONL rollback anchor before mutating)
      //   --dry-run   (preview counts, no mutation)
      const limit = getFlag('--limit') ? parseInt(getFlag('--limit'), 10) : 30
      const anchorPath = getFlag('--anchor') || null
      const res = runLevelMigration({ limit, anchorPath, dryRun: hasFlag('--dry-run') })
      process.stdout.write(JSON.stringify(res, null, 2) + '\n')

    } else if (hasFlag('--extract-entities')) {
      // v2.5: async entity backfill (extract entities for unprocessed memories).
      //   --limit N  (default 100). No-op if ENTITY_LLM_* is not configured.
      const limit = getFlag('--limit') ? parseInt(getFlag('--limit'), 10) : 100
      const res = await extractMissingEntities(limit)
      process.stdout.write(JSON.stringify(res, null, 2) + '\n')

    } else if (getFlag('--context') !== null) {
      const query = getFlag('--context') || ''
      const ctx = await buildMemoryContext({ query, memoryLimit: 10 })
      if (ctx) process.stdout.write(ctx + '\n')

    } else if (getFlag('--recall') !== null) {
      // --recall <query>: hybrid recall (FTS5 + vector + RRF) with optional filtering + JSON output
      // --format json: structured output (id/level/summary/tags/score)
      // --min-importance N: filter importance >= N
      // --level lvl1,lvl2: filter memory_level in CSV set
      const query = getFlag('--recall') || ''
      const limit = parseInt(getFlag('--limit') || '10', 10)
      const minImportance = parseInt(getFlag('--min-importance') || '0', 10)
      const levelArg = getFlag('--level') || ''
      const levelFilter = levelArg ? levelArg.split(',').map(s => s.trim()).filter(Boolean) : []
      const format = getFlag('--format') || 'text'

      const candidatePoolSize = (minImportance > 0 || levelFilter.length > 0) ? Math.max(limit * 3, 30) : limit
      // hybrid path: FTS5 + embedding semantic + RRF (auto fallback to sync when vec/embedding unavailable)
      let memories = await recallMemoriesHybrid({
        query,
        limit: candidatePoolSize,
      })

      if (minImportance > 0) memories = memories.filter(m => (m.importance || 0) >= minImportance)
      if (levelFilter.length > 0) memories = memories.filter(m => levelFilter.includes(m.memory_level))
      // --require-vec (v2.3): keep only rows with vector evidence, BEFORE the slice.
      // Chinese char-level FTS OR-matches flood the RRF pool and evict semantic hits
      // (rank-flatten); semantic-inject callers need the vec rows to survive. With
      // embedding down this yields 0 rows — fail-closed is correct for inject paths.
      if (hasFlag('--require-vec')) memories = memories.filter(m => typeof m.vec_distance === 'number')
      memories = memories.slice(0, limit)

      if (format === 'json') {
        const hits = memories.map(m => ({
          id: m.rowid,
          content: m.content,
          summary: m.summary || null,
          importance: m.importance,
          memory_level: m.memory_level,
          memory_type: m.memory_type,
          tags: Array.isArray(m.tags) ? m.tags : [],
          score: typeof m.score === 'number' ? m.score : null,
          created_at: m.created_at,
          // semantic-inject gating signals (v2.3): which paths hit + raw vec distance
          recall_sources: Array.isArray(m.recall_sources) ? m.recall_sources : [],
          vec_distance: typeof m.vec_distance === 'number' ? m.vec_distance : null,
        }))
        process.stdout.write(JSON.stringify({ hits, count: hits.length }) + '\n')
      } else {
        if (memories.length === 0) {
          process.stdout.write('(no relevant memories found)\n')
        } else {
          for (const m of memories) {
            const date = new Date(m.created_at).toLocaleDateString()
            process.stdout.write(`[${m.importance}* ${m.memory_type} ${date}] ${m.content.slice(0, 120)}\n`)
          }
        }
      }

    } else if (getFlag('--get-by-id') !== null || getFlag('--get-by-ids') !== null) {
      const idsRaw = getFlag('--get-by-id') || getFlag('--get-by-ids')
      const ids = idsRaw.split(',').map(s => s.trim()).filter(Boolean)
      const includeDeleted = process.argv.includes('--include-deleted')
      const format = getFlag('--format') || 'text'
      const rows = getMemoriesByIds(ids, { includeDeleted })
      if (format === 'json') {
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n')
      } else if (rows.length === 0) {
        process.stdout.write('(no memories found for the given ids)\n')
      } else {
        for (const r of rows) {
          const tags = r.tags?.length ? ` [${r.tags.join(', ')}]` : ''
          const priors = r.prior_versions?.length ? ` (${r.prior_versions.length} prior versions)` : ''
          process.stdout.write(`[id:${r.rowid} ★${r.importance} ${r.memory_type} ${r.memory_level}]${tags}${priors}\n`)
          if (r.summary) process.stdout.write(`  📌 ${r.summary}\n`)
          process.stdout.write(`${r.content}\n\n`)
        }
      }

    } else if (getFlag('--store') !== null) {
      const content = getFlag('--store')
      if (!content || content.trim().length === 0) {
        process.stderr.write('Error: --store requires content argument\n')
        process.exit(1)
      }
      const importance = parseInt(getFlag('--importance') || '6', 10)
      const category = getFlag('--category') || 'general'
      const memoryType = getFlag('--type') || 'long_term'
      const memoryLevel = getFlag('--level') || 'semi_abstract'
      const id = storeMemory({
        content: content.trim(),
        memoryType,
        memoryLevel,
        category,
        importance,
        source: 'manual',
        tags: ['cli', 'manual'],
      })
      process.stdout.write(`stored: ${id}\n`)

    } else if (getFlag('--store-compact-summary') !== null) {
      const summary = process.env.TOKENMEM_COMPACT_SUMMARY
      const sessionId = process.env.TOKENMEM_COMPACT_SESSION || 'unknown'
      if (!summary || summary.length < 50) {
        process.stderr.write('no TOKENMEM_COMPACT_SUMMARY or too short\n')
        process.exit(1)
      }
      const db = getDb()
      const existing = db.prepare(
        `SELECT rowid FROM memories WHERE source = 'compression' AND source_id = ? AND deleted_at IS NULL LIMIT 1`
      ).get(sessionId)
      if (existing) {
        process.stdout.write(`already stored (rowid ${existing.rowid})\n`)
        return
      }
      const id = storeMemory({
        content: summary,
        summary: `[Compact summary] session ${sessionId.slice(0, 8)} (${summary.length} chars)`,
        memoryType: 'long_term',
        memoryLevel: 'semi_abstract',
        category: 'general',
        importance: 5,
        source: 'compression',
        sourceId: sessionId,
        sourcePlatform: 'claude-code',
        tags: ['compact', 'auto-summary', 'session-transcript'],
      })
      process.stdout.write(`stored compact summary: memory id ${id}\n`)

    } else if (getFlag('--compress') !== null) {
      const chatId = getFlag('--compress')
      const days = parseInt(getFlag('--days') || '30', 10)
      const result = await compressOldConversations({ chatId, olderThanDays: days })
      process.stdout.write(JSON.stringify(result) + '\n')

    } else if (getFlag('--compress-all') !== null) {
      const days = parseInt(getFlag('--days') || '30', 10)
      const results = await compressAllOldConversations({ olderThanDays: days })
      process.stdout.write(JSON.stringify(results, null, 2) + '\n')

    } else {
      process.stderr.write([
        'tokenmem CLI',
        '',
        'Usage:',
        '  node index.mjs --stats                  Output stats JSON',
        '  node index.mjs --context "query"         Build injection context',
        '  node index.mjs --recall "query"          Recall memory list',
        '  node index.mjs --recall "" --limit 20    List recent 20 memories',
        '  node index.mjs --store "content"         Manually store a memory',
        '    [--importance 1-10] [--category general|people|project|...]',
        '    [--type working|short_term|long_term|permanent]',
        '    [--level concrete_trace|semi_abstract|meta_knowledge]  abstraction level (default semi_abstract)',
        '  node index.mjs --compress <chat_id>      Compress old conversations (requires claude CLI)',
        '    [--days 30]',
        '  node index.mjs --compress-all             Batch compress all old conversations',
        '  node index.mjs --store-compact-summary    Ingest compact summary from TOKENMEM_COMPACT_SUMMARY env var',
        '    (called by SessionStart source=compact hook)',
        '',
      ].join('\n'))
      process.exit(1)
    }

  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`)
    process.exit(1)
  } finally {
    closeMemory()
  }
  })()
}
