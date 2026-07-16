import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const root = mkdtempSync(resolve(tmpdir(), 'mneme-query-rewrite-'))
process.env.TOKENMEM_DB_PATH = resolve(root, 'tokenmem.test.db')

let pass = 0, fail = 0
function check(label, condition, detail = '') {
  if (condition) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' -- ' + detail : ''}`) }
}

try {
  const { expandRecallQuery } = await import('./query-rewrite.mjs')
  const { normalizedFtsScore } = await import('./recall-scoring.mjs')
  const { initMemory, closeMemory, storeMemory, recallMemories } = await import('./index.mjs')
  initMemory()

  const expansion = expandRecallQuery('What should I serve with my homegrown ingredients?')
  check('homegrown meal query expands to stable garden/cooking concepts',
    ['garden', 'harvest', 'produce', 'cooking', 'recipe'].every(term => expansion.addedTerms.includes(term)),
    `expansion=${JSON.stringify(expansion)}`)
  check('unrelated query is not expanded',
    expandRecallQuery('where is the daemon config').addedTerms.length === 0)
  check('FTS score normalization preserves differences above the old saturation point',
    normalizedFtsScore(-24, 24) === 1 && normalizedFtsScore(-12, 24) === 0.5)

  const evidenceId = storeMemory({
    content: 'Fresh basil and mint cooking; harvested cherry tomatoes from garden.',
    memoryType: 'long_term',
    category: 'preference',
    importance: 5,
  })
  for (let i = 0; i < 12; i++) {
    storeMemory({
      content: `Please serve dinner this weekend with ingredients from supermarket menu ${i}.`,
      memoryType: 'long_term',
      category: 'general',
      importance: 5,
    })
  }

  const withoutExpansion = recallMemories({
    query: 'What should I serve for dinner this weekend with my homegrown ingredients?',
    limit: 10,
    _internal: true,
    _noQueryExpansion: true,
  })
  const withExpansion = recallMemories({
    query: 'What should I serve for dinner this weekend with my homegrown ingredients?',
    limit: 10,
    _internal: true,
  })
  check('concept expansion recovers implicit garden evidence missed by lexical-only query',
    !withoutExpansion.some(row => String(row.rowid) === evidenceId) &&
      withExpansion.some(row => String(row.rowid) === evidenceId),
    `without=${withoutExpansion.map(row => row.rowid)} with=${withExpansion.map(row => row.rowid)}`)
  check('recall trace records the finite added-term list',
    withExpansion.recallTrace?.steps.some(step =>
      step.name === 'query.expand' && step.meta.addedTerms.includes('garden')),
    `steps=${JSON.stringify(withExpansion.recallTrace?.steps)}`)

  // P1 regression (mneme#7 review): stopword filtering must not swallow
  // entire short conversational queries. Common English nouns and adverbs
  // like `used`, `recently`, `app` are deliberately NOT stopwords — otherwise
  // "what have I used recently" would return 0 hits even when a memory does
  // match. Silent under-recall violates the "fail open for reads" contract.
  const appEvidenceId = storeMemory({
    content: 'I switched to a new billing app recently for the household budget.',
    memoryType: 'long_term',
    category: 'preference',
    importance: 5,
  })
  const shortResults = recallMemories({
    query: 'what have I used recently',
    limit: 10,
    _internal: true,
  })
  check('short conversational queries with everyday nouns still hit matching content',
    shortResults.some(row => String(row.rowid) === appEvidenceId),
    `ids=${shortResults.map(row => row.rowid)}`)

  closeMemory()
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
