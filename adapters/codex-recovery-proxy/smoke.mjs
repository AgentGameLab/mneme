import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const token = process.env.MNEME_TOKEN_CODEX
if (!token) {
  console.error('FATAL: MNEME_TOKEN_CODEX is not set')
  process.exit(2)
}

const proxyPath = fileURLToPath(new URL('./proxy.mjs', import.meta.url))
const remoteUrl = process.env.MNEME_HTTP_URL || 'http://127.0.0.1:18792/mcp'
const healthUrl = new URL('/health', remoteUrl)

async function health() {
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) })
  assert.equal(response.ok, true, `health returned HTTP ${response.status}`)
  return response.json()
}

const before = await health()
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [proxyPath],
  env: {
    ...process.env,
    MNEME_HTTP_URL: remoteUrl,
    MNEME_TOKEN_CODEX: token,
    MNEME_PROXY_TIMEOUT_MS: process.env.MNEME_PROXY_TIMEOUT_MS || '10000',
  },
  stderr: 'pipe',
})
const client = new Client({ name: 'mneme-proxy-real-smoke', version: '1.0.0' })

try {
  await client.connect(transport)
  const listed = await client.listTools()
  const names = new Set(listed.tools.map((tool) => tool.name))
  for (const expected of ['recall_memory', 'store_memory', 'recall_by_id', 'memory_stats']) {
    assert.equal(names.has(expected), true, `missing tool: ${expected}`)
  }

  const first = await client.callTool({ name: 'memory_stats', arguments: {} })
  assert.notEqual(first.isError, true)
  assert.match(first.content?.[0]?.text || '', /Total memories|total/i)

  const second = await client.callTool({ name: 'memory_stats', arguments: {} })
  assert.notEqual(second.isError, true)
  assert.match(second.content?.[0]?.text || '', /Total memories|total/i)
} finally {
  await client.close().catch(() => {})
}

await new Promise((resolve) => setTimeout(resolve, 100))
const after = await health()
assert.equal(
  after.active_sessions,
  before.active_sessions,
  `proxy leaked remote sessions: ${before.active_sessions} -> ${after.active_sessions}`,
)

console.log(
  `PASS: real mneme through stdio proxy; active_sessions ${before.active_sessions} -> ${after.active_sessions}`,
)

