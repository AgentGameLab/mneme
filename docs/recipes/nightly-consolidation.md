# Recipe: Nightly Memory Consolidation

Storing memories is the fast half. Curating them is the half that decides whether
your store gets sharper or turns into a junk drawer. This recipe walks through
what mneme gives you for that second half, and how to compose it into a nightly
job you can run by hand, on a cron, or under an LLM agent.

## Why consolidation exists

A write-only mneme is a bad mneme. Every store adds noise; nothing removes it.
Left unattended, a healthy store drifts predictably:

- **Level inflation.** New memories default to `semi_abstract`, but the "important
  ones" quietly get logged as `meta_knowledge`. Over time nearly everything is
  meta — which is the same as nothing being meta (a real snapshot before the
  v2.6 write-gate landed measured 71% of active memories at
  `memory_level=meta_knowledge`).
- **Importance inflation.** `importance` is a soft prior; the agent writing the
  memory is also the agent claiming it's important. Without periodic pressure
  the entire distribution slides up until `imp>=8` is 60%+ of the store.
- **Duplicates.** Same insight recorded three times, three different wordings.
- **Dead concrete traces.** One-off operation logs the store recorded because
  the write path was cheap, that will never be recalled again.
- **Zero-hit queries.** Real questions the agent asked repeatedly and never
  found an answer for — a signal to write something new, not to prune.
- **Chain integrity drift.** `superseded_by` pointers that dangle, or old rows
  that were marked superseded but never soft-deleted.

Consolidation is how you push back on all six drifts on a regular cadence.

## The primitive layer

mneme exposes a small set of building blocks. All of these are either idempotent
or come with a `--dry-run` mode.

| Primitive | Where | What it does |
|---|---|---|
| `runMemoryHealth()` / `--health` | `memory-health.mjs`, also `index.mjs --health` | Five readonly scans — inflation, dead-concrete, integrity, blindspot, near-dup. Never mutates. |
| `--surface-cold` | `index.mjs` | Lists high-importance rows untouched for N days, ordered by `decay_score`. Readonly — the caller decides supersede/merge. |
| `expireMemories()` | `index.mjs` | Soft-deletes rows past their `expires_at` TTL. Idempotent. |
| `runDecayCycle({ tauHours })` | `index.mjs` | Refreshes `decay_score` for every active row using power-law decay over `last_accessed`. Idempotent. |
| `runLevelMigration({ limit, anchorPath, dryRun })` | `index.mjs` | Frequency-driven `memory_level` migration: demote unused `meta` back to `semi`, promote well-used `concrete` to `semi`. Writes a JSONL rollback anchor first when `anchorPath` is passed. |
| `extractMissingEntities()` | `index.mjs` | Backfills the entity layer for rows without it. Only runs when `ENTITY_LLM_*` is configured. |
| `--consolidate` | `index.mjs` | Composes `expireMemories` + `runDecayCycle` + `runLevelMigration` into one nightly call. `--dry-run` previews without writing. |

The whole layer is **detection-only for anything semantic**. The engine will
demote a `meta_knowledge` row that hasn't been recalled in 90 days — that's a
mechanical rule with a rollback anchor. It will **not** decide to merge two
similar rows or supersede a duplicate — that's a semantic call the caller
makes (a human, or an LLM agent that read the health report).

## The two-step loop

Every consolidation pass, whether human or scripted, is the same shape:

```
[1] SURFACE  →  [2] APPLY
  (readonly)     (mutation)
```

- **Surface** with `--health` and `--surface-cold`. Both are readonly and safe
  to run as often as you want. They produce a report and a list of candidates.
- **Apply** with `--consolidate` (mechanical) or through `store_memory` with
  `supersedes: [...]` (semantic, driven by a human or LLM reading the surface
  output).

Keep the split. Mixing surface and mutation in one pass is the same failure
mode as auto-merging PRs on green CI: sooner or later you'll silently delete
something you wanted to keep, and you won't notice for weeks.

### On atomicity

`--consolidate` runs its three primitives in sequence — expire, decay,
level-migrate. Each one has its own transaction internally, but there is
**no cross-step atomicity**: if step 3 fails after step 2 committed, the
decay updates are still on disk. Recovery paths for each step:

- **expireMemories** — reversible with `UPDATE memories SET deleted_at = NULL
  WHERE deleted_at BETWEEN <run-start-ts> AND <run-end-ts>` (soft delete only,
  the row content is intact).
- **runDecayCycle** — the next run recomputes every `decay_score` from
  `access_count` and `last_accessed`, so a bad tau on one night is corrected
  on the next.
- **runLevelMigration** — the JSONL rollback anchor above.

If any of the three throws, the previous steps have already committed. In
practice the primitives are simple SQL and rarely fail mid-flight; treat
mid-run failure as an operational incident (log, re-run) rather than a
consistency invariant to defend at the storage layer.

## Three cadences

Pick one and stick with it — churn on cadence is worse than any specific choice.

### A. Manual (start here)

```bash
# Once a week, or when something feels off:
node index.mjs --health
node index.mjs --surface-cold --limit 20
```

Read the report. Fix things you actually recognize as noise. Then run the
mechanical half:

