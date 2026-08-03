#!/usr/bin/env node
// Build the evaluation set for the recall hook — deterministically.
//
// Why this file exists: the 28.3% → 41.7% precision figures that motivated
// PR #21 were measured against a sample that was never written to disk. The
// numbers can't be reproduced, compared against, or audited. Meanwhile the KOS
// side had just shipped a hard gate requiring per-question results and a set
// hash on every eval run. The rule was installed in one system while the other
// ran bare — so this rebuilds the set under the same discipline.
//
// Sampling is deterministic and leaves no room to hand-pick:
//   - candidates: role='user', length in the same 12..2000 window the hook
//     gates on, and passing the hook's own shouldTrigger regex (a prompt the
//     hook would skip tells us nothing about the hook)
//   - order: sha256(content) lexicographic — independent of insertion order,
//     unpredictable ahead of time, fully recomputable
//   - split: a SECOND, independently salted hash. Splitting on a prefix of the
//     ordering hash sends every question to one side: taking the first N of a
//     hash-sorted list selects for small leading bytes, so "first byte < 128"
//     is true for all of them. First run of this script produced dev 60 /
//     held-out 0 and still looked healthy — deterministic, hashed, written to
//     disk. Only the split counts gave it away. Ordering key and stratifying
//     key must be independent.
//
// Tune on dev. Report on held-out. Burn held-out after it is used.
//
// TWO outputs, because reproducibility and confidentiality pull opposite ways
// here and only one of them is obvious. This is a public repo, and the sample
// is drawn from real conversations — a scan of the first build found questions
// about a nominee-shareholding agreement and someone's exit package sitting in
// the set. Committing prompt text would have published them.
//
//   eval/hook-recall-set-v1.json          committed — hashes, splits, lengths,
//                                         row ids, set hash. No prompt text.
//   eval/.hook-recall-set-v1.local.json   gitignored — the same rows with text,
//                                         for actually running the eval.
//
// The set stays auditable (the hash pins which questions are in it, and any
// substitution changes it) and reproducible (re-run this against the db to get
// the text back), without the text itself leaving the machine.
//
// Usage: node eval/build-hook-recall-set.mjs [--size 60] [--out <path>]

import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')

const args = process.argv.slice(2)
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const SIZE = parseInt(argOf('--size', '60'), 10)
const OUT = resolve(argOf('--out', resolve(__dirname, 'hook-recall-set-v1.json')))

// Kept byte-identical to hooks/mneme-recall.mjs shouldTrigger(). If that gate
// changes, this must change with it — otherwise the eval set drifts away from
// the population the hook actually sees.
const TRIGGER = /怎么|如何|为什么|为啥|能不能|可不可以|是不是|哪里|帮我|设计|方案|怎么办|排查|根治|优化|实现|对比|区别|要不要|\?|？/
function shouldTrigger(p) {
  if (!p) return false
  const len = p.trim().length
  if (len < 12) return false
  if (len > 2000) return false
  return TRIGGER.test(p)
}

// The conversations table stores harness-injected text under role='user' too:
// task notifications, the per-turn "current reality" block, system reminders,
// forwarded group history. 22 of the first 60 sampled questions (37%) were
// this, not anything a person asked. Those prompts are stuffed with generic
// vocabulary, which is exactly what drives the single-common-word false
// positives the hook's precision problem is made of — leaving them in measures
// the hook against traffic it should never have been judged on.
//
// Deliberately narrow: only structural markers no human would type. A person
// writing about a task notification in their own words stays in the set.
const MACHINE_PROMPT = /^\s*<(task-notification|system-reminder|command-name|command-message|local-command)|<task-id>|tool-use-id|^\s*\[当前现实|^\s*\[SYSTEM NOTIFICATION|^\s*来自飞书群的消息|^\s*## 近期对话历史/

const sha = (s) => createHash('sha256').update(s, 'utf-8').digest('hex')

const dbPath = existsSync(resolve(REPO, 'engram.db'))
  ? resolve(REPO, 'engram.db')
  : resolve(REPO, 'tokenmem.db')
const db = new Database(dbPath, { readonly: true })

const rows = db.prepare(`
  SELECT id, content, created_at, platform
  FROM conversations
  WHERE role = 'user' AND content IS NOT NULL
`).all()

const seen = new Set()
const candidates = []
for (const r of rows) {
  const content = String(r.content).trim()
  if (MACHINE_PROMPT.test(content)) continue
  if (!shouldTrigger(content)) continue
  const h = sha(content)
  if (seen.has(h)) continue           // exact duplicates would double-weight a question
  seen.add(h)
  candidates.push({ id: r.id, content, hash: h, created_at: r.created_at, platform: r.platform })
}

candidates.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
const SPLIT_SALT = 'mneme-hook-recall-split-v1'
const picked = candidates.slice(0, SIZE).map((c) => ({
  ...c,
  // Independent of the ordering hash — see the note at the top of this file.
  split: parseInt(sha(SPLIT_SALT + c.content).slice(0, 2), 16) < 128 ? 'dev' : 'held-out',
}))

const setHash = sha(picked.map((p) => p.hash).join('\n'))
const devN = picked.filter((p) => p.split === 'dev').length

const meta = {
  _built_by: 'eval/build-hook-recall-set.mjs',
  _sampling: 'role=user, machine-injected text dropped, hook shouldTrigger gate, dedup by content sha256; ordered by content sha256; split on an independently salted hash',
  _db: dbPath.replace(REPO, '<repo>'),
  _population: { conversations_user_rows: rows.length, passing_gate_deduped: candidates.length },
  _size: picked.length,
  _split: { dev: devN, 'held-out': picked.length - devN },
  _set_sha256: setHash,
}

if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true })

// Committed: no prompt text.
writeFileSync(OUT, JSON.stringify({
  ...meta,
  _note: 'Prompt text is deliberately absent — this repo is public and the sample is drawn from real conversations. Re-run the builder to regenerate the local copy.',
  questions: picked.map((q) => ({ id: q.id, hash: q.hash, split: q.split, length: q.content.length, created_at: q.created_at, platform: q.platform })),
}, null, 2), 'utf-8')

// Local only: the text, for running the eval.
const LOCAL = resolve(dirname(OUT), '.' + OUT.split(/[\\/]/).pop().replace(/\.json$/, '') + '.local.json')
writeFileSync(LOCAL, JSON.stringify({ ...meta, questions: picked }, null, 2), 'utf-8')

console.log(`population: ${rows.length} user rows → ${candidates.length} pass the hook gate (deduped)`)
console.log(`picked ${picked.length}  dev ${devN} / held-out ${picked.length - devN}`)
console.log(`set sha256: ${setHash}`)
console.log(`written: ${OUT}  (no text)`)
console.log(`written: ${LOCAL}  (with text — gitignored)`)
