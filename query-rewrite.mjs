const RULES = [
  {
    pattern: /\b(home[- ]?grown|garden[- ]?grown)\b|自种|自家种|菜园/i,
    terms: ['garden', 'harvest', 'harvested', 'produce', 'cook', 'cooking', 'recipe', 'meal'],
  },
]

export function expandRecallQuery(query) {
  const original = String(query || '').trim()
  if (!original) return { text: '', addedTerms: [] }
  const lower = original.toLowerCase()
  const addedTerms = []
  for (const rule of RULES) {
    if (!rule.pattern.test(original)) continue
    for (const term of rule.terms) {
      if (!lower.includes(term.toLowerCase()) && !addedTerms.includes(term)) addedTerms.push(term)
    }
  }
  return {
    text: addedTerms.length > 0 ? `${original} ${addedTerms.join(' ')}` : original,
    addedTerms,
  }
}
