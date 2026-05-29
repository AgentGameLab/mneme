#!/usr/bin/env node
// ============================================================
// Backfill script: add embedding vectors to existing memories
//
// Purpose:
//   - When first enabling vector search, batch-process historical memories
//   - Idempotent: only processes rows with content_vector IS NULL
//   - Safe to re-run after interruption
//
// Usage:
//   node backfill-embeddings.mjs
//   node backfill-embeddings.mjs --batch-size 5 --concurrency 3
//   node backfill-embeddings.mjs --dry-run    # count only, no writes
//
// Environment variables required:
//   EMBEDDING_API_BASE_URL - OpenAI-compatible embedding API base URL
//   EMBEDDING_API_KEY      - API key for embedding service
//   EMBEDDING_MODEL        - Model name (default: text-embedding-3-small)
//   EMBEDDING_DIMENSION    - Vector dimension (default: 1536)
// ============================================================

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Load .env.local if present ─────────────────────────────
// [2026-05-29 千夏 fix] .env.local 在 chinatsu-workspace/（memory/ 上一级），
// 不在 memory/。原代码 resolve(__dirname,'.env.local') 指向 memory/.env.local（不存在）→
// 除非 shell 已 export env 否则 EMBEDDING_API_KEY 取不到直接 exit 1。两个路径都试。
for (const p of [resolve(__dirname, '..', '.env.local'), resolve(__dirname, '.env.local')]) {
  if (existsSync(p)) {
    readFileSync(p, 'utf-8').split('\n').filter(l => l && !l.startsWith('#')).forEach(l => {
      const i = l.indexOf('=')
      // \r? 兼容 Windows CRLF；已存在的 env 不覆盖
      if (i > 0) {
        const k = l.slice(0, i).trim(), v = l.slice(i + 1).replace(/\r$/, '').trim()
        if (process.env[k] === undefined) process.env[k] = v
      }
    })
    break
  }
}

const args = process.argv.slice(2)
const hasFlag = (f) => args.includes(f)
const getFlag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null }

const CONCURRENCY = parseInt(getFlag('--concurrency') || '3', 10)
const DRY_RUN = hasFlag('--dry-run')

// ── Configuration ───────────────────────────────────────────
// [2026-05-29 千夏 fix] 与 index.mjs:35-38 同一套解析：优先 engram.db（真实库），
// 原默认 tokenmem.db 是 fresh-install 占位库（仅 10 行）→ 回填空转。
const DB_PATH = process.env.TOKENMEM_DB_PATH
  || (existsSync(resolve(__dirname, 'engram.db'))
        ? resolve(__dirname, 'engram.db')
        : resolve(__dirname, 'tokenmem.db'))
const VEC_EXT = resolve(__dirname, 'lib/sqlite-vec-windows-x64/vec0')
const EMBED_URL = (process.env.EMBEDDING_API_BASE_URL || '') + '/embeddings'
const EMBED_KEY = process.env.EMBEDDING_API_KEY
const EMBED_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small'
const EMBED_DIM = parseInt(process.env.EMBEDDING_DIMENSION || '1536', 10)

if (!EMBED_KEY) {
  console.error('Error: EMBEDDING_API_KEY not set. Check .env.local or environment variables.')
  process.exit(1)
}

// ── Open DB + load vec extension ────────────────────────────
const Database = require('better-sqlite3')
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.loadExtension(VEC_EXT)
console.log(`DB opened: ${DB_PATH}`)
console.log(`sqlite-vec loaded: ${db.prepare('SELECT vec_version() as v').get().v}`)

// Ensure memories_vec exists (initMemory should have created it, but defensive)
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
    memory_rowid INTEGER PRIMARY KEY,
    embedding FLOAT[${EMBED_DIM}]
  )
`)

// ── Count pending ───────────────────────────────────────────
const pending = db.prepare(`
  SELECT rowid, id, content, length(content) as len
  FROM memories
  WHERE deleted_at IS NULL
    AND (content_vector IS NULL OR content_vector = '')
  ORDER BY importance DESC, created_at DESC
`).all()

const total = pending.length
console.log(`\nPending memories: ${total}`)
if (total === 0) { console.log('All memories already have embeddings.'); db.close(); process.exit(0) }

const totalChars = pending.reduce((s, r) => s + r.len, 0)
const estimatedTokens = Math.ceil(totalChars / 1.5)  // rough estimate
console.log(`Total characters: ${totalChars} (~${estimatedTokens} tokens)`)

if (DRY_RUN) {
  console.log('\n[dry-run] Count only, no API calls made.')
  db.close()
  process.exit(0)
}

// ── Embedding API call ──────────────────────────────────────
async function embed(text) {
  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${EMBED_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: text.slice(0, 8000),
      dimensions: EMBED_DIM,
      encoding_format: 'float',
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().then(t => t.slice(0, 200))}`)
  const data = await res.json()
  return data?.data?.[0]?.embedding
}

// ── Batch processing ────────────────────────────────────────
const updateVecStmt = db.prepare('UPDATE memories SET content_vector = ? WHERE rowid = ?')
const insertVecStmt = db.prepare('INSERT OR REPLACE INTO memories_vec(memory_rowid, embedding) VALUES (?, ?)')

const writeTxn = db.transaction((rowid, vecJson, floatArr) => {
  updateVecStmt.run(vecJson, rowid)
  insertVecStmt.run(BigInt(rowid), floatArr)
})

let processed = 0, failed = 0
const startTs = Date.now()

async function processOne(row) {
  try {
    const vec = await embed(row.content)
    if (!vec || vec.length !== EMBED_DIM) throw new Error(`invalid vector (len=${vec?.length})`)
    writeTxn(row.rowid, JSON.stringify(vec), new Float32Array(vec))
    processed++
  } catch (e) {
    failed++
    console.log(`  Failed rowid ${row.rowid}: ${e.message}`)
  }
}

// Concurrent worker pool
async function runPool() {
  const queue = [...pending]
  const workers = []

  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const row = queue.shift()
        if (!row) break
        await processOne(row)
        if ((processed + failed) % 10 === 0) {
          const elapsed = (Date.now() - startTs) / 1000
          const rate = (processed + failed) / elapsed
          const eta = ((total - processed - failed) / rate).toFixed(0)
          console.log(`  Progress: ${processed + failed}/${total}  (ok ${processed} / fail ${failed}, ${rate.toFixed(1)} req/s, ETA ${eta}s)`)
        }
      }
    })())
  }
  await Promise.all(workers)
}

console.log(`\nStarting backfill (concurrency=${CONCURRENCY})...\n`)
await runPool()

const elapsed = ((Date.now() - startTs) / 1000).toFixed(1)
console.log(`\nDone.`)
console.log(`  Processed: ${processed} ok / ${failed} failed / ${total} total`)
console.log(`  Elapsed: ${elapsed}s`)
console.log(`  memories_vec total: ${db.prepare('SELECT COUNT(*) as c FROM memories_vec').get().c}`)

db.close()
