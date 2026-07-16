-- Migration 010: bounded recall audit trail.
-- Stores counts, decisions, and kept rowids only. Raw memory content and raw
-- queries are deliberately excluded; query_hash supports correlation without
-- copying personal text into a second persistence surface.

CREATE TABLE IF NOT EXISTS recall_traces (
  trace_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  mode TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  query_chars INTEGER NOT NULL,
  requested_limit INTEGER NOT NULL,
  effective_limit INTEGER NOT NULL,
  candidate_limit INTEGER NOT NULL,
  kept_ids TEXT NOT NULL DEFAULT '[]',
  steps TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recall_traces_started
  ON recall_traces(started_at DESC);
