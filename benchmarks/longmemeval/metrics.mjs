export const DEFAULT_KS = [1, 3, 5, 10]

function dcg(relevances, k) {
  const values = relevances.slice(0, k)
  if (values.length === 0) return 0
  let score = values[0]
  for (let i = 1; i < values.length; i++) {
    score += values[i] / Math.log2(i + 1)
  }
  return score
}

export function evaluateRanking(retrievedIds, correctIds, ks = DEFAULT_KS) {
  const correct = new Set(correctIds.map(String))
  if (correct.size === 0) return null
  const ranked = retrievedIds.map(String)
  const firstRelevant = ranked.findIndex(id => correct.has(id))
  const metrics = {
    mrr: firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1),
  }

  for (const k of ks) {
    const top = ranked.slice(0, k)
    const recalled = new Set(top)
    const relevances = top.map(id => correct.has(id) ? 1 : 0)
    const ideal = Array.from({ length: correct.size }, () => 1)
    const idealDcg = dcg(ideal, k)
    metrics[`recall_any@${k}`] = [...correct].some(id => recalled.has(id)) ? 1 : 0
    metrics[`recall_all@${k}`] = [...correct].every(id => recalled.has(id)) ? 1 : 0
    metrics[`ndcg_any@${k}`] = idealDcg === 0 ? 0 : dcg(relevances, k) / idealDcg
  }
  return metrics
}

function average(rows, field) {
  if (rows.length === 0) return null
  return rows.reduce((sum, row) => sum + Number(row.metrics[field] || 0), 0) / rows.length
}

export function aggregateResults(rows, ks = DEFAULT_KS) {
  const usable = rows.filter(row => row.metrics)
  const fields = ['mrr', ...ks.flatMap(k => [`recall_any@${k}`, `recall_all@${k}`, `ndcg_any@${k}`])]
  const totals = { cases: usable.length }
  for (const field of fields) totals[field] = average(usable, field)

  const byCategory = {}
  for (const row of usable) {
    const category = row.questionType || 'unknown'
    ;(byCategory[category] ||= []).push(row)
  }
  for (const [category, categoryRows] of Object.entries(byCategory)) {
    const summary = { cases: categoryRows.length }
    for (const field of fields) summary[field] = average(categoryRows, field)
    byCategory[category] = summary
  }

  return { overall: totals, byCategory }
}
