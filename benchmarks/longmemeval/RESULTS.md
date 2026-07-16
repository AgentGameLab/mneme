# LongMemEval retrieval baseline — 2026-07-16

This report compares clean git HEAD `2efd77a71ad35cdb721548c4bcda2794def8b3aa`
with the working-tree candidate using all 470 non-abstention questions from
`longmemeval_s_cleaned.json`.

- Dataset SHA-256: `D6F21EA9D60A0D56F34A05B609C79C88A451D2AE03597821EA3D5A9678C3A442`
- Retrieval: FTS, session granularity, limit 10, no embedding API
- Candidate module-graph SHA-256: `b642fd7515ac629e763f8f8ddc4ffc1622d0c92bef5b143b4f07673ac3c42ab0`
- Baseline module-graph SHA-256: `6462790727200e486ab05207b18d2f5ef12347f22b8584c1557fd129a97fe1ff`
- Full local report: `staging/longmemeval-ab-470-final-provenance.json` (ignored runtime artifact)

## Overall A/B

| Metric | Baseline | Candidate | Delta |
|---|---:|---:|---:|
| MRR | 91.6835% | 92.0381% | +0.3546 pp |
| recall_any@3 | 94.8936% | 95.5319% | +0.6383 pp |
| recall_all@5 | 83.4043% | 83.6170% | +0.2128 pp |
| recall_any@10 | 98.9362% | 99.3617% | +0.4255 pp |
| recall_all@10 | 90.6383% | 91.2766% | +0.6383 pp |
| NDCG@10 | 90.2655% | 90.7933% | +0.5277 pp |

## Category check

| Category | Cases | MRR baseline → candidate | recall_all@10 baseline → candidate | NDCG@10 baseline → candidate |
|---|---:|---:|---:|---:|
| knowledge-update | 72 | 97.5694% → 97.9167% | 98.6111% → 98.6111% | 96.9357% → 97.3201% |
| multi-session | 121 | 92.0455% → 92.1832% | 80.9917% → 82.6446% | 83.4726% → 84.0541% |
| single-session-assistant | 56 | 100% → 100% | 100% → 100% | 100% → 100% |
| single-session-preference | 30 | 65.2222% → 66.8889% | 96.6667% → 100% | 81.0255% → 84.3589% |
| single-session-user | 64 | 96.0156% → 97.1875% | 100% → 100% | 98.3292% → 99.1104% |
| temporal-reasoning | 127 | 88.4021% → 88.4021% | 85.0394% → 85.0394% | 86.7827% → 86.7827% |

No category regressed on MRR, recall_all@10, or NDCG@10 in this run.

## Scope

This is a deterministic retrieval evaluation. It is not the LongMemEval QA
score and must not be compared directly with HMS's reported 92.8 answer score.
An answer-generation run needs separately recorded model, prompt, judge,
token, latency, and cost provenance.
