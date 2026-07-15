// Regression tests for recall/search query safety and live-memory filtering.
// Uses a fresh temp DB via TOKENMEM_DB_PATH; never touches tokenmem.db.
// Run: node recall-search-regressions.test.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

const root = mkdtempSync(resolve(tmpdir(), 'mneme-recall-search-'))
process.env.TOKENMEM_DB_PATH = resolve(root, 'tokenmem.test.db')

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' -- ' + detail : ''}`) }
}

function captureStderr(fn) {
  const originalWrite = process.stderr.write
  let stderr = ''
  process.stderr.write = (chunk) => {
    stderr += String(chunk)
    return true
  }
  try {
    return { value: fn(), stderr }
  } finally {
    process.stderr.write = originalWrite
  }
}

try {
  const { initMemory, closeMemory, storeMemory, recallMemories, searchConversations } = await import('./index.mjs')
  initMemory()

  const targetId = storeMemory({
    content: 'release checklist punctuation regression target',
    summary: 'release checklist target',
    memoryType: 'long_term',
    category: 'project',
    importance: 7,
  })

  const questionRecall = captureStderr(() => recallMemories({ query: 'release?', limit: 5 }))
  check('recall query containing ? still finds its text term',
    questionRecall.value.some(row => String(row.rowid) === targetId),
    `rows=${JSON.stringify(questionRecall.value)}`)
  check('recall query containing ? does not log an FTS syntax error',
    !/FTS.*(?:syntax|query failed)/i.test(questionRecall.stderr),
    `stderr=${questionRecall.stderr}`)

  const questionConversation = captureStderr(() => searchConversations('release?', { limit: 2, contextWindow: 1 }))
  check('conversation query containing ? safely reaches memory fallback',
    questionConversation.value.some(segment => segment.source === 'memories_fallback'),
    `segments=${JSON.stringify(questionConversation.value)}`)
  check('conversation query containing ? does not log an FTS syntax error',
    !/fts5: syntax error/i.test(questionConversation.stderr),
    `stderr=${questionConversation.stderr}`)

  const quoteOnly = captureStderr(() => recallMemories({ query: '""', limit: 5 }))
  check('quote-only recall query returns no arbitrary memories',
    quoteOnly.value.length === 0,
    `rows=${JSON.stringify(quoteOnly.value)}`)
  check('quote-only recall query does not log an FTS syntax error',
    !/fts5: syntax error/i.test(quoteOnly.stderr),
    `stderr=${quoteOnly.stderr}`)

  const punctuationOnly = captureStderr(() => searchConversations('?!+-():^*', { limit: 2, contextWindow: 1 }))
  check('punctuation-only conversation query returns no results',
    punctuationOnly.value.length === 0,
    `segments=${JSON.stringify(punctuationOnly.value)}`)
  check('punctuation-only conversation query does not log an FTS syntax error',
    !/fts5: syntax error/i.test(punctuationOnly.stderr),
    `stderr=${punctuationOnly.stderr}`)

  const bareQuestion = captureStderr(() => searchConversations('?', { limit: 2, contextWindow: 1 }))
  check('bare ? query returns no results without an FTS syntax error',
    bareQuestion.value.length === 0 && !/fts5: syntax error/i.test(bareQuestion.stderr),
    `segments=${JSON.stringify(bareQuestion.value)} stderr=${bareQuestion.stderr}`)

  const supersededId = storeMemory({
    content: 'obsoletebleedmarker legacy deployment setting',
    memoryType: 'long_term',
    category: 'project',
    importance: 7,
  })
  const successorId = storeMemory({
    content: 'current deployment setting replaces the obsolete value',
    memoryType: 'long_term',
    category: 'project',
    importance: 7,
    supersedes: [supersededId],
  })

  const db = new Database(process.env.TOKENMEM_DB_PATH, { readonly: true })
  const supersededState = db.prepare(
    'SELECT superseded_by, deleted_at FROM memories WHERE rowid = ?'
  ).get(supersededId)
  db.close()
  check('supersede creates the pre-expiration bleed-window state',
    String(supersededState?.superseded_by) === successorId && supersededState?.deleted_at == null,
    `state=${JSON.stringify(supersededState)} successor=${successorId}`)

  const queriedRecall = recallMemories({ query: 'obsoletebleedmarker', limit: 10, _internal: true })
  check('queried recall excludes a superseded row before expiration',
    !queriedRecall.some(row => String(row.rowid) === supersededId),
    `rows=${JSON.stringify(queriedRecall)}`)

  const unfilteredRecall = recallMemories({ limit: 10 })
  check('no-query recall excludes a superseded row before expiration',
    !unfilteredRecall.some(row => String(row.rowid) === supersededId) &&
      unfilteredRecall.some(row => String(row.rowid) === successorId),
    `rows=${JSON.stringify(unfilteredRecall)}`)

  const fallbackRecall = searchConversations('obsoletebleedmarker', { limit: 2, contextWindow: 1 })
  check('conversation memory fallback excludes a superseded row before expiration',
    !fallbackRecall.some(segment => segment.messages?.some(message =>
      String(message.metadata?.memory_rowid) === supersededId)),
    `segments=${JSON.stringify(fallbackRecall)}`)

  closeMemory()
} finally {
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
