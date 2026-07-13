# Recipe: Path Alias Layer

Agents that use mneme still spend a surprising amount of time on the same
low-signal task: "where is X on this machine?" — `godot` lives at
`E:/tools/godot`, the download folder is `E:/download`, the workspace is
`~/dev/foo`. That's not a memory question. It's a lookup with a definite
answer, and there's exactly one right answer per handle.

v2.8 adds `locations` — a small KV table next to `memories`, plus a CLI, MCP
tools, and a hook front-load — so short handles resolve to real paths
instantly, without polluting the recall pipeline.

## Why not just store it as a memory?

You could. But every memory lookup runs through FTS + vector + RRF, which is
built for "here are the top-K most relevant candidates for a fuzzy query".
Fuzzy is the wrong contract for `godot → E:/tools/godot`:

- **Precision drops.** Other memories that mention "godot" (yesterday's
  bug, last month's rant, a Skyrim NPC design pattern) crowd the ranking.
- **Latency rises.** Embedding + RRF for something that's a one-hop KV.
- **You can't chain it.** `resolve_path("godot")` returning exactly one
  string composes with shell commands and file tooling; `recall_memory` is
  a paragraph you have to read.

`locations` is the right abstraction: exact-match, cached, definite.

## What's in a location

Every row has:

| column | notes |
|---|---|
| `name` | Primary handle, the thing you'd type ("godot", "download") |
| `path` | Whatever the caller stored — mneme doesn't expand or validate |
| `kind` | `dir` (default) / `file` / `glob_root` / `executable` / `url` / `other` |
| `aliases` | Alternate names for the same row (JSON array) |
| `notes` | Free-form remark — why this exists, what to remember |

`glob_root` marks "this is a directory you commonly glob from"; hooks can
use it to suggest bounded scans instead of walking huge trees. `executable`
distinguishes "spawn this" from "cd into this". `url` lets you keep
dashboard/doc handles in the same table.

## Three surfaces

### 1. CLI

```bash
# Register
node index.mjs --set-path download E:/download --notes "main downloads dir"
node index.mjs --set-path godot E:/tools/godot --alias gd,godot4

# Resolve
node index.mjs --get-path godot            # prints E:/tools/godot to stdout
node index.mjs --get-path gd               # aliases work too
node index.mjs --get-path --format json    # for pipes

# Inspect
node index.mjs --list-paths                # readable table
node index.mjs --list-paths --kind url

# Clean up
node index.mjs --delete-path old-alias

# Bulk register from a JSON file (array or object shape both work)
node index.mjs --import-paths ~/paths.json
node index.mjs --import-paths ~/paths.json --force   # overwrite conflicts
```

Bulk-import file shape (either works):

```jsonc
// Array
[
  { "name": "download", "path": "E:/download", "kind": "dir" },
  { "name": "godot", "path": "E:/tools/godot", "aliases": ["gd", "godot4"] }
]

// Object (name → path or name → object)
{
  "download": "E:/download",
  "godot":    { "path": "E:/tools/godot", "aliases": ["gd", "godot4"] }
}
```

### 2. MCP tools

`resolve_path`, `set_path`, `list_paths`, `delete_path` — an LLM agent can
lookup and register handles the same way it stores memories. Recipe pattern:

- Agent hits an unknown handle in the user's prompt → `resolve_path` first.
- Agent creates a new project → `set_path <project-name> <abs-path>` after
  the first successful build so the location is known for later sessions.
- Agent lists handles when the user asks "what handles do I have registered"
  → `list_paths`.

### 3. Hook front-load

`hooks/tool-recall-pre.mjs` extracts identifier-shaped tokens from
`Bash` / `Read` / `Grep` / `Glob` arguments and checks them against the
registered locations. Hits are prepended to the recall context banner:

```
📍 [mneme locations] 2 known paths in this call — resolve to the registered
path instead of guessing or globbing:
  godot     → E:/tools/godot  [dir]
  download  → E:/download     [dir]
```

The recall runs anyway — the alias tells you WHERE, memory tells you WHY.
The two compose.

Aliases are cached in `MNEME_STATE_DIR/.mneme-locations-cache.json` with a
5-minute TTL (override via `MNEME_ALIAS_CACHE_TTL_MS`). A `--set-path` in a
different session shows up within one TTL.

## When to use `locations` vs `memories`

| Situation | Use |
|---|---|
| "godot on this machine is at X" | `locations` |
| "the workspace is at ~/dev/foo, next to /y" | `locations` |
| "we chose X over Y because Z" | `memories` (decision) |
| "commit ABC broke migration DEF" | `memories` (bug/decision) |
| "the daemon config file is at Z" | `locations` |
| "the daemon config file was moved from Y to Z on 2026-06 because W" | `memories` (history) + `locations` (current path) |

Rule of thumb: **if the answer is a path or URL, use `locations`. If the
answer is a paragraph, use `memories`.** When both apply, register the path
in `locations` and store the explanation as a memory.

## Anti-patterns

- **Mirror everything into locations.** The point is speed and exactness for
  the *high-frequency* handles. Registering 500 rows here doesn't help; the
  hook doesn't magically know which one is relevant.
- **Store secrets as `path`.** The value is written to disk in plain text
  and returned by every `resolve_path` call. Use environment variables for
  credentials.
- **Depend on `path` being valid.** mneme doesn't check that the target
  exists. If you cleaned up `~/tmp/foo` but forgot to delete the alias,
  `resolve_path` still cheerfully returns the stale value. Prune with
  `--delete-path` when you delete the target.

## Bootstrap script

If you want a starter set for a fresh install, drop this into `paths.json`
and `--import-paths` it. It's opinionated — edit to taste:

```jsonc
{
  "home":     "~/",
  "downloads":"~/Downloads",
  "code":     "~/code",
  "tmp":      "~/tmp",
  "notes":    "~/notes"
}
```

Nothing in mneme expands `~` — either write absolute paths, or use your
shell's expansion at set time.

## See also

- [`docs/configuring-your-agent.md`](../configuring-your-agent.md) § 7 —
  the short version of this recipe for the agent instruction file.
- [`memory-health.mjs`](../../memory-health.mjs) — the health scans do not
  cover `locations` (yet). Stale-alias detection is a good future addition.
