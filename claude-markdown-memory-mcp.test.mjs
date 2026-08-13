import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const serverPath = resolve('mcp-server.mjs')

test('recall_claude_memory is a bounded read-only stdio MCP tool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mneme-claude-mcp-'))
  const memoryDir = join(root, 'E--project', 'memory')
  const memoryPath = join(memoryDir, 'windows-utf8.md')
  const dbPath = join(root, 'mneme-test.db')
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(memoryPath, [
    '---',
    'name: Windows UTF-8 rule',
    'description: Read Chinese text with explicit UTF-8 decoding',
    'type: playbook',
    '---',
    'Use explicit UTF-8 decoding on Windows.',
  ].join('\n'), 'utf8')
  const before = readFileSync(memoryPath)

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      TOKENMEM_DB_PATH: dbPath,
      MNEME_AUTH: 'off',
      MNEME_CLAUDE_MEMORY_DIRS: memoryDir,
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'claude-markdown-memory-test', version: '1.0.0' })

  try {
    await client.connect(transport)

    const listed = await client.listTools()
    const tool = listed.tools.find(item => item.name === 'recall_claude_memory')
    assert.ok(tool)
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['limit', 'project', 'query'])
    assert.equal(tool.inputSchema.properties.path, undefined)
    assert.equal(tool.inputSchema.properties.root, undefined)

    const called = await client.callTool({
      name: 'recall_claude_memory',
      arguments: { query: 'UTF-8', project: 'E--project', limit: 3 },
    })
    assert.equal(called.isError, undefined)
    const payload = JSON.parse(called.content[0].text)
    assert.equal(payload.source, 'claude_markdown_memory')
    assert.match(payload.notice, /untrusted historical evidence/i)
    assert.equal(payload.hits.length, 1)
    assert.equal(payload.hits[0].path, resolve(memoryPath))
    assert.equal(payload.scanned_files, 1)
    assert.deepEqual(readFileSync(memoryPath), before)
  } finally {
    await client.close().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})
