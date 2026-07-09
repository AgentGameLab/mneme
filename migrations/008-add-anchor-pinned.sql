-- ============================================================
-- Migration 008: is_anchor / is_pinned (scarcity-as-structure)
-- ============================================================
-- Problem: importance 1-10 弱先验被写入方推高，imp>=8 占 61%，锚点塌方。
-- Ombre-Brain 借鉴：硬配额强制 tradeoff（"你想 pin 更多就得先 unpin 别的"）。
--
-- Semantics:
--   is_anchor=1  → 身份/铁律/永久规约级；配额 <= 40；等同 permanent 语义但独立开关
--   is_pinned=1  → 强 recall 保底；配额 <= 30；比 importance 更强的呈现锚点
--   allow both true — anchor 是 pinned 的超集
--
-- Enforcement:
--   quota check happens in storeMemory (application layer). Migration 只加
--   column + index，配额校验在 storeMemory 里 count + reject/warn。
--
-- Backfill: 所有现存行默认 0（no anchor/pin），存量迁移走独立脚本
-- scripts/anchor-pinned-candidates.mjs → 人工 review 后一键 UPDATE。
-- ============================================================

ALTER TABLE memories ADD COLUMN is_anchor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_mem_anchor
  ON memories(is_anchor)
  WHERE is_anchor = 1 AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mem_pinned
  ON memories(is_pinned)
  WHERE is_pinned = 1 AND deleted_at IS NULL;

-- Verify:
--   PRAGMA table_info(memories);
--   SELECT COUNT(*) FROM memories WHERE is_anchor = 1;
--   SELECT COUNT(*) FROM memories WHERE is_pinned = 1;
