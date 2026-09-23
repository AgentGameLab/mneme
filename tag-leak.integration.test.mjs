// End-to-end: store_memory repairs sibling fields that leaked into content.
//
// The unit test covers the parser; this one covers the wiring — that the MCP
// handler runs the repair before the write on both the normal and the
// quarantine path, that repaired fields (not the zod defaults) are what land
// in the row, that an explicitly passed value survives, and that prose or
// markup is stored untouched.
//
// Run: TOKENMEM_DB_PATH=/tmp/x.db node tag-leak.integration.test.mjs
import { spawn } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const DB_PATH = process.env.TOKENMEM_DB_PATH
if (!DB_PATH) { console.error('FATAL: set TOKENMEM_DB_PATH'); process.exit(2) }
const Q_DB_PATH = DB_PATH.replace(/(\.db)?$/, '-quarantine.db')
for (const p of [DB_PATH, Q_DB_PATH]) for (const sfx of ['', '-shm', '-wal']) if (existsSync(p + sfx)) unlinkSync(p + sfx)

const __dirname = dirname(fileURLToPath(import.meta.url))

let pass = 0, fail = 0
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' — ' + detail : ''}`) }
}

async function withServer(dbPath, extraEnv, fn) {
  const port = 18960 + Math.floor(Math.random() * 30)
  const srv = spawn(process.execPath, [resolve(__dirname, 'mcp-server.mjs'), '--transport=http', `--port=${port}`], {
    env: { ...process.env, TOKENMEM_DB_PATH: dbPath, MNEME_AUTH: 'off', ...extraEnv }, stdio: 'ignore',
  })
  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${port}/health`)).ok } catch {}
      if (!up) await new Promise(r => setTimeout(r, 500))
    }
    if (!up) throw new Error('server did not come up')
    const client = new Client({ name: 'tag-leak-test', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
    const store = async (args) => (await client.callTool({ name: 'store_memory', arguments: args })).content[0].text
    try { await fn(store) } finally { await client.close() }
  } finally {
    srv.kill()
  }
}

const LEAKED = 'body text.</content>\n<parameter name="summary">the summary</parameter>\n<parameter name="importance">9</parameter>\n<parameter name="category">decision</parameter>'
const PROSE = 'A write-up of the bug: the tail looked like `</content><parameter name="summary">…` and then more prose follows.'
const MARKUP = 'An Atom entry for reference:\n<entry>\n  <content>entry body</content>\n  <summary>entry summary</summary>\n</entry>'

try {
  // ── normal path ──
  await withServer(DB_PATH, {}, async (store) => {
    const t1 = await store({ content: LEAKED })
    check('response reports the repair', /close-tag leak repaired: summary, importance, category/.test(t1), t1)
    const t2 = await store({ content: PROSE, summary: 'write-up', importance: 7 })
    check('prose write is not flagged', !/leak/.test(t2), t2)
    await store({ content: MARKUP, summary: 'atom example' })
    await store({ content: 'explicit.</content><parameter name="importance">3</parameter><parameter name="summary">S</parameter>', importance: 10 })
  })
  const db = new Database(DB_PATH, { readonly: true })
  const [a, b, c, d] = db.prepare('SELECT content, summary, importance, category FROM memories ORDER BY rowid').all()
  db.close()
  check('leaked row: content truncated', a.content === 'body text.', a.content)
  check('leaked row: fields restored over zod defaults', a.summary === 'the summary' && a.importance === 9 && a.category === 'decision', JSON.stringify(a))
  check('prose row: stored verbatim', b.content === PROSE && b.summary === 'write-up' && b.importance === 7, JSON.stringify(b))
  check('markup row: stored verbatim', c.content === MARKUP && c.summary === 'atom example', JSON.stringify(c))
  check('explicit importance survives a leaked one', d.importance === 10 && d.summary === 'S' && d.content === 'explicit.', JSON.stringify(d))

  // ── quarantine path: repair runs before the write is routed ──
  await withServer(Q_DB_PATH, { MNEME_QUARANTINE_HOSTS: 'cc', MNEME_DEFAULT_HOST: 'cc', MNEME_PRIMARY_HOST: 'reviewer' }, async (store) => {
    const t = await store({ content: LEAKED })
    check('quarantined write reports the repair', /Quarantined/.test(t) && /close-tag leak repaired/.test(t), t)
  })
  const qdb = new Database(Q_DB_PATH, { readonly: true })
  const q = qdb.prepare('SELECT content, summary, importance, category FROM memories_quarantine ORDER BY qid').get()
  qdb.close()
  check('quarantine row: repaired fields', q?.content === 'body text.' && q.summary === 'the summary' && q.importance === 9 && q.category === 'decision', JSON.stringify(q))
} catch (e) {
  fail++
  console.log(`✗ ${e.message}`)
}

console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed / ${fail} failed`)
process.exitCode = fail ? 1 : 0
