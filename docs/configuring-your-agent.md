# Configuring Your Agent to Use mneme Well

mneme is the *backend* — it stores and recalls. But **when** your agent stores, **what**
it stores, and how disciplined it is about levels are driven by your agent's instruction
file, not by mneme. A few lines there are the difference between a memory that gets sharper
over time and one that bloats into a junk drawer.

This guide gives you two things:

1. **An instruction block to paste** into your agent's config.
2. **Where each agent reads that config** (CLAUDE.md, AGENTS.md, `.cursor/rules`, …).

---

## 1. The instruction block

Paste this into your agent's instruction file (see the table in §2 for the exact path).
It's deliberately short — the whole point is that storing should be cheap to read and
deliberate to do.

```markdown
## Memory (mneme)

You have persistent memory via the `mneme` MCP server: `recall_memory`,
`store_memory`, `memory_stats`.

### Recall — check context first
Call `recall_memory` only when the current context lacks a confident answer:
- the user references past work, decisions, people, preferences, or project history
- you're about to look up something you may have recorded before

Skip it when the context already answers, the question is generic, or you already
queried the same topic this session.

### Store — a write gate, not a reflex
Before storing, ask: **will this change my future behavior, or be useful in a
different session?** If no, don't store it — passing chatter, one-off confirmations,
and anything reconstructable from context are not memories.

When you do store:
- **Default `semi_abstract`.** `meta_knowledge` is *earned*, not the default —
  reserve it for genuinely cross-context heuristics. Test: *would this still help
  in a completely unrelated project?* If it's tied to one project / person /
  decision → `semi_abstract`. A one-off operation log → `concrete_trace`.
- **Importance is a weak prior, not a lever.** Anchor it instead of defaulting high:
  `9-10` identity / rules / safety · `7-8` active decisions · `5-6` useful context ·
  `≤4` traces. Don't store everything at 7+. True salience emerges from how often a
  memory is actually recalled — not the number you assign at write time.
- If `store_memory` warns of a **near-duplicate**, supersede the existing entry
  (`supersedes: ["<id>"]`) instead of adding a new one.

### Curate — supersede, don't rewrite
When you find an outdated memory, store a corrected version with
`supersedes: ["<old id>"]`. Replace specific entries; never wholesale-rewrite the store.
```

> **Why these rules?** The biggest failure mode of agent memory is *store-time
> self-rating*: the agent that just did something over-rates and over-abstracts its
> own output, so the store drifts toward "everything is important and everything is
> meta." (We measured 84% `meta` / 92.5% importance ≥7 in a real store before fixing
> it.) The defenses are: make storing deliberate (a gate), keep `meta`/high-importance
> *earned*, and let recall frequency — not write-time labels — drive ranking. mneme's
> ranking already de-weights raw importance and rewards recall frequency, so these
> instructions and the engine pull in the same direction.

---

## 2. Where each agent reads its config

mneme talks to any MCP-capable agent. Each one has its own "instruction file" (and most
support nested/scoped variants). Drop the block from §1 into the file below; the agent
loads it into its system context automatically.