```bash
node index.mjs --consolidate --dry-run   # preview
node index.mjs --consolidate             # apply
```

### B. Cron / scheduled

Two jobs. A surface job that writes a report you'll read tomorrow, and a
mechanical job that runs the safe mutations tonight.

```
# Every night at 03:00 — surface only, write JSON for tomorrow's review
0 3 * * *   node /path/to/mneme/index.mjs --health --format json > /tmp/mneme-health-$(date +\%F).json

# Every night at 03:15 — safe mechanical pipeline
15 3 * * *  node /path/to/mneme/index.mjs --consolidate --level-anchor /tmp/mneme-anchor-$(date +\%F).jsonl
```

The level-migration rollback anchor lets you revert one bad run. mneme already
depends on `better-sqlite3`, so the safest replay uses `node` — no extra deps,
same DB resolution logic mneme itself uses, works on Windows and POSIX:

```js
// rollback-level-migration.mjs
// usage: MNEME_DB_PATH=/path/to/engram.db node rollback-level-migration.mjs /tmp/anchor.jsonl
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
const [anchorPath] = process.argv.slice(2)
const dbPath = process.env.MNEME_DB_PATH || process.env.TOKENMEM_DB_PATH
if (!anchorPath || !dbPath) throw new Error('anchorPath arg and MNEME_DB_PATH env required')
const db = new Database(dbPath)
const stmt = db.prepare(
  `UPDATE memories SET memory_level = ?, importance = ? WHERE rowid = ?`
)
const tx = db.transaction((rows) => { for (const r of rows) stmt.run(r.old_level, r.old_importance, r.rowid) })
const rows = readFileSync(anchorPath, 'utf-8').split('\n').filter(Boolean).map(JSON.parse)
tx(rows)
console.log(`rolled back ${rows.length} rows`)
db.close()
```

If you prefer shell and have `sqlite3` + `jq` installed, the equivalent
one-liner is bash-specific and cwd-sensitive — verify `$DB` resolves to the
same store mneme uses before running:

```bash
DB="${MNEME_DB_PATH:?set MNEME_DB_PATH to the mneme engram.db path}"
while IFS= read -r line; do
  rowid=$(jq -r .rowid <<<"$line")
  level=$(jq -r .old_level <<<"$line")
  imp=$(jq -r .old_importance <<<"$line")
  [ -n "$rowid" ] && sqlite3 "$DB" "UPDATE memories SET memory_level='$level', importance=$imp WHERE rowid=$rowid;"
done < /tmp/mneme-anchor-YYYY-MM-DD.jsonl
```

### C. LLM agent in the loop

The surface / apply split is designed for an LLM agent. A minimal loop:

1. Agent calls `--health --format json` (or the `recall_memory` MCP tool to
   ask about a specific area).
2. Agent identifies the concrete decisions worth making — a pair to supersede,
   a stale row to promote, a repeat-query the store should answer.
3. Agent calls `store_memory` with `supersedes: [...]` for each decision.
4. Agent triggers `--consolidate` last, once the semantic pass is done.

The engine does not judge the semantic step. It surfaces evidence and applies
the mechanical steps; the agent applies its own reasoning to the surface.

## Anti-patterns

Six ways to make consolidation worse than nothing:

1. **Auto-merge duplicates.** Cosine 0.97 says *related*, not *duplicate*. Real
   duplicates need someone (or an LLM) to read both and decide which wording
   survives. Auto-merge on a cosine threshold silently deletes signal.
2. **Only prune, never write.** The `blindspot` scan surfaces queries that got
   zero hits. That's often a signal to write a new memory, not to raise the
   recall threshold. Don't treat "zero results" as "system working correctly".
3. **Raise `importance` to keep something.** If a memory is being demoted by
   `runLevelMigration`, boosting its importance to save it defeats the point.
   Either it's actually meta-cross-context (add a signal word, restore level
   manually), or it's just semi and the migration is right.
4. **Skip `--dry-run` on the first run of `--consolidate`.** The safe defaults
   are safe. The unsafe defaults are the ones you overrode without checking.
5. **No rollback anchor.** Every level migration in production should pass
   `--level-anchor`. Disk is cheap; a one-line rollback beats reasoning about
   an unexpected drift.
6. **Consolidating a store you don't own.** These primitives target the local
   sqlite file. Running them against a store shared with other agents or
   another human's session is a coordination problem, not a mneme problem —
   solve it upstream.

## Two questions to answer before you schedule this

If you can't answer both, don't cron it yet:

- **What am I comparing against?** Save a `--health --format json` snapshot
  every night. Diff last night's `inflation` block against tonight's. If
  `meta_pct` isn't trending down (or steady) after two weeks of consolidation,
  something in the write path is fighting you.
- **What does the rollback plan look like?** If tomorrow's consolidate demotes
  the wrong 30 rows, how do you get them back? The `--level-anchor` JSONL is
  the answer, but you need to know where it lands and how to replay it.

## See also

- [`docs/configuring-your-agent.md`](configuring-your-agent.md) § 6 — a short
  version of this recipe for the agent's own instruction file.
- The `memory-health.mjs` module — every scan is an exported function, so you
  can compose them into your own tools without spawning a child process.
