#!/usr/bin/env node
// ============================================================
// hooks/session-sediment.mjs — mneme Stop-hook auto-sediment reflex
// ============================================================
// The WRITE-side counterpart to prompt-recall / tool-recall-pre (both READ).
// Problem it solves: sedimenting a learning to KOS is 100% manual today
// (store_memory / kos-remember). Busy sessions ship code but never write the
// gotcha/decision/technique down → team info-asymmetry accumulates
// (see XiaQiuQiu_Office team-memory/findings/kos-sediment-gap-audit-2026-07-11.md).
//
// This hook turns "remember to sediment" into "get nudged by default": at
// session end, if the session did SUBSTANTIVE work (commits carrying
// gotcha/fix/decision markers) but sedimented NOTHING (no team-memory commit),
// it blocks the stop ONCE with a reminder listing what happened. The agent
// then decides to kos-remember / write a finding, or dismiss. Human-in-loop,
// candidate-not-auto-promote — same philosophy as write-gate + kos-draft-digest.
//
// Wire it in ~/.claude/settings.json:
//
//   {
//     "hooks": {
//       "Stop": [{
//         "hooks": [{
//           "type": "command",
//           "command": "node /abs/path/to/mneme/hooks/session-sediment.mjs",
//           "timeout": 6
//         }]
//       }]
//     }
//   }
//
// Configuration (all optional — sensible defaults):
//   MNEME_SEDIMENT_WINDOW_MIN   commit lookback window in minutes (default: 45)
//   MNEME_SEDIMENT_KOS_GLOB     path prefix that counts as "sedimented"
//                               (default: team-memory/)
//   MNEME_SEDIMENT_MARKERS      extra regex alternation appended to marker set
//   MNEME_STATE_DIR             session-dedup file dir (default: ~/.claude/hooks)
//   MNEME_SEDIMENT_DISABLE      set to "1" to no-op (kill switch)
//
// Design notes (mirrors prompt-recall.mjs):
//   - DETECTION ONLY. Any error (not a git repo, spawn crash, no commits)
//     exits 0 silently — never traps a session.
//   - Blocks AT MOST ONCE per session_id (dedup state file). Second Stop in
//     the same session passes through.
//   - `stop_hook_active` guard: never re-fires inside its own block loop.
//   - Only nudges on the REAL gap shape: work-with-markers AND zero KOS
//     sediment this window. Pure-sediment sessions and routine sessions pass.

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOME = process.env.USERPROFILE || process.env.HOME || __dirname

function intEnv(name, fallback) {
  const v = parseInt(process.env[name] || '', 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}

const CFG = {
  windowMin: intEnv('MNEME_SEDIMENT_WINDOW_MIN', 45),
  kosGlob: process.env.MNEME_SEDIMENT_KOS_GLOB || 'team-memory/',
  stateDir: process.env.MNEME_STATE_DIR || resolve(HOME, '.claude', 'hooks'),
  timeoutMs: 4000,
}

// Sediment-worthy markers: things that carry a reusable lesson, not routine.
const BASE_MARKERS =
  'fix|root.?cause|gotcha|hardening|blocker|retract|diagnos|debug|postmortem|' +
  'workaround|pitfall|根因|踩坑|坑|突破|攻克|决策|技法|复发|教训'
const MARKER_RE = new RegExp(
  process.env.MNEME_SEDIMENT_MARKERS
    ? `${BASE_MARKERS}|${process.env.MNEME_SEDIMENT_MARKERS}`
    : BASE_MARKERS,
  'i',
)
// Routine commits never count as substantive work.
const ROUTINE_RE =
  /\[auto-evolve\]|\[skip-|snapshot|chore\(kos\)|derive|auto-detect|chronicle|daily 20\d\d|wide-scan|domain-research|refresh/i

function git(cwd, args) {
  try {
    const r = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      timeout: CFG.timeoutMs,
      windowsHide: true,
    })
    if (r.status !== 0) return null
    return r.stdout || ''
  } catch {
    return null
  }
}

// session-dedup: block at most once per session_id
function alreadyNudged(sessionId) {
  const f = resolve(CFG.stateDir, `sediment-${sessionId}.done`)
  return existsSync(f)
}
function markNudged(sessionId) {
  try {
    if (!existsSync(CFG.stateDir)) mkdirSync(CFG.stateDir, { recursive: true })
    const f = resolve(CFG.stateDir, `sediment-${sessionId}.done`)
    const tmp = `${f}.${process.pid}.tmp`
    writeFileSync(tmp, String(Date.now()))
    renameSync(tmp, f)
  } catch {
    /* best effort */
  }
}

let input = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', d => (input += d))
process.stdin.on('end', () => {
  if (process.env.MNEME_SEDIMENT_DISABLE === '1') process.exit(0)

  let payload = {}
  try {
    payload = JSON.parse(input || '{}')
  } catch {
    process.exit(0)
  }

  // Never re-fire inside our own block loop.
  if (payload.stop_hook_active) process.exit(0)

  const sessionId = payload.session_id || payload.sessionId || 'unknown'
  if (alreadyNudged(sessionId)) process.exit(0)

  const cwd = payload.cwd || process.cwd()
  const root = (git(cwd, ['rev-parse', '--show-toplevel']) || '').trim()
  if (!root) process.exit(0) // not a git repo → nothing to detect

  const since = `${CFG.windowMin} minutes ago`
  // Substantive commits this window (subject line), excluding routine.
  const log = git(root, ['log', `--since=${since}`, '--no-merges', '--pretty=%h%x1f%s'])
  if (log == null) process.exit(0)

  const commits = log
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [h, s] = l.split('\x1f')
      return { h, s: s || '' }
    })
  const substantive = commits.filter(c => MARKER_RE.test(c.s) && !ROUTINE_RE.test(c.s))
  if (substantive.length === 0) process.exit(0) // no reusable-lesson work → no nudge

  // Did anything get sedimented to KOS this window? (any commit touching kosGlob)
  const kosTouch = git(root, [
    'log',
    `--since=${since}`,
    '--pretty=%h',
    '--',
    CFG.kosGlob,
  ])
  const sedimented = (kosTouch || '').split('\n').filter(Boolean).length > 0
  if (sedimented) process.exit(0) // work AND sediment both happened → discipline held

  // GAP shape: substantive work, zero KOS sediment. Nudge once.
  markNudged(sessionId)
  const list = substantive.slice(0, 5).map(c => `  • ${c.h} ${c.s.slice(0, 72)}`).join('\n')
  const reason =
    `🧠 [沉淀反射] 本 session 有 ${substantive.length} 个带经验标记的 commit，但没往 KOS（${CFG.kosGlob}）沉淀任何东西：\n` +
    `${list}\n\n` +
    `其中有可复用的 gotcha / 决策 / 技法吗？值得就现在 sediment（kos-remember 或写一条 team-memory finding/playbook/rule），` +
    `不必升 verified、draft 即可（走 write-gate + kos-draft-digest 人审）。纯属产品迭代/一次性调参就忽略本提示，结束即可。`

  process.stdout.write(JSON.stringify({ decision: 'block', reason }))
  process.exit(0)
})

// Safety net: if stdin never closes, still exit within the parent's timeout window.
setTimeout(() => process.exit(0), CFG.timeoutMs + 200).unref()
