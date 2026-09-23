// End-to-end: store_memory repairs sibling fields that leaked into content.
//
// The unit test covers the parser; this one covers the wiring — that the MCP
// handler runs the repair before the write, that repaired fields (not the zod
// defaults) are what land in the row, and that prose describing the bug is
// stored untouched.
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
for (const sfx of ['', '-shm', '-wal']) { const p = DB_PATH + sfx; if (existsSync(p)) unlinkSync(p) }

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = 18960 + Math.floor(Math.random() * 30)
const srv = spawn(process.execPath, [resolve(__dirname, 'mcp-server.mjs'), '--transport=http', `--port=${PORT}`], {
  env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH, MNEME_AUTH: 'off' }, stdio: 'ignore',
})

let pass = 0, fail = 0
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' — ' + detail : ''}`) }
}

try {
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok } catch {}
    if (!up) await new Promise(r => setTimeout(r, 500))
  }
  if (!up) throw new Error('server did not come up')

  const client = new Client({ name: 'tag-leak-test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)))

  const leaked = await client.callTool({ name: 'store_memory', arguments: {
    content: 'body text.</content>\n<parameter name="summary">the summary</parameter>\n<parameter name="importance">9</parameter>\n<parameter name="category">decision</parameter>',
  } })
  check('response reports the repair', /close-tag leak repaired: summary, importance, category/.test(leaked.content[0].text), leaked.content[0].text)

  const prose = 'A write-up of the bug: the tail looked like `</content><parameter name="summary">…` and then more prose follows.'
  const clean = await client.callTool({ name: 'store_memory', arguments: { content: prose, summary: 'write-up', importance: 7 } })
  check('prose write is not flagged', !/leak/.test(clean.content[0].text), clean.content[0].text)

  await client.close()

  const db = new Database(DB_PATH, { readonly: true })
  const [a, b] = db.prepare('SELECT content, summary, importance, category FROM memories ORDER BY rowid').all()
  db.close()
  check('leaked row: content truncated', a.content === 'body text.', a.content)
  check('leaked row: fields restored over zod defaults', a.summary === 'the summary' && a.importance === 9 && a.category === 'decision', JSON.stringify(a))
  check('prose row: stored verbatim', b.content === prose && b.summary === 'write-up' && b.importance === 7, JSON.stringify(b))
} catch (e) {
  fail++
  console.log(`✗ ${e.message}`)
} finally {
  srv.kill()
}

console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed / ${fail} failed`)
process.exitCode = fail ? 1 : 0
