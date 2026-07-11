#!/usr/bin/env node
// ============================================================
// Memory migration script: Claude Auto Memory -> SQLite
//
// Imports memory/*.md files from Claude Code's auto-memory
// (~/.claude/projects/*/memory/*.md) into the tokenmem SQLite database,
// enabling unified cross-project memory.
//
// Features:
//   - Idempotent (dedup by summary + source='manual', safe to re-run)
//   - Non-destructive (does not delete original files, Claude Code auto memory continues working)
//   - Auto-maps type -> category/importance
//
// Usage:
//   node migrate-claude-memories.mjs
//
// Configuration:
//   Edit MEMORY_DIRS below to point to your Claude Code projects' memory directories.
// ============================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// -- Configure scan directories -------------------------------------------
const CLAUDE_PROJECTS = resolve(process.env.HOME || process.env.USERPROFILE || '', '.claude/projects')

// Resolve which memory/ dirs to scan (first match wins):
//   1. MNEME_MEMORY_DIRS env — comma-separated project names (under ~/.claude/projects) or absolute paths
//   2. ./mneme.migrate.local.json — local override { "projects": [...] }, gitignored
//   3. fallback — auto-scan every memory/ folder under ~/.claude/projects
function resolveMemoryDirs() {
  const { readdirSync, statSync, readFileSync } = require('node:fs')
  const toDir = (p) =>
    /[\\/]/.test(p) || /^[A-Za-z]:/.test(p) ? resolve(p) : resolve(CLAUDE_PROJECTS, p, 'memory')

  const env = (process.env.MNEME_MEMORY_DIRS || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (env.length) return env.map(toDir)

  try {
    const cfg = JSON.parse(readFileSync(resolve(process.cwd(), 'mneme.migrate.local.json'), 'utf-8'))
    if (Array.isArray(cfg.projects) && cfg.projects.length) return cfg.projects.map(toDir)
  } catch {}

  const dirs = []
  try {
    for (const entry of readdirSync(CLAUDE_PROJECTS)) {
      const memDir = resolve(CLAUDE_PROJECTS, entry, 'memory')
      try { if (statSync(memDir).isDirectory()) dirs.push(memDir) } catch {}
    }
  } catch {}
  return dirs
}
const MEMORY_DIRS = resolveMemoryDirs()

// -- type -> category mapping ---------------------------------------------
const TYPE_TO_CATEGORY = {
  user: 'people',
  feedback: 'feedback',
  project: 'project',
  reference: 'general',
}

// -- filename -> importance heuristic -------------------------------------
function guessImportance(filename, type, name) {
  const f = filename.toLowerCase()
  if (f.includes('persona')) return 9
  if (type === 'feedback') return 8
  if (f.includes('profile') || f.includes('user')) return 8
  if (type === 'project') return 7
  if (type === 'reference') return 6
  return 6
}

// -- Parse frontmatter ----------------------------------------------------
function parseFrontmatter(content) {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/m)
  if (!m) return { meta: {}, body: content }

  const meta = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/)
    if (kv) meta[kv[1].trim()] = kv[2].trim()
  }
  return { meta, body: m[2].trim() }
}

function contentHash(content) {
  return createHash('sha256').update(String(content || '')).digest('hex').slice(0, 16)
}

// -- Main -----------------------------------------------------------------
async function main() {
  // Initialize DB (reuses index.mjs initMemory)
  const { initMemory, storeMemory, closeMemory } = await import('./index.mjs')
  initMemory()

  // Use better-sqlite3 directly for dedup check
  const Database = require('better-sqlite3')
  const DB_PATH = process.env.TOKENMEM_DB_PATH || resolve(__dirname, 'tokenmem.db')
  const db = new Database(DB_PATH)

  const checkDup = db.prepare(`
    SELECT rowid, id FROM memories
    WHERE deleted_at IS NULL
      AND (
        content_hash = ?
        OR content = ?
        OR (summary = ? AND source = 'manual')
      )
    ORDER BY created_at DESC
    LIMIT 1
  `)

  let imported = 0
  let skipped = 0
  let errors = 0

  for (const dir of MEMORY_DIRS) {
    if (!existsSync(dir)) {
      console.log(`Skipping non-existent directory: ${dir}`)
      continue
    }

    const projectName = dirname(dir).split(/[/\\]/).pop() || 'unknown'
    const files = readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
    console.log(`\n${projectName}: ${files.length} files`)

    for (const filename of files) {
      const filepath = resolve(dir, filename)
      try {
        const raw = readFileSync(filepath, 'utf-8')
        const { meta, body } = parseFrontmatter(raw)

        const name = meta.name || basename(filename, '.md')
        const type = meta.type || 'reference'
        const description = meta.description || ''
        const category = TYPE_TO_CATEGORY[type] || 'general'
        const importance = guessImportance(filename, type, name)

        // Summary used for display and a legacy dedup fallback.
        const summary = description || name
        // Content = file body (with frontmatter description)
        const content = (body || `${name}${description ? ': ' + description : ''}`).slice(0, 8000)

        // Check dedup by content first, independent of source/source_file provenance.
        // Summary remains only as the legacy manual-import idempotency fallback.
        const existing = checkDup.get(contentHash(content), content, summary)
        if (existing) {
          console.log(`  Skip (exists #${existing.rowid}): ${name}`)
          skipped++
          continue
        }

        storeMemory({
          content,
          summary,
          memoryType: 'permanent',
          category,
          importance,
          source: 'manual',
          tags: ['migrated', 'claude_auto_memory', projectName, type],
          metadata: {
            source_file: filepath,
            original_type: type,
            migrated_at: new Date().toISOString(),
          },
        })

        console.log(`  Imported: [${type}->${category} i${importance}] ${name}`)
        imported++

      } catch (e) {
        console.log(`  Error: ${filename} -- ${e.message}`)
        errors++
      }
    }
  }

  db.close()
  closeMemory()

  console.log(`\n${'='.repeat(50)}`)
  console.log(`Migration complete: ${imported} imported, ${skipped} skipped, ${errors} errors`)
  console.log(`${'='.repeat(50)}`)
}

main().catch(e => {
  console.error('Migration failed:', e)
  process.exit(1)
})
