# Contributing to mneme

Thanks for your interest in mneme — a local-first, persistent long-term memory
layer for Claude Code agents (SQLite + FTS5 + sqlite-vec + RRF, exposed over MCP).

[中文版 / Chinese version →](CONTRIBUTING.zh-CN.md)

## Design values (read this first)

mneme degrades gracefully, never fatally. The single most important rule when
contributing:

- **Optional things must stay optional.** The vector path (sqlite-vec) and the
  Chinese tokenizer (wangfenjin/simple) are *enhancements*. If neither extension
  is present, mneme must still boot, store, and recall — falling back to FTS5
  (`unicode61`) and, ultimately, `LIKE` matching. A change that makes the core
  path require an extension is a regression, even if your machine has it.
- **Fail open for reads, fail closed for writes you can't verify.** Recall that
  finds nothing returns empty, not an error. A store that can't validate its
  input should refuse rather than corrupt the store.

## Development setup

Requirements:

- Node.js 20+ (CI/dev tested on 24)
- `npm install` — the only hard dependency is `better-sqlite3` (native; needs a
  C++ toolchain. On Node 24 you need `better-sqlite3` >= 12).

Optional native extensions (drop the prebuilt binaries under `lib/`):

- `sqlite-vec` — vector KNN search. Without it, recall uses FTS5 only.
- `wangfenjin/simple` — Chinese word-level FTS5 tokenizer (jieba). Without it,
  the schema defaults to `unicode61` and `initMemory()` auto-upgrades to
  `simple` the moment the extension appears.

Embedding (optional) is configured purely through env vars — see the README's
Configuration table. With no `EMBEDDING_API_*` set, mneme runs FTS-only.

## Running locally

```bash
# CLI: store / recall round-trip
node index.mjs --recall "your query" --format json

# MCP server (stdio for Claude Code, or HTTP for a shared daemon)
node mcp-server.mjs                       # stdio
node mcp-server.mjs --transport=http --port=18790
```

Point at a throwaway DB with `TOKENMEM_DB_PATH=/tmp/scratch.db` so you never
touch a real memory store while developing.

## Project layout

| Path | What |
|------|------|
| `index.mjs` | Core: schema init, migrations, store, hybrid recall (FTS5 + vec + RRF), decay |
| `mcp-server.mjs` | MCP server (stdio + HTTP transports) exposing `store_memory` / `recall_memory` / `memory_stats` |
| `schema.sql` | Table + FTS5 virtual-table DDL. New columns go through `migrations/`, not by editing tables in place |
| `migrations/` | Forward-only, idempotent (`IF NOT EXISTS` / guarded `ALTER`) — old DBs must upgrade cleanly |
| `backfill-embeddings.mjs` | Backfill vectors for rows stored before embedding was configured |
| `migrate-claude-memories.mjs` | One-shot importer from Claude Code's flat-file memory |

## Before you open a PR

There is no heavy test harness — verification is hands-on, and PRs are expected
to show it:

1. **Fresh install boots without extensions.** Run `index.mjs` against a brand-new
   `TOKENMEM_DB_PATH` with no `lib/` extensions present; confirm every table is
   created and a store→recall round-trip works. (This is the exact path that
   broke once when the schema hardcoded a tokenizer — don't reintroduce it.)
2. **Existing DB still migrates.** Run against a populated copy; confirm
   migrations are no-ops the second time and don't drop data.
3. **Match the surrounding code.** Same naming, comment density, and idiom. Add a
   comment only to state a constraint the code can't show.
4. `node --check` every file you touched.

Keep PRs focused — one concern per PR. Schema changes ship as a new file in
`migrations/`, never as an in-place edit of an existing migration.

## Reporting issues

Useful bug reports include: your Node version, whether the optional extensions
are present, the exact command, and the failure output. Recall-quality issues
are most actionable with the query, what you expected, and what came back.

By contributing you agree your contributions are licensed under the
[MIT License](LICENSE).
