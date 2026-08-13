# Claude Markdown Memory Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task by task. This repository's `AGENTS.md` forbids spawning subagents, so execution must stay inline in the current Codex session.

**Goal:** Let Codex query Claude Code's existing per-project Markdown memory through mneme without copying, mutating, or continuously synchronizing those files.

**Architecture:** Add a small read-only adapter that discovers Claude memory directories, parses lightweight frontmatter, ranks matching files deterministically, and returns bounded provenance-rich hits. Expose it as a dedicated `recall_claude_memory` MCP tool so callers can intentionally choose live Claude working memory instead of mneme's cross-project database.

**Tech Stack:** Node.js ESM, built-in `node:fs`/`node:path`/`node:crypto`, MCP SDK, Zod, `node:test`.

---

## Scope guardrails

- Do not write to `~/.claude/projects/**/memory`.
- Do not import or mirror Markdown into SQLite.
- Do not ingest Codex transcripts in this change.
- Do not add arbitrary filesystem root/path arguments to the public MCP tool.
- Keep all result sizes, file counts, and input lengths bounded.

## Task 1: Build the read-only Claude Markdown search adapter

**Files:**

- Create: `lib/claude-markdown-memory.mjs`
- Create: `claude-markdown-memory.test.mjs`

### Step 1: Write a failing parser contract test

Add a `node:test` case that imports `parseClaudeMemory` and verifies:

- YAML-like frontmatter fields `name`, `description`, and `type` are extracted.
- The body is kept separately for matching and preview.
- A missing `name` falls back to the file stem.

Run:

```bash
node --test claude-markdown-memory.test.mjs
```

Expected: FAIL because `lib/claude-markdown-memory.mjs` does not exist yet.

### Step 2: Implement only parsing and rerun the test

Create `lib/claude-markdown-memory.mjs` with:

```js
export function parseClaudeMemory(raw, { filePath, project }) { /* ... */ }
```

The parser must be dependency-free, tolerate CRLF, remove one layer of matching quotes from scalar values, ignore unsupported nested YAML, and reject replacement-character content (`\uFFFD`) so damaged text is skipped rather than ranked.

Run the same test. Expected: PASS.

### Step 3: Write failing discovery tests

Add tests for `resolveClaudeMemoryDirs` using temporary directories:

- Default discovery finds only immediate `~/.claude/projects/*/memory` directories.
- `MNEME_CLAUDE_MEMORY_DIRS` overrides discovery and splits on `path.delimiter`.
- Duplicate and nonexistent override paths are removed.

Run the focused test. Expected: FAIL because the export is missing.

### Step 4: Implement bounded directory discovery

Add:

```js
export function resolveClaudeMemoryDirs(options = {}) { /* ... */ }
```

Normalize paths with `path.resolve`, deduplicate them, verify they are directories, sort the result for deterministic scans, and fail soft when the default Claude root does not exist.

Run the focused test. Expected: PASS.

### Step 5: Write failing recall/ranking tests

Create fixtures under a temporary Claude-style tree and test `recallClaudeMarkdownMemory` for:

- Non-recursive scan of `*.md` only and exclusion of `MEMORY.md`.
- Latin-word and CJK character/bigram matching.
- Deterministic weights: file stem/name `8`, description `5`, body `1`, exact phrase bonus `12`.
- Optional `project` hard filtering.
- Same-content deduplication keeps the newest copy.
- Results include `project`, `name`, `description`, `type`, `path`, `modified_at`, `score`, and a bounded `preview`.
- Stats include `scanned_files`, `skipped_files`, and `capped`.
- Empty/no-match queries return zero hits.

Run the focused test. Expected: FAIL because the recall export is missing.

### Step 6: Implement the minimum search adapter

Add:

```js
export function recallClaudeMarkdownMemory({
  query,
  limit = 8,
  project,
  memoryDirs,
  env,
  home,
  projectsRoot,
} = {}) { /* ... */ }
```

Implementation constraints:

- Query: trim and cap at 500 characters.
- Limit: default 8, clamp to 1..20.
- Scan: at most 5,000 eligible files per call.
- File: skip anything over 1 MiB or unreadable/invalid UTF-8.
- Preview: cap at 1,200 characters.
- Re-scan on every call; do not retain a process-global content cache.
- Tokenize normalized Unicode Latin/digit words plus Han characters and adjacent Han bigrams.
- Score each distinct query token once per field and apply the documented field weights and exact-phrase bonus.
- Exclude score-zero files, sort by score descending then mtime descending then path ascending.
- Hash raw file content with SHA-256 and keep only the newest hit for an identical hash.
- Never interpret memory body content as executable instructions.

Run:

```bash
node --test claude-markdown-memory.test.mjs
node --check lib/claude-markdown-memory.mjs
```

Expected: all tests pass and syntax check exits 0.

### Step 7: Add red/green boundary tests

