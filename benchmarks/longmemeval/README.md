# LongMemEval retrieval gate

This harness evaluates mneme against the official LongMemEval session-level
retrieval labels. It mirrors the official protocol's `answer_session_ids` and
reports `recall_any`, `recall_all`, and NDCG at 1/3/5/10, plus MRR.

Abstention questions (`question_id` ending in `_abs`) are excluded by default,
matching the official retrieval evaluation. Sampling is deterministic and
stratified by all six question categories, avoiding the category bias of taking
the first N rows.

## Quick smoke

```powershell
node benchmarks/longmemeval/run.mjs `
  --dataset C:\data\longmemeval_s_cleaned.json `
  --per-category 3 `
  --granularity turn `
  --limit 10 `
  --concurrency 3
```

The default `fts` mode removes embedding variables in each worker so a review
gate cannot accidentally spend API budget. Each question runs in an isolated
temporary SQLite database. `--granularity session` stores each history session
as one memory. `--granularity turn` mirrors the official turn index by storing
user turns, then deduplicates ranked turns back to session IDs for session-level
metrics.

Use `--mode hybrid` only when sqlite-vec and embedding configuration are
available. The report records the actual trace mode, so a missing extension
cannot silently masquerade as a hybrid result.

For deterministic ablations, use `--query-expansion on|off`,
`--stopword-filtering on|off`, and `--fts-scoring normalized|legacy`. Reports
record all three settings so differently configured runs cannot be conflated.
Each engine entry also records the recursive local-module SHA-256 graph plus
its git HEAD/dirty state, so a path-only report cannot be mistaken for a
reproducible result.

## Cross-worktree A/B

```powershell
node benchmarks/longmemeval/run.mjs `
  --dataset C:\data\longmemeval_s_cleaned.json `
  --per-category 5 `
  --engine baseline=E:\Project\mneme-baseline\index.mjs `
  --engine candidate=E:\Project\mneme\index.mjs `
  --output C:\tmp\mneme-longmemeval-ab.json
```

The first engine is the baseline. Later engines receive an overall metric delta
against it. The same selected questions and retrieval limit are used for every
engine.

Runtime reports under `benchmarks/longmemeval/results/` are ignored. Pass
`--keep-artifacts` only when a failed case needs its per-question database for
inspection.

This is a retrieval gate, not a QA score. Answer generation and LLM judging must
be reported separately with model, prompt, token, cost, and judge provenance.

The latest checked retrieval A/B is recorded in [RESULTS.md](./RESULTS.md).
