-- ============================================================
-- Migration 004: store-time dedup + event_time
-- Two mechanisms that complement v2.1's memory hygiene work:
--   1. content_hash + 5-min window dedup -- prevents thrash from agents that
--      retry-store the same content within a short window. Existing record's
--      access_count gets incremented instead, so the "I told you this already"
--      signal is preserved without bloating the table.
--   2. event_time -- the time the event actually happened, distinct from
--      created_at (the time it was recorded). Lets recall do temporal
--      reasoning: "what did I do last June?" can match event_time even when
--      the memory was recorded today.
--
-- Both columns are nullable / backward-compatible:
--   - content_hash NULL on legacy rows -> they don't dedup against anything,
--     but new stores still get hashed and dedup'd among themselves.
--   - event_time NULL -> recall falls back to created_at (existing behavior).
-- ============================================================

-- 1. content_hash -- sha256(content) first 16 hex chars; populated at store time
ALTER TABLE memories ADD COLUMN content_hash TEXT;

-- 2. event_time -- ms timestamp when the event actually happened; nullable
ALTER TABLE memories ADD COLUMN event_time INTEGER;

-- 3. Index for dedup lookup (hash + recency window)
--    Partial index: only active (non-deleted) rows; dedup never matches deleted ones
CREATE INDEX IF NOT EXISTS idx_mem_content_hash
  ON memories(content_hash, created_at DESC)
  WHERE content_hash IS NOT NULL AND deleted_at IS NULL;

-- 4. Index for event_time temporal queries / sorting
CREATE INDEX IF NOT EXISTS idx_mem_event_time
  ON memories(event_time DESC)
  WHERE event_time IS NOT NULL AND deleted_at IS NULL;

-- Verify:
--   PRAGMA table_info(memories);
--   SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_mem_content_hash','idx_mem_event_time');