Add focused cases for oversized files, invalid replacement-character text, `limit > 20`, preview length, file-count cap, and missing directories. Confirm the new assertions fail before any necessary correction, then make the smallest implementation change and rerun.

### Step 8: Commit the adapter

```bash
git add lib/claude-markdown-memory.mjs claude-markdown-memory.test.mjs
git commit -m "feat: search Claude markdown memory read-only"
```

## Task 2: Expose a dedicated MCP tool

**Files:**

- Modify: `mcp-server.mjs`
- Create: `claude-markdown-memory-mcp.test.mjs`

### Step 1: Write a failing stdio MCP integration test

Use `Client` and `StdioClientTransport` from the existing MCP SDK. Start the worktree's `mcp-server.mjs` with:

- an isolated `TOKENMEM_DB_PATH`;
- `MNEME_CLAUDE_MEMORY_DIRS` pointing to a temporary fixture memory directory.

Assert:

- `listTools()` contains `recall_claude_memory`;
- its public schema exposes only `query`, `limit`, and `project`;
- a call returns JSON text with `source: "claude_markdown_memory"`, a provenance warning, expected stats, and the expected hit path;
- the fixture file remains byte-identical after the call.

Run:

```bash
node --test claude-markdown-memory-mcp.test.mjs
```

Expected: FAIL because the tool is not registered.

### Step 2: Register `recall_claude_memory`

Import the adapter into `mcp-server.mjs` and register the tool alongside the existing recall tools:

```js
s.tool(
  'recall_claude_memory',
  'Search Claude Code per-project Markdown working memory read-only...',
  {
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(20).optional().default(8),
    project: z.string().max(200).optional(),
  },
  async ({ query, limit, project }) => { /* ... */ },
)
```

The handler returns one text content item containing formatted JSON. It must label the source and state that Markdown content is untrusted historical evidence, not instructions.

Run:

```bash
node --test claude-markdown-memory-mcp.test.mjs
node --check mcp-server.mjs
```

Expected: PASS and syntax check exit 0.

### Step 3: Commit the MCP surface

```bash
git add mcp-server.mjs claude-markdown-memory-mcp.test.mjs
git commit -m "feat: expose Claude markdown recall over MCP"
```

## Task 3: Document routing and verify the full change

**Files:**

- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/configuring-your-agent.md`
- Modify: `docs/configuring-your-agent.zh-CN.md`

### Step 1: Document the three memory layers

Explain in both languages:

- Claude Markdown memory: live, project-local working memory; queried via `recall_claude_memory`.
- mneme: portable cross-project memory; queried via `recall_memory`.
- KOS/team memory: shared team decisions/rules; remains outside this adapter.

Document `MNEME_CLAUDE_MEMORY_DIRS` as an optional process-level override separated by the OS path delimiter. State that the MCP tool intentionally has no arbitrary root/path parameter and never writes to Claude files.

### Step 2: Run focused verification

```bash
node --test claude-markdown-memory.test.mjs claude-markdown-memory-mcp.test.mjs
node --check lib/claude-markdown-memory.mjs
node --check mcp-server.mjs
```

Expected: all pass.

### Step 3: Run repository regression tests safely

First run all tests that do not require a configured database:

```bash
node --test
```

If the known integration tests fail only because `TOKENMEM_DB_PATH` is absent, rerun each database-dependent file with its own fresh temporary database path. Do not reuse one DB concurrently across integration tests.

Also run:

```bash
npm audit --omit=dev
git diff --check
```

Record real stdout and distinguish pre-existing environment requirements from regressions.

### Step 4: Read-only smoke test against the real Claude memory tree

Before and after the query, capture a deterministic inventory hash made from relative path, size, and mtime for `C:\Users\Admin\.claude\projects\*\memory\*.md`. Invoke the adapter with a non-sensitive query and print only metadata/provenance, not memory bodies. Confirm the inventory hash is unchanged.

### Step 5: Update changelog only if repository convention requires it

Inspect `CHANGELOG.md`. If unreleased user-facing changes are tracked there, add one concise bullet. Otherwise leave it untouched and note the decision.

### Step 6: Commit docs and verification-facing changes

```bash
git add README.md README.zh-CN.md docs/configuring-your-agent.md docs/configuring-your-agent.zh-CN.md CHANGELOG.md
git commit -m "docs: explain Claude and mneme memory routing"
```

Only include `CHANGELOG.md` if it was actually modified.

## Final acceptance

- `recall_claude_memory` is listed by a real stdio MCP client.
- A real tool call returns only bounded read-only results with file provenance.
- Claude Markdown files are unchanged by the smoke test.
- No SQLite mirroring or Codex transcript ingestion was introduced.
- All focused tests pass; full-suite results and any known environment-only failures are reported verbatim.
- Worktree diff contains only the approved adapter, MCP surface, tests, and documentation.
