// Regression test for level-aware RRF rank offsets in hybrid recall.
// Sets a throwaway DB path to ensure this test never targets tokenmem.db.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const root = mkdtempSync(resolve(tmpdir(), 'mneme-level-rank-offset-'))
process.env.TOKENMEM_DB_PATH = resolve(root, 'tokenmem.test.db')

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ` -- ${detail}` : ''}`) }
}

try {
  const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8')
  const hybridSource = source.slice(source.indexOf('export async function recallMemoriesHybrid'))
  const offsetMatch = hybridSource.match(/const LEVEL_RANK_OFFSET = (\{[^\n]+\})/)
  const rrfMatch = source.match(/const RRF_K = (\d+)/)
  const contributionMatch = hybridSource.match(/const contribution = 1 \/ \(RRF_K \+ idx \+ 1 \+ offset\)/)
  // Pins the composite's shape. importanceScore left the sum deliberately: a
  // self-rated field measured to be uncorrelated with use was buying 2-4 rank
  // positions against RRF's ~0.0026 spacing. See ranking-importance.integration.test.mjs.
  const scoreMatch = hybridSource.match(/const score = \(rrf \* 10 \+ freqScore \* 0\.10 \+ timeScore \* 0\.06\) \* decay/)
  const levelWeightMatch = hybridSource.match(/const levelWeight = LEVEL_WEIGHT\[row\.memory_level\] \|\| 1\.0/)

  check('hybrid fusion declares the intended level rank offsets',
    offsetMatch?.[1] === '{ meta_knowledge: -2, semi_abstract: 0, concrete_trace: 4 }',
    `offset=${offsetMatch?.[1]}`)
  check('hybrid RRF applies the offset inside each rank contribution',
    Boolean(contributionMatch),
    'expected 1 / (RRF_K + idx + 1 + offset)')
  check('hybrid composite no longer multiplies a level weight',
    Boolean(scoreMatch) && !levelWeightMatch)

  if (offsetMatch && rrfMatch) {
    const offsets = Function(`return (${offsetMatch[1]})`)()
    const rrfK = Number(rrfMatch[1])
    const scoreAtFtsRank = (memoryLevel, rank) =>
      10 / (rrfK + rank + (offsets[memoryLevel] || 0))

    const semiRank1 = scoreAtFtsRank('semi_abstract', 1)
    const metaRank4 = scoreAtFtsRank('meta_knowledge', 4)
    const metaRank1 = scoreAtFtsRank('meta_knowledge', 1)

    check('semi_abstract FTS rank 1 outranks meta_knowledge FTS rank 4',
      semiRank1 > metaRank4,
      `semi@1=${semiRank1} meta@4=${metaRank4}`)
    check('at the same FTS rank, meta_knowledge still outranks semi_abstract',
      metaRank1 > semiRank1,
      `meta@1=${metaRank1} semi@1=${semiRank1}`)
  }
} finally {
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
