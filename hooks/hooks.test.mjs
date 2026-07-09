// End-to-end sanity test for mneme hooks.
// Run: node hooks.test.mjs
//
// Feeds simulated Claude Code hook payloads via stdin to each hook,
// verifies stdout is either empty (silent pass) or a well-formed
// hookSpecificOutput JSON.

import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROMPT_HOOK = resolve(__dirname, 'prompt-recall.mjs')
const TOOL_HOOK = resolve(__dirname, 'tool-recall-pre.mjs')

function runHook(hookPath, payload) {
  const r = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: 6000,
  })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

function isValidHookOutput(stdout, expectedEvent) {
  if (!stdout.trim()) return { ok: true, silent: true }
  try {
    const j = JSON.parse(stdout)
    if (!j.hookSpecificOutput) return { ok: false, err: 'missing hookSpecificOutput' }
    if (j.hookSpecificOutput.hookEventName !== expectedEvent) {
      return { ok: false, err: `expected event ${expectedEvent}, got ${j.hookSpecificOutput.hookEventName}` }
    }
    if (typeof j.hookSpecificOutput.additionalContext !== 'string') {
      return { ok: false, err: 'additionalContext not string' }
    }
    return { ok: true, silent: false, ctx: j.hookSpecificOutput.additionalContext }
  } catch (e) {
    return { ok: false, err: `json parse: ${e.message}` }
  }
}

let pass = 0, fail = 0

// ── prompt-recall.mjs ──

// case 1: obvious trigger — expect either injection or silent (session dedup)
{
  const r = runHook(PROMPT_HOOK, {
    session_id: 'test-mneme-hooks-' + Math.random().toString(36).slice(2, 8),
    prompt: '怎么启动千夏的 daemon？端口配在哪里？',
  })
  const v = isValidHookOutput(r.stdout, 'UserPromptSubmit')
  const ok = r.status === 0 && v.ok
  if (ok) pass++; else fail++
  console.log(`${ok?'✓':'✗'} prompt-recall trigger: status=${r.status} silent=${v.silent} ${v.err || ''}`)
  if (v.ctx) console.log(`   preview: ${v.ctx.slice(0, 100).replace(/\n/g, ' ')}`)
}

// case 2: no trigger — must silent-exit
{
  const r = runHook(PROMPT_HOOK, {
    session_id: 'test-mneme-hooks-notrigger',
    prompt: '写一首关于秋天的诗',
  })
  const v = isValidHookOutput(r.stdout, 'UserPromptSubmit')
  const ok = r.status === 0 && v.silent
  if (ok) pass++; else fail++
  console.log(`${ok?'✓':'✗'} prompt-recall no-trigger: status=${r.status} silent=${v.silent}`)
}

// case 3: empty payload
{
  const r = runHook(PROMPT_HOOK, {})
  const v = isValidHookOutput(r.stdout, 'UserPromptSubmit')
  const ok = r.status === 0 && v.silent
  if (ok) pass++; else fail++
  console.log(`${ok?'✓':'✗'} prompt-recall empty payload: status=${r.status} silent=${v.silent}`)
}

// case 4: garbage stdin (parser fail path)
{
  const r = spawnSync(process.execPath, [PROMPT_HOOK], {
    input: 'not-json{',
    encoding: 'utf-8',
    timeout: 4000,
  })
  const ok = r.status === 0 && !r.stdout.trim()
  if (ok) pass++; else fail++
  console.log(`${ok?'✓':'✗'} prompt-recall garbage stdin: status=${r.status} stdout=${(r.stdout || '').slice(0, 40)}`)
}

// ── tool-recall-pre.mjs ──

// case 5: Bash call — should recall or silent
{
  const r = runHook(TOOL_HOOK, {
    session_id: 'test-mneme-tool-' + Math.random().toString(36).slice(2, 8),
    tool_name: 'Bash',
    tool_input: { command: 'node scripts/schedule-self-wakeup.mjs --delay 60' },
  })
  const v = isValidHookOutput(r.stdout, 'PreToolUse')
  const ok = r.status === 0 && v.ok
  if (ok) pass++; else fail++
  console.log(`${ok?'✓':'✗'} tool-recall Bash: status=${r.status} silent=${v.silent} ${v.err || ''}`)
  if (v.ctx) console.log(`   preview: ${v.ctx.slice(0, 100).replace(/\n/g, ' ')}`)
}

// case 6: Grep with short pattern
{
  const r = runHook(TOOL_HOOK, {
    session_id: 'test-mneme-tool-grep',
    tool_name: 'Grep',
    tool_input: { pattern: 'daemon watchdog' },
  })
  const v = isValidHookOutput(r.stdout, 'PreToolUse')
  const ok = r.status === 0 && v.ok
  if (ok) pass++; else fail++
  console.log(`${ok?'✓':'✗'} tool-recall Grep: status=${r.status} silent=${v.silent}`)
}

// case 7: Read
{
  const r = runHook(TOOL_HOOK, {
    session_id: 'test-mneme-tool-read',
    tool_name: 'Read',
    tool_input: { file_path: 'mcp-server.mjs' },
  })
  const v = isValidHookOutput(r.stdout, 'PreToolUse')
  const ok = r.status === 0 && v.ok
  if (ok) pass++; else fail++
  console.log(`${ok?'✓':'✗'} tool-recall Read: status=${r.status} silent=${v.silent}`)
}

// case 8: Glob with pure `**/*.ext` — must skip
{
  const r = runHook(TOOL_HOOK, {
    session_id: 'test-mneme-tool-glob-empty',
    tool_name: 'Glob',
    tool_input: { pattern: '**/*.mjs' },
  })
  const v = isValidHookOutput(r.stdout, 'PreToolUse')
  const ok = r.status === 0 && v.silent
  if (ok) pass++; else fail++
  console.log(`${ok?'✓':'✗'} tool-recall Glob pure-pattern: status=${r.status} silent=${v.silent}`)
}

// case 9: unknown tool_name — must skip
{
  const r = runHook(TOOL_HOOK, {
    session_id: 'test-mneme-tool-unknown',
    tool_name: 'MysteryTool',
    tool_input: { anything: 'here' },
  })
  const v = isValidHookOutput(r.stdout, 'PreToolUse')
  const ok = r.status === 0 && v.silent
  if (ok) pass++; else fail++
  console.log(`${ok?'✓':'✗'} tool-recall unknown tool: status=${r.status} silent=${v.silent}`)
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
