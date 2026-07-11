// Regression tests for conversation-search fallback and cross-layer dedup.
// Uses a fresh temp DB via TOKENMEM_DB_PATH; never touches tokenmem.db.
// Run: node conversation-fallback-dedup.test.mjs

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(resolve(tmpdir(), 'mneme-fallback-dedup-'))
const DB_PATH = resolve(root, 'tokenmem.test.db')
process.env.TOKENMEM_DB_PATH = DB_PATH

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' -- ' + detail : ''}`) }
}

try {
  const { initMemory, closeMemory, storeMemory, searchConversations } = await import('./index.mjs')
  initMemory()

  // Fix 1: conversation search over an empty conversations table should fall back to memories.
  const fallbackContent = 'daily review cron fallback should find this native memory row'
  storeMemory({
    content: fallbackContent,
    summary: 'daily review fallback memory',
    memoryType: 'long_term',
    category: 'project',
    importance: 7,
  })

  const segments = searchConversations('daily review cron fallback', { limit: 2, contextWindow: 1 })
  check('searchConversations falls back to memories when conversations are empty',
    segments.length === 1 && segments[0].source === 'memories_fallback',
    `segments=${JSON.stringify(segments)}`)
  check('fallback segment clearly marks memory origin',
    segments[0]?.note === 'conversation_search_fallback: memories' &&
      segments[0]?.messages?.[0]?.metadata?.fallback_from === 'memories',
    `segment=${JSON.stringify(segments[0])}`)

  const dbAfterFallback = new Database(DB_PATH, { readonly: true })
  const missAfterFallback = dbAfterFallback.prepare(
    `SELECT COUNT(*) AS c FROM search_misses WHERE source = 'search_conversations'`
  ).get().c
  dbAfterFallback.close()
  check('conversation search miss is not recorded when memory fallback hits', missAfterFallback === 0,
    `misses=${missAfterFallback}`)

  // Fix 2: markdown migration dedup must see native storeMemory rows without source_file/manual provenance.
  const nativeContent = 'native cross-layer duplicate body should prevent markdown import'
  storeMemory({
    content: nativeContent,
    summary: 'native summary',
    memoryType: 'long_term',
    category: 'project',
    importance: 7,
  })

  closeMemory()

  const dbAge = new Database(DB_PATH)
  dbAge.prepare(`UPDATE memories SET created_at = ? WHERE content = ?`)
    .run(Date.now() - 10 * 60_000, nativeContent)
  dbAge.close()

  const memDir = resolve(root, 'project-a', 'memory')
  rmSync(resolve(root, 'project-a'), { recursive: true, force: true })
  await import('node:fs/promises').then(fs => fs.mkdir(memDir, { recursive: true }))
  writeFileSync(resolve(memDir, 'native-duplicate.md'), [
    '---',
    'name: Native Duplicate',
    'type: project',
    'description: markdown summary differs from native summary',
    '---',
    nativeContent,
    '',
  ].join('\n'), 'utf-8')

  const migrated = spawnSync(process.execPath, [resolve(__dirname, 'migrate-claude-memories.mjs')], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      TOKENMEM_DB_PATH: DB_PATH,
      MNEME_MEMORY_DIRS: memDir,
    },
  })
  check('migrate-claude-memories exits 0', migrated.status === 0,
    `stderr=${(migrated.stderr || '').slice(0, 300)}`)

  const dbVerify = new Database(DB_PATH, { readonly: true })
  const duplicateCount = dbVerify.prepare(
    `SELECT COUNT(*) AS c FROM memories WHERE deleted_at IS NULL AND content = ?`
  ).get(nativeContent).c
  dbVerify.close()
  check('markdown migration skips native duplicate by content, independent of provenance',
    duplicateCount === 1 && /0 imported, 1 skipped/.test(migrated.stdout || ''),
    `count=${duplicateCount} stdout=${(migrated.stdout || '').slice(0, 300)}`)
} finally {
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
