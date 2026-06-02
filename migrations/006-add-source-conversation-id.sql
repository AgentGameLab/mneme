-- ============================================================
-- Migration 006: source_conversation_id — link a memory to its source conversation
--
-- Borrowed from TencentDB Agent Memory's "full traceability drill-down" principle:
-- an L1 memory (atomic fact) should be able to drill back to the L0 conversation it
-- was formed from — for citation, audit, and verifying the conversation-ingest path
-- didn't drop data.
--
-- Nullable / backward-compatible: legacy rows have NULL. The drill-down helper
-- (getSourceConversation) falls back to a created_at time-window match over the
-- conversations table when the explicit link is absent.
-- ============================================================

-- conversations.rowid the memory was distilled from (NULL = no explicit link)
ALTER TABLE memories ADD COLUMN source_conversation_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_mem_source_conv
  ON memories(source_conversation_id)
  WHERE source_conversation_id IS NOT NULL;

-- Verify:
--   PRAGMA table_info(memories);   -- expect source_conversation_id
--   node index.mjs --source-conv <memory_rowid>
