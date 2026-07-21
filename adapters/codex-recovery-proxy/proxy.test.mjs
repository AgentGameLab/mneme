import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const proxyPath = fileURLToPath(new URL('./proxy.mjs', import.meta.url))
const token = 'test-codex-token'
const sessions = new Map()
const sessionIds = []
let toolCalls = 0

const missingToken = spawnSync(process.execPath, [proxyPath], {
  encoding: 'utf8',
  env: { ...process.env, MNEME_TOKEN_CODEX: '' },
})
assert.equal(missingToken.status, 2)
assert.match(missingToken.stderr, /MNEME_TOKEN_CODEX is not set/)

function createRemoteServer() {
  const server = new McpServer({ name: 'fake-mneme', version: '1.0.0' })
  server.tool('echo', 'Echo a value', { value: z.string() }, async ({ value }) => {
    toolCalls++
    return { content: [{ type: 'text', text: value }] }
  })
  server.tool('hang', 'Hang past the proxy timeout', {}, async () => {
    toolCalls++
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    return { content: [{ type: 'text', text: 'late response' }] }
  })
  return server
}

const remote = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401)
    res.end('Unauthorized')
    return
  }

  const sessionId = req.headers['mcp-session-id']
  let entry = sessionId ? sessions.get(sessionId) : null
  if (!entry && req.method !== 'DELETE') {
    const server = createRemoteServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => `session-${sessionIds.length + 1}`,
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport })
        sessionIds.push(id)
      },
      onsessionclosed: (id) => sessions.delete(id),
    })
    await server.connect(transport)
    entry = { server, transport }
  }

  if (!entry) {
    res.writeHead(404)
    res.end('Unknown session')
    return
  }
  await entry.transport.handleRequest(req, res)
})

remote.listen(0, '127.0.0.1')
await once(remote, 'listening')
const { port } = remote.address()

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [proxyPath],
  env: {
    ...process.env,
    MNEME_HTTP_URL: `http://127.0.0.1:${port}/mcp`,
    MNEME_TOKEN_CODEX: token,
    MNEME_PROXY_TIMEOUT_MS: '300',
    MNEME_PROXY_CLOSE_TIMEOUT_MS: '500',
  },
  stderr: 'pipe',
})
const client = new Client({ name: 'proxy-test', version: '1.0.0' })

try {
  await client.connect(transport)

  const listed = await client.listTools()
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['echo', 'hang'])

  const first = await client.callTool({ name: 'echo', arguments: { value: 'one' } })
  assert.equal(first.content[0].text, 'one')

  const failed = await client.callTool({ name: 'hang', arguments: {} })
  assert.equal(failed.isError, true)
  assert.match(failed.content[0].text, /not retried/)

  const second = await client.callTool({ name: 'echo', arguments: { value: 'two' } })
  assert.equal(second.content[0].text, 'two')

  for (let i = 0; i < 48; i++) {
    const result = await client.callTool({ name: 'echo', arguments: { value: `sequential-${i}` } })
    assert.equal(result.content[0].text, `sequential-${i}`)
  }

  const concurrent = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      client.callTool({ name: 'echo', arguments: { value: `concurrent-${i}` } }),
    ),
  )
  concurrent.forEach((result, i) => assert.equal(result.content[0].text, `concurrent-${i}`))

  assert.equal(toolCalls, 59, 'failed calls must not be retried')
  assert.equal(new Set(sessionIds).size, 60, 'tools/list and each tool call must use a fresh session')
  assert.equal(sessions.size, 0, 'proxy must DELETE every completed remote session')

  console.log(`PASS: fresh sessions=${sessionIds.length}, calls=${toolCalls}, live sessions=${sessions.size}`)
} finally {
  await client.close().catch(() => {})
  remote.close()
  await once(remote, 'close')
}

// Scenario 1 (connect-leg hang): a remote that accepts TCP + reads the request
// but never writes anything. Exercises the initialize/connect() timeout path.
// `withFreshRemote` runs client.connect() before operation(), so under this
// server it's the initialize POST that stalls, not a subsequent tool call.
// This covers "mneme is fully down / hard-network-hung" — proxy must fail
// fast enough for codex to move on rather than wedge.
const hanging = http.createServer((req, res) => {
  // Consume the request body then hold the socket open. Do not respond.
  req.on('data', () => {})
  req.on('end', () => {})
  // Never call res.end(); rely on the client timeout, not server keepalive.
})
hanging.listen(0, '127.0.0.1')
await once(hanging, 'listening')
const hangingPort = hanging.address().port
const heldSockets = new Set()
hanging.on('connection', (socket) => {
  heldSockets.add(socket)
  socket.on('close', () => heldSockets.delete(socket))
})

const hangingTransport = new StdioClientTransport({
  command: process.execPath,
  args: [proxyPath],
  env: {
    ...process.env,
    MNEME_HTTP_URL: `http://127.0.0.1:${hangingPort}/mcp`,
    MNEME_TOKEN_CODEX: token,
    MNEME_PROXY_TIMEOUT_MS: '400',
    MNEME_PROXY_CLOSE_TIMEOUT_MS: '400',
  },
  stderr: 'pipe',
})
const hangingClient = new Client({ name: 'proxy-test-hang', version: '1.0.0' })