| Agent | Instruction file | Notes |
|-------|------------------|-------|
| **Claude Code** | `~/.claude/CLAUDE.md` (global) or `./CLAUDE.md` (project; nested dirs stack) | Loaded into the system prompt every session. Best place for the global block. |
| **OpenAI Codex CLI** | `AGENTS.md` (repo root; nested `AGENTS.md` merge top-down) | Plain instructions; concatenated per directory. Keep it lean (there's a size cap). |
| **Amp (Sourcegraph)** | `AGENTS.md` (project; user/project/local layers override, not merge) | Same filename convention as Codex — one block works for both. |
| **Cursor** | `.cursor/rules/*.mdc` (Project Rules) | Use frontmatter `alwaysApply: true` (or an `Always` rule) so the memory block is in context on every request. |
| **Cline** | `.clinerules` (file or `.clinerules/` dir) | Cline also has a `memory-bank/` convention — the block belongs in `.clinerules`, separate from project memory-bank files. |
| **Gemini CLI** | `GEMINI.md` (project, sub-dir, or `~/.gemini/GEMINI.md` global) | Loaded wholesale into context — keep it short, which this block already is. |
| **Windsurf (Cascade)** | `.windsurf/rules/` or Workspace Rules | Set the rule's trigger to *Always On* so it's always in context. |

> If your agent isn't listed but supports MCP + a system-instruction/rules file, the same
> two-step works: connect mneme via MCP (§3), paste the block into that file.

---

## 3. Connecting mneme via MCP

Most agents above accept an MCP server entry. The shape is the same everywhere — point
stdio at `mcp-server.mjs`. Example (Claude Code `~/.claude.json` / project `.mcp.json`):

```json
{
  "mcpServers": {
    "mneme": {
      "command": "node",
      "args": ["/absolute/path/to/mneme/mcp-server.mjs"]
    }
  }
}
```

- **Cursor**: `.cursor/mcp.json` with the same `mcpServers` shape.
- **Cline / Windsurf**: add the server in the MCP settings UI (same command + args).
- **Gemini CLI**: `mcpServers` in `~/.gemini/settings.json`.
- **Codex CLI**: `[mcp_servers.mneme]` in `~/.codex/config.toml` (`command` + `args`).

mneme also runs as an HTTP server (`node mcp-server.mjs --transport=http --port=18790`) if
you want one shared instance across several agents instead of a stdio process per agent.

---

## 4. Optional: entity-aware recall (v2.5)

mneme can add a **third recall signal** on top of keyword (FTS5) and vector search: named
entities (projects, people, tools…) mentioned across your memories. A query that names an
entity then also surfaces memories about it, fused via RRF.

**Off by default, fully optional.** Recall works the same (keyword + vector) without it. The
schema upgrades **automatically** — pulling a newer mneme and restarting creates the
`entities` / `mentions` tables (no manual migration; nothing breaks if you never enable it).

To turn it on:

1. Point it at any OpenAI-compatible chat model — used only for **async extraction**, never on
   the recall path. Leave unset and the entity layer stays dormant.
   ```bash
   ENTITY_LLM_API_BASE_URL=https://api.your-provider.com/v1
   ENTITY_LLM_API_KEY=sk-...
   ENTITY_LLM_MODEL=your-chat-model
   ```
2. Backfill entities for existing memories (one-time):
   ```bash
   node index.mjs --extract-entities --limit 100000
   ```
3. Keep new memories covered by scheduling the same command periodically — it only processes
   memories not yet extracted:
   ```bash
   node index.mjs --extract-entities --limit 200   # e.g. nightly cron
   ```

Extraction is async + batched; recall stays pure SQL (zero LLM on the hot path).

---

## 4b. Optional: meta-gate soft vocabularies (v2.6)

The write-gate in `meta-gate.mjs` auto-downgrades `meta_knowledge` stores to
`semi_abstract` when the content has concrete bindings. Two of the bindings —
project names and person names — are *soft*: they only fire if you provide the
vocabulary. The public repo ships **empty** defaults so it carries no team
roster.

Set these env vars anywhere your agent runs mneme to turn on soft matching:

| var | example | meaning |
|-----|---------|---------|
| `MNEME_META_GATE_PROJECT_NAMES` | `MyApp,billing-service,mobile-app` | Comma-separated project/product identifiers |
| `MNEME_META_GATE_PERSON_NAMES` | `alice,bob,carol` | Comma-separated person names (needs ≥ 2 hits to trigger a downgrade) |
| `MNEME_META_GATE_SIGNAL_WORDS` | `cross-project,heuristic` | Overrides the built-in EN+ZH signal-word list that exempts soft matches |

Hard bindings (ISO date, mem-rowid ref, commit hash, absolute path, version
string) always fire without any configuration. Signal words in the first 200
characters of the content can exempt a *soft* binding — never a hard one.

---

## 5. Optional: auto-recall hooks (Claude Code)

The MCP tools are pull-based — the agent decides when to `recall_memory`. Some agents (Claude
Code specifically) also support *hooks* that run before every user prompt and every tool call.
mneme ships two optional hook scripts that push relevant memories back into the conversation
automatically, so the agent sees them without having to remember to ask.

**These are opt-in.** Skip this section if pull-based recall is enough.

Wire them in `~/.claude/settings.json` (or your project's `.claude/settings.json`):

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "node /abs/path/to/mneme/hooks/prompt-recall.mjs",
        "timeout": 5
      }]
    }],
    "PreToolUse": [{
      "matcher": "Bash|Grep|Read|Glob",
      "hooks": [{
        "type": "command",
        "command": "node /abs/path/to/mneme/hooks/tool-recall-pre.mjs",
        "timeout": 5
      }]
    }]
  }
}
```

What they do:

- `prompt-recall.mjs` fires on every user prompt. If the prompt matches an "infrastructure /
  how-to / where-is" trigger and there are ≥ 2 stored hits at `importance ≥ 6`, the top hits
  are injected as `additionalContext` so the agent sees them before answering.
- `tool-recall-pre.mjs` fires before Bash / Grep / Read / Glob calls. It extracts a short
  query from the tool arguments (command head / grep pattern / file basename / glob stem) and
  surfaces any related memories — often letting the agent skip the tool call entirely.

Both hooks are **detection-only**: any error (missing DB, spawn crash, timeout) exits silently
and the prompt/tool call proceeds normally. Session-scoped dedup means the same memory won't
be re-injected within one Claude Code session.

### Environment variables (all optional)

| var | default | meaning |
|-----|---------|---------|
| `MNEME_DB_PATH` | mneme's own `engram.db` | Alias for `TOKENMEM_DB_PATH`; picks the DB file |
| `MNEME_INDEX_PATH` | `<mneme>/index.mjs` | Override the engine entry point |
| `MNEME_MIN_IMPORTANCE` | `6` | Floor for prompt-recall hits |
| `MNEME_LEVEL` | `meta_knowledge` | Prompt-recall level filter |
| `MNEME_LIMIT` | `5` | Prompt-recall candidate cap |
| `MNEME_MIN_CONSENSUS` | `2` | Prompt-recall skip if fewer hits |
| `MNEME_TOOL_MIN_IMPORTANCE` | `6` | Floor for tool-recall hits |
| `MNEME_TOOL_LEVEL` | `meta_knowledge,semi_abstract` | Tool-recall level filter |
| `MNEME_TOOL_LIMIT` | `4` | Tool-recall candidate cap |
| `MNEME_TOOL_QUERY_LEN` | `120` | Max chars of tool arg used as recall query |
| `MNEME_STATE_DIR` | `~/.claude/hooks` | Where session dedup files live |
| `MNEME_TIMEOUT_MS` | `2800` | Spawn timeout for the recall CLI |

### PreToolUse matcher reference

The `matcher` field is a Claude Code hook feature — it decides which tool calls trigger the
hook. A few useful shapes:

```jsonc
// Only Bash — cheapest, catches the most common "I'm about to run a command" moment
{ "matcher": "Bash", "hooks": [ /* ... */ ] }

