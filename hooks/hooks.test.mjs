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
    prompt: 'how do I start the daemon and where is the port config?',
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

// case 8: Glob with too-short stem — must skip. `*.js` stem "js" (len=2).
{
  const r = runHook(TOOL_HOOK, {
    session_id: 'test-mneme-tool-glob-empty',
    tool_name: 'Glob',
    tool_input: { pattern: '*.js' },
  })
  const v = isValidHookOutput(r.stdout, 'PreToolUse')
  const ok = r.status === 0 && v.silent
  if (ok) pass++; else fail++
  console.log(`${ok?'✓':'✗'} tool-recall Glob short-stem: status=${r.status} silent=${v.silent}`)
}

// case 8b: Glob with short-but-meaningful dir stem — must fire recall.
{
  const r = runHook(TOOL_HOOK, {
    session_id: 'test-mneme-tool-glob-dir',
    tool_name: 'Glob',
    tool_input: { pattern: 'src/**/*.mjs' },
  })
  const v = isValidHookOutput(r.stdout, 'PreToolUse')
  const ok = r.status === 0 && v.ok
  if (ok) pass++; else fail++
  console.log(`${ok?'✓':'✗'} tool-recall Glob dir-stem: status=${r.status} silent=${v.silent}`)
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

// ── which database the fast path answers from ──
//
// The recall request body carries no DB path, so the server answers from
// whichever database it was started with. A hook pinned to one DB that asks a
// server holding another gets the wrong memories — and only when a server
// happens to be up, so it looks like flakiness rather than a wiring bug.
//
// These two cases pin both halves of the rule: a named DB is honoured, and an
// explicitly named URL still wins over it.
{
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const http = await import('node:http')
  const { spawn } = await import('node:child_process')

  const tmp = mkdtempSync(join(tmpdir(), 'mneme-hooks-'))
  const DB = join(tmp, 'pinned.db')

  {
    process.env.TOKENMEM_DB_PATH = DB
    const { initMemory, storeMemory, closeMemory } = await import('../index.mjs')
    initMemory()
    for (const n of [1, 2, 3]) {
      storeMemory({ content: `zzpinmarker rig ${n}: the calibration token and port config live in .env.local`,
        importance: 9, memoryLevel: 'meta_knowledge', memoryType: 'long_term' })
    }
    closeMemory()
    delete process.env.TOKENMEM_DB_PATH
  }

  const PROMPT = 'zzpinmarker calibration 的 token 和端口 配置在哪'
  // async spawn, not spawnSync: the stub below lives in THIS process, and
  // spawnSync blocks this event loop — the stub could never answer, the hook
  // would time out into the CLI, and the test would "prove" the URL is ignored.
  const runAsync = (hookPath, payload, env) => new Promise(res => {
    const ch = spawn(process.execPath, [hookPath], { env: { ...process.env, ...env } })
    let stdout = '', stderr = ''
    ch.stdout.on('data', d => stdout += d)
    ch.stderr.on('data', d => stderr += d)
    ch.on('close', status => res({ status, stdout, stderr }))
    ch.stdin.end(JSON.stringify(payload))
  })

  // case 10: DB named, no URL — must answer from that DB
  {
    const r = await runAsync(PROMPT_HOOK,
      { session_id: 'test-pin-' + Math.random().toString(36).slice(2, 8), prompt: PROMPT },
      { MNEME_DB_PATH: DB, TOKENMEM_DB_PATH: DB, MNEME_STATE_DIR: join(tmp, 's1'), MNEME_HTTP_URL: '' })
    const v = isValidHookOutput(r.stdout, 'UserPromptSubmit')
    const ok = r.status === 0 && v.ok && (v.ctx || '').includes('zzpinmarker')
    if (ok) pass++; else fail++
    console.log(`${ok?'✓':'✗'} pinned DB answers from that DB: status=${r.status} ${v.err || ''}`)
  }

  // case 11: DB named AND URL named — the explicit URL wins
  {
    let sawRequest = false
    const hit = (id, content) => ({ id, content, summary: null, importance: 9,
      memory_level: 'meta_knowledge', memory_type: 'long_term', tags: [], score: 1,
      created_at: Date.now(), recall_sources: [], vec_distance: null })
    const stub = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        sawRequest = true
        res.writeHead(200, { 'Content-Type': 'application/json' })
        // two hits: prompt-recall only injects once it has minConsensus of them
        res.end(JSON.stringify({ hits: [hit(999801, 'ZZSTUBMARKER one'), hit(999802, 'ZZSTUBMARKER two')],
          count: 2, requested_limit: 5, effective_limit: 5, candidate_limit: 30, capped: false, trace_id: null }))
      })
    })
    const port = 18990 + Math.floor(Math.random() * 200)
    await new Promise(r => stub.listen(port, '127.0.0.1', r))

    const r = await runAsync(PROMPT_HOOK,
      { session_id: 'test-pin-url-' + Math.random().toString(36).slice(2, 8), prompt: PROMPT },
      { MNEME_DB_PATH: DB, TOKENMEM_DB_PATH: DB, MNEME_STATE_DIR: join(tmp, 's2'),
        MNEME_HTTP_URL: `http://127.0.0.1:${port}/recall` })
    stub.close()
    const v = isValidHookOutput(r.stdout, 'UserPromptSubmit')
    const ok = r.status === 0 && sawRequest && (v.ctx || '').includes('ZZSTUBMARKER')
    if (ok) pass++; else fail++
    console.log(`${ok?'✓':'✗'} explicit URL wins over a pinned DB: status=${r.status} sawRequest=${sawRequest}`)
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