try {
  const clientTimeoutMs = 3_000
  const startedAt = Date.now()
  let listError = null
  try {
    await hangingClient.connect(hangingTransport, { timeout: clientTimeoutMs })
    await hangingClient.listTools(undefined, { timeout: clientTimeoutMs })
  } catch (error) {
    listError = error
  }
  const elapsed = Date.now() - startedAt

  assert.ok(listError, 'hanging remote must surface an error, not hang')
  assert.ok(
    elapsed < clientTimeoutMs,
    `proxy must fail within its own timeout window (elapsed=${elapsed}ms, ceiling=${clientTimeoutMs}ms)`,
  )
  console.log(`PASS: hanging remote surfaced error in ${elapsed}ms (<${clientTimeoutMs}ms ceiling)`)
} finally {
  await hangingClient.close().catch(() => {})
  for (const socket of heldSockets) socket.destroy()
  hanging.close()
  await once(hanging, 'close')
}

// Scenario 2 (post-init hang): a remote that answers initialize normally then
// stalls every subsequent JSON-RPC *request* on that session. Notifications
// (no `id`) are ack'd immediately so the SDK's initialized-notification path
// doesn't itself hang and confuse the test. DELETE is ack'd so the proxy's
// terminateSession() cleanup doesn't dominate the elapsed measurement.
//
// This is the shape of the upstream codex#32470 wedge — session establishes
// fine, a later call gets stuck. Scenario 1 only covered the connect() leg;
// without this scenario the tools/list / tools/call timeout path is unproven
// for the exact failure mode this adapter exists to work around.
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const initOkThenHangSessions = new Set()
let initOkThenHangSessionCount = 0
const initOkThenHang = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401)
    res.end('Unauthorized')
    return
  }

  const sessionId = req.headers['mcp-session-id']

  if (req.method === 'DELETE' && sessionId && initOkThenHangSessions.has(sessionId)) {
    initOkThenHangSessions.delete(sessionId)
    res.writeHead(200)
    res.end()
    return
  }

  if (req.method === 'POST') {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      res.writeHead(400)
      res.end('Bad JSON')
      return
    }

    // Initialize (no session yet): mint a fresh session id and answer with a
    // minimal handshake so the proxy's connect() completes.
    if (!sessionId && body?.method === 'initialize') {
      const newSessionId = `init-hang-${++initOkThenHangSessionCount}`
      initOkThenHangSessions.add(newSessionId)
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Mcp-Session-Id', newSessionId)
      res.writeHead(200)
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: body.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'init-ok-then-hang', version: '1.0.0' },
        },
      }))
      return
    }

    // Notifications (no `id`) get an immediate 202 so `initialized` etc.
    // don't sit on the socket waiting for a response that never comes.
    if (sessionId && initOkThenHangSessions.has(sessionId) && body?.id == null) {
      res.writeHead(202)
      res.end()
      return
    }

    // Any JSON-RPC *request* on a live session (this is what the proxy sends
    // for tools/list and tools/call): hold the socket forever.
    if (sessionId && initOkThenHangSessions.has(sessionId)) {
      // Never call res.end(). The proxy's timeout must be what surfaces
      // the failure.
      return
    }
  }

  res.writeHead(404)
  res.end('Unknown')
})
initOkThenHang.listen(0, '127.0.0.1')
await once(initOkThenHang, 'listening')
const initOkThenHangPort = initOkThenHang.address().port
const initOkThenHangSockets = new Set()
initOkThenHang.on('connection', (socket) => {
  initOkThenHangSockets.add(socket)
  socket.on('close', () => initOkThenHangSockets.delete(socket))
})

const initOkThenHangTransport = new StdioClientTransport({
  command: process.execPath,
  args: [proxyPath],
  env: {
    ...process.env,
    MNEME_HTTP_URL: `http://127.0.0.1:${initOkThenHangPort}/mcp`,
    MNEME_TOKEN_CODEX: token,
    MNEME_PROXY_TIMEOUT_MS: '400',
    MNEME_PROXY_CLOSE_TIMEOUT_MS: '400',
  },
  stderr: 'pipe',
})
const initOkThenHangClient = new Client({ name: 'proxy-test-init-then-hang', version: '1.0.0' })

try {
  const clientTimeoutMs = 3_000
  await initOkThenHangClient.connect(initOkThenHangTransport, { timeout: clientTimeoutMs })
  // Drain proxy stderr onto our own stderr so a slow-proxy regression is
  // debuggable straight from CI logs instead of needing a repro run.
  initOkThenHangTransport.stderr?.on('data', (chunk) => {
    process.stderr.write(`[proxy-stderr] ${chunk}`)
  })

  const startedAt = Date.now()
  let listError = null
  try {
    await initOkThenHangClient.listTools(undefined, { timeout: clientTimeoutMs })
  } catch (error) {
    listError = error
  }
  const elapsed = Date.now() - startedAt

  assert.ok(listError, 'post-init hang must surface an error, not hang')
  assert.ok(
    elapsed < clientTimeoutMs,
    `proxy tools/list must fail within its own timeout window (elapsed=${elapsed}ms, ceiling=${clientTimeoutMs}ms)`,
  )
  assert.ok(
    initOkThenHangSessionCount >= 1,
    `remote must have established at least one session (got ${initOkThenHangSessionCount})`,
  )
  console.log(
    `PASS: post-init hang surfaced error in ${elapsed}ms (<${clientTimeoutMs}ms ceiling, sessions established=${initOkThenHangSessionCount})`,
  )
} finally {
  await initOkThenHangClient.close().catch(() => {})
  for (const socket of initOkThenHangSockets) socket.destroy()
  initOkThenHang.close()
  await once(initOkThenHang, 'close')
}