// Bash + Grep + Read + Glob — the default we recommend; covers file/code exploration too
{ "matcher": "Bash|Grep|Read|Glob", "hooks": [ /* ... */ ] }

// Fire on every tool call, no matter what (rare — usually too noisy)
{ "matcher": ".*", "hooks": [ /* ... */ ] }

// MCP tools — e.g. only fire before your custom MCP server's tools
{ "matcher": "mcp__myserver__.*", "hooks": [ /* ... */ ] }
```

Order in the array matters: hooks with the same matcher run top-to-bottom. If you have
multiple `PreToolUse` hooks (linters, blockers, etc.), put mneme's tool-recall near the top
so its context arrives before anything else adds noise.

### Debugging — optional but recommended

The bundled hooks are silent by design so they don't clutter your terminal. That also makes
them hard to debug when they don't fire. Two lightweight options:

**Option A — quick trace via stderr.** Wrap the hook with a shell one-liner that logs whether
it ran and how long it took:

```jsonc
{
  "type": "command",
  "command": "node /abs/path/to/mneme/hooks/prompt-recall.mjs; echo prompt-recall:$? >&2",
  "timeout": 5
}
```

Claude Code surfaces hook stderr in its own log. `$?` = 0 always (the hooks exit 0 by design),
but seeing the line prove the hook was invoked at all.

**Option B — append a jsonl trace.** Fork `prompt-recall.mjs` and add before every `process.exit(0)`:

```js
import { appendFileSync } from 'node:fs'
try {
  appendFileSync(resolve(HOME, '.claude/hooks/mneme-trace.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), event: 'injected|silent|triggered', sessionId, hits: top?.length ?? 0 }) + '\n')
} catch {}
```

Then `grep '"event":"injected"' ~/.claude/hooks/mneme-trace.jsonl | wc -l` tells you how often
memory actually got surfaced vs how often the hook fired but bailed (dedup / no hits /
below-threshold). No log = no visibility; upstream mneme intentionally leaves this to you so
you can shape the format to whatever downstream analytics you want.

### Troubleshooting

- Hook never injects → check `~/.claude/settings.json` is well-formed and `command` is the
  absolute path. Run the hook manually: `echo '{"prompt":"how do I start the daemon"}' | node hooks/prompt-recall.mjs`
- Silent even when the prompt looks matching → your trigger patterns are English/Chinese
  generic. If your prompts use domain-specific jargon, fork `TRIGGERS` in `prompt-recall.mjs`.
- Wrong DB → set `MNEME_DB_PATH` (or `TOKENMEM_DB_PATH`) to the file you actually want. mneme
  falls back to the `engram.db` beside `index.mjs` if neither is set.
- Injects too often / not enough → tune `MNEME_MIN_IMPORTANCE` and `MNEME_MIN_CONSENSUS`.
  Injecting once but repeatedly across sessions is expected (session dedup is per-session).

---

## 6. Maintenance — consolidation

A mneme that only takes writes drifts into a junk drawer. Every store adds noise;
nothing removes it unless you run a periodic pass. mneme ships primitives for
this out of the box:

- `node index.mjs --health` — a readonly five-scan report (inflation,
  dead-concrete, integrity, blindspot, near-dup). Never mutates.
- `node index.mjs --surface-cold [--days 30] [--min-importance 8]` — the
  high-importance rows nobody's touched in a while. Readonly; the caller
  decides supersede/merge/relabel.
- `node index.mjs --consolidate [--dry-run] [--level-anchor PATH]` — the
  mechanical nightly pipeline: `expireMemories` + `runDecayCycle` +
  `runLevelMigration`, in that order. `--dry-run` previews without writing;
  `--level-anchor` writes a JSONL rollback file before the level migration.

Two-step loop: **surface → apply**. Keep the split. Auto-merging duplicates
based on cosine, or auto-supersede on similarity, silently deletes signal.

Full recipe in [`docs/recipes/nightly-consolidation.md`](recipes/nightly-consolidation.md).

---

## TL;DR

1. Connect mneme via MCP (§3).
2. Paste the §1 block into your agent's instruction file (§2).
3. The rules that matter most: **store is a gate, `semi_abstract` is the default,
   `meta` is earned, importance is a weak prior, supersede instead of rewrite.**
   That's what keeps the memory sharp instead of bloated.
4. Schedule a weekly `--health` review — the store gets sharper only when you
   push back on the drift (§6).
4. Optional: enable the auto-recall hooks (§5) if you're on Claude Code and want memory
   surfaced without asking.
