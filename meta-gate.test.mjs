// Quick self-check for meta-gate. Run: node meta-gate.test.mjs
// Uses dynamic import so we can set env vars before the module reads them.

// Configure the soft-binding vocabularies before importing the gate.
process.env.MNEME_META_GATE_PROJECT_NAMES = 'AbyssDatabase,BlueBlob'
process.env.MNEME_META_GATE_PERSON_NAMES = '小天,千夏,爱芮,小梦'

const { applyMetaGate } = await import('./meta-gate.mjs')

const cases = [
  // Downgrade (hard bindings — work with zero configuration)
  { content: 'AbyssDatabase v0.2.0 released', expect: true, label: 'project+version' },
  { content: '2026-05-05 ship notes for the mesh refactor', expect: true, label: 'iso_date' },
  { content: 'continues from mem 6008 personality rules', expect: true, label: 'mem_ref' },
  { content: 'edit E:/Project/example/store.mjs to add the guard', expect: true, label: 'abs_path' },
  { content: 'after commit 41171eb we must verify the committer', expect: true, label: 'commit_hash' },

  // Downgrade (soft bindings — require env-configured vocabularies)
  { content: '小天 and 千夏 aligned on the approach', expect: true, label: 'multi_person (env)' },

  // Pass — signal-word cue and no bindings
  { content: 'cross-project rule: verify before you cite, always', expect: false, label: 'meta_signal_head' },
  { content: 'heuristic: separate exploration and exploitation modes explicitly', expect: false, label: 'meta_signal_heuristic' },
  { content: 'stop and re-read the API boundary before committing to a refactor', expect: false, label: 'pure_abstract' },
  { content: '铁律：submitting a tool_use call, scan close-tag pairing once', expect: false, label: 'meta_signal_teilv' },

  // Pass — commit_hash regex now requires at least one letter, so pure digits are safe
  { content: 'listen on port 8080000 in the dev sandbox', expect: false, label: 'digit_only_not_hash' },

  // Pass — single person mention below multi-person threshold
  { content: 'when writing 小天 should not inflate importance to please anyone', expect: false, label: 'single_person' },
]

let pass = 0, fail = 0
for (const c of cases) {
  const r = applyMetaGate(c.content, 'meta_knowledge')
  const ok = r.downgraded === c.expect
  if (ok) pass++
  else fail++
  const flag = ok ? '✓' : '✗'
  console.log(`${flag} [${c.label}] downgrade=${r.downgraded} expect=${c.expect}`)
  if (r.reasons.length) console.log(`    reasons: ${r.reasons.join(' | ')}`)
  if (!ok) console.log(`    content: ${c.content}`)
}

// Non-meta requests pass through untouched.
const passThrough = applyMetaGate('AbyssDatabase v0.2.0', 'semi_abstract')
console.log(`\n[pass-through] semi request → level=${passThrough.finalLevel} downgraded=${passThrough.downgraded}`)
if (passThrough.finalLevel !== 'semi_abstract' || passThrough.downgraded) fail++
else pass++

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
