#!/usr/bin/env node
// ============================================================
// transcript-sweep.mjs — Claude Code transcript → mneme conversations table
//
// Why this lives in the engine repo:
//   The conversations table, its FTS index, and the recall conversation-fallback
//   have been in place for a while, but nothing was feeding them — the table sat
//   at 0 rows and the verbatim fallback layer effectively did not exist.
//   The reason it stayed broken so long is that the only call site of
//   indexSessionTranscripts() lived in one person's private harness repo, so a
//   fixed engine still reached nobody. Shipping the sweep entry point next to the
//   engine removes that gap: clone mneme and you already have the ingest.
//
// Usage:
//   node scripts/transcript-sweep.mjs
//   (safe to re-run; safe to lose the state file — INSERT OR IGNORE makes a full
//    rescan idempotent, just slower)
//
// Env:
//   MNEME_SWEEP_LOG   log file path (default: <repo>/logs/transcript-sweep.log)
//                     set to "-" to log only to stderr
//
// Schedule it daily. Typical cost after the first backfill is ~1s.
// ============================================================

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG_PATH =
  process.env.MNEME_SWEEP_LOG === '-'
    ? null
    : process.env.MNEME_SWEEP_LOG || resolve(__dirname, '../logs/transcript-sweep.log')

// A failed log write must never take the sweep down — but it must not vanish
// either. The log file is this script's only observable surface under cron, so
// swallowing a permission error would turn the whole sweep into a black box
// that looks idle rather than broken. Complain once on stderr, then stay quiet.
let logWriteBroken = false

const logLine = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  process.stderr.write(line)
  if (!LOG_PATH || logWriteBroken) return
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, line, 'utf-8')
  } catch (e) {
    logWriteBroken = true
    process.stderr.write(
      `[mneme-sweep] WARNING: cannot write log at ${LOG_PATH} (${e.code || e.message}); ` +
        `continuing with stderr only. Set MNEME_SWEEP_LOG to another path, or "-" to silence this.\n`
    )
  }
}

try {
  const mneme = await import('../index.mjs')
  mneme.initMemory()
  const t0 = Date.now()
  const r = mneme.indexSessionTranscripts()
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  logLine(
    `sweep done in ${secs}s: files=${r.totalFiles} rescanned=${r.indexed} ` +
      `skipped=${r.skipped} newMessages=${r.inserted}`
  )
  mneme.closeMemory()
  process.exit(0)
} catch (e) {
  logLine(`sweep FAILED: ${e.message}`)
  process.exit(1)
}
