-- ============================================================
-- Migration 009 (v2.8): path alias layer — `locations` table
-- ============================================================
-- A companion to the memory store: a KV lookup for "download → E:/download",
-- "godot → E:/tools/godot", etc. Kept out of `memories` deliberately —
-- alias lookup is exact-match semantics and would pollute the RRF ranking
-- if mixed into recall. Consumed by:
--   * CLI: --set-path / --get-path / --list-paths / --delete-path / --import-paths
--   * MCP tools: resolve_path / set_path / list_paths
--   * hooks (tool-recall-pre): exact-match alias front-load before FTS+vec
--
-- Design notes:
--   * `name` is PRIMARY KEY — case-sensitive lookup by intended handle.
--   * `aliases` is a JSON array (SQLite has no JSONB); listing extra names
--     that should also resolve to this path. Lookup is: name = ? first,
--     then a linear scan of anything whose aliases JSON contains the token.
--     Table is expected to stay in the low hundreds of rows, so scan is fine.
--   * `kind` constrains intent: 'dir' (default), 'file', 'glob_root'
--     (a directory you commonly glob starting from), 'executable' (something
--     to spawn), 'url' (docs / dashboards / repos), 'other'.
--   * No soft delete; a location either exists or doesn't. Retire with
--     --delete-path and re-add if you change your mind.
-- ============================================================

CREATE TABLE IF NOT EXISTS locations (
  name TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'dir'
    CHECK (kind IN ('dir', 'file', 'glob_root', 'executable', 'url', 'other')),
  aliases TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_locations_kind ON locations(kind);

-- Verify:
--   PRAGMA table_info(locations);
--   SELECT COUNT(*) FROM locations;
