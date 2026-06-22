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

## TL;DR

1. Connect mneme via MCP (§3).
2. Paste the §1 block into your agent's instruction file (§2).
3. The rules that matter most: **store is a gate, `semi_abstract` is the default,
   `meta` is earned, importance is a weak prior, supersede instead of rewrite.**
   That's what keeps the memory sharp instead of bloated.
