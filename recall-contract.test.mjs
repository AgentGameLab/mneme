// End-to-end tests for bounded recall, trace persistence, and ID validation.
// Uses a fresh temp DB via TOKENMEM_DB_PATH; never touches tokenmem.db.
// Run: node recall-contract.test.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

const root = mkdtempSync(resolve(tmpdir(), 'mneme-recall-contract-'))
process.env.TOKENMEM_DB_PATH = resolve(root, 'tokenmem.test.db')

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' -- ' + detail : ''}`) }
}

try {
  const {
    initMemory,
    closeMemory,
    storeMemory,
    recallMemories,
    buildMemoryContext,
    getRecallTrace,
    validateMemoryReferences,
  } = await import('./index.mjs')
  const { createRecallTrace, planRecallBudget } = await import('./recall-contract.mjs')
  initMemory()

  const budget = planRecallBudget(100)
  check('100 requested results plans a 100-candidate / 20-result hard gate',
    budget.requested === 100 && budget.candidates === 100 && budget.effective === 20,
    `budget=${JSON.stringify(budget)}`)

  for (let i = 0; i < 120; i++) {
    storeMemory({
      content: `contractbudgetmarker memory ${i}`,
      summary: i === 0 ? 'x'.repeat(10_000) : `bounded memory ${i}`,
      memoryType: 'long_term',
      category: 'project',
      importance: 7,
    })
  }

  const candidateTrace = createRecallTrace({ query: 'contractbudgetmarker', requestedLimit: 100 })
  const candidateRows = recallMemories({
    query: 'contractbudgetmarker',
    limit: 100,
    _internal: true,
    _candidatePool: true,
    _trace: candidateTrace,
  })
  const candidateDb = new Database(process.env.TOKENMEM_DB_PATH, { readonly: true })
  const accessAfterCandidates = candidateDb.prepare('SELECT SUM(access_count) AS total FROM memories').get().total
  candidateDb.close()
  check('candidate pool is capped at 100 without marking candidates as accessed',
    candidateRows.length === 100 && accessAfterCandidates === 0,
    `candidates=${candidateRows.length} access=${accessAfterCandidates}`)

  const recalled = recallMemories({ query: 'contractbudgetmarker', limit: 100, _internal: true })
  check('public recall never returns more than 20 memories',
    recalled.length === 20,
    `count=${recalled.length}`)
  const directTrace = getRecallTrace(recalled.recallTrace?.traceId)
  check('direct recall persists the requested/effective/candidate limits',
    directTrace?.requestedLimit === 100 && directTrace?.effectiveLimit === 20 && directTrace?.candidateLimit === 100,
    `trace=${JSON.stringify(directTrace)}`)
  check('direct trace records no more than 100 retrieval candidates',
    directTrace?.steps.some(step => step.name === 'retrieval.candidates' && step.meta.count === 100),
    `steps=${JSON.stringify(directTrace?.steps)}`)

  const context = await buildMemoryContext({
    query: 'contractbudgetmarker',
    memoryLimit: 100,
    maxContextChars: 2_000,
  })
  const traceId = context.match(/trace-id="([^"]+)"/)?.[1]
  const allowedIds = (context.match(/allowed-ids="([^"]*)"/)?.[1] || '').split(',').filter(Boolean)
  check('injected context obeys the exact character ceiling',
    context.length <= 2_000,
    `chars=${context.length}`)
  check('injected memories expose canonical rowid citations',
    allowedIds.length > 0 && allowedIds.every(id => context.includes(`[id:${id}]`)),
    `allowed=${JSON.stringify(allowedIds)}`)

  const contextTrace = getRecallTrace(traceId)
  check('context trace allowlist contains only IDs actually injected',
    JSON.stringify(contextTrace?.keptIds) === JSON.stringify(allowedIds),
    `trace=${JSON.stringify(contextTrace?.keptIds)} allowed=${JSON.stringify(allowedIds)}`)
  check('context trace records the budget filter and prepared allowlist',
    contextTrace?.steps.some(step => step.name === 'context.filter') &&
      contextTrace?.steps.some(step => step.name === 'id_whitelist.prepared'),
    `steps=${JSON.stringify(contextTrace?.steps)}`)

  const realId = allowedIds[0]
  const validated = validateMemoryReferences(
    `[id:${realId}] grounded [id:999999999] fabricated`,
    traceId,
  )
  check('trace-backed validation preserves real IDs and strips fabricated IDs',
    validated.cleanText.includes(`[id:${realId}]`) &&
      !validated.cleanText.includes('[id:999999999]') &&
      validated.rejectedIds.includes('999999999'),
    `validated=${JSON.stringify(validated)}`)

  const missingTrace = validateMemoryReferences('[id:123] claim', 'missing-trace')
  check('missing trace fails closed by stripping all canonical memory IDs',
    missingTrace.traceFound === false && !missingTrace.cleanText.includes('[id:123]'),
    `validated=${JSON.stringify(missingTrace)}`)

  // P0 regression (mneme#7 review): a single space after `[` used to bypass
  // the allowlist entirely — the regex required `[` immediately followed by
  // `id`. Every reasonable formatting variant must be stripped now.
  const bypassCheck = validateMemoryReferences(
    `[id:${realId}] grounded [ id:999999999] leading-space [ID: 888888] upper-and-space`,
    traceId,
  )
  check('leading-space variants like `[ id:N]` cannot bypass the allowlist',
    !bypassCheck.cleanText.includes('999999999') &&
      !bypassCheck.cleanText.includes('888888') &&
      bypassCheck.rejectedIds.includes('999999999') &&
      bypassCheck.rejectedIds.includes('888888'),
    `validated=${JSON.stringify(bypassCheck)}`)

  const tinyContext = await buildMemoryContext({
    query: 'contractbudgetmarker',
    memoryLimit: 100,
    maxContextChars: 100,
  })
  check('context returns empty instead of exceeding an impossibly small ceiling',
    tinyContext.length === 0,
    `chars=${tinyContext.length}`)

  const dropDb = new Database(process.env.TOKENMEM_DB_PATH)
  dropDb.exec('DROP TABLE recall_traces')
  dropDb.close()
  const failOpenRecall = recallMemories({ query: 'contractbudgetmarker', limit: 5, _internal: true })
  check('trace persistence failure does not fail the recall read path',
    failOpenRecall.length === 5,
    `count=${failOpenRecall.length}`)

  closeMemory()
} finally {
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
