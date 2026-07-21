#!/usr/bin/env node

// Codex stdio -> mneme Streamable HTTP recovery proxy.
//
// Codex Desktop can wedge a long-lived Streamable HTTP MCP session after a
// missing completion event. This proxy keeps Codex on the stdio transport and
// creates a fresh HTTP session for every remote MCP request, so a failed call
// cannot poison later calls. Tool calls are never retried: writes must remain
// at-most-once from the proxy's point of view.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'

// Codes we treat as "transport failure, not a server-authored JSON-RPC error"
// so we flatten them to tool-level isError instead of propagating as JSON-RPC
// errors. Rationale: at-most-once retry policy — codex must be able to tell
// "request never landed / got dropped" apart from "server rejected".
//
// Caveat (not enforced by the SDK): -32000 / -32001 sit inside the JSON-RPC
// spec's "Server error" reserved range (-32099..-32000), which means a
// server is technically free to use them for its own domain errors. As of
// today no mneme server code path emits either — they only originate
// client-side in the MCP SDK (ConnectionClosed on close(), RequestTimeout on
// _setupTimeout). If a future server adopts one of these codes as a domain
// error, this proxy would misclassify it as a transport drop. Revisit this
// set alongside SDK/server version bumps.
const TRANSPORT_ERROR_CODES = new Set([
  ErrorCode.ConnectionClosed,
  ErrorCode.RequestTimeout,
])

function isTransportError(error) {
  return error instanceof McpError && TRANSPORT_ERROR_CODES.has(error.code)
}

const SERVER_URL = process.env.MNEME_HTTP_URL || 'http://127.0.0.1:18792/mcp'
const BEARER_TOKEN = process.env.MNEME_TOKEN_CODEX
const REQUEST_TIMEOUT_MS = positiveInt(process.env.MNEME_PROXY_TIMEOUT_MS, 30_000)
const CLOSE_TIMEOUT_MS = positiveInt(process.env.MNEME_PROXY_CLOSE_TIMEOUT_MS, 2_000)

if (!BEARER_TOKEN) {
  console.error('[mneme-proxy] FATAL: MNEME_TOKEN_CODEX is not set')
  process.exit(2)
}

// Reject any C0 control byte (0x00-0x1f) or DEL (0x7f) in the token. CRLF
// (\r\n) would smuggle a header into on-wire requests or forge new log lines
// on stderr; ESC (\x1b) and other C0 codes can inject ANSI sequences that
// tamper with the operator's terminal when logs are tailed. Everything above
// space is fine for HTTP header values; boot-time failure is cheaper than a
// subtle log/header-injection surface later.
if (/[\x00-\x1f\x7f]/.test(BEARER_TOKEN)) {
  console.error('[mneme-proxy] FATAL: MNEME_TOKEN_CODEX contains control characters')
  process.exit(2)
}

const TOKEN_REDACTION_PATTERNS = [
  new RegExp(escapeRegExp(BEARER_TOKEN), 'g'),
  new RegExp(`Bearer\\s+${escapeRegExp(BEARER_TOKEN)}`, 'g'),
]

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function redact(text) {
  let out = String(text)
  for (const pattern of TOKEN_REDACTION_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]')
  }
  return out
}

// Server-side McpErrors are rethrown into the JSON-RPC error envelope that
// codex sees. If a remote error message or data payload ever contains the
// bearer (e.g. a naive server auth layer echoes the incoming Authorization
// header on a failure), a raw rethrow would leak it. Rebuild the error with
// redacted strings. `data` gets a stringify/redact/parse round-trip so nested
// strings are cleaned; anything not JSON-serialisable is dropped rather than
// risk leaking through toString().
function redactMcpError(error) {
  let data = error.data
  if (data !== undefined && data !== null) {
    try {
      data = JSON.parse(redact(JSON.stringify(data)))
    } catch {
      data = undefined
    }
  }
  return new McpError(error.code, redact(error.message ?? ''), data)
}

let parsedUrl
try {
  parsedUrl = new URL(SERVER_URL)
} catch {
  console.error(`[mneme-proxy] FATAL: invalid MNEME_HTTP_URL: ${SERVER_URL}`)
  process.exit(2)
}

if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
  console.error(`[mneme-proxy] FATAL: unsupported URL protocol: ${parsedUrl.protocol}`)
  process.exit(2)
}

let callSequence = 0

function positiveInt(raw, fallback) {
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function timeout(promise, ms, label) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

function safeError(error) {
  if (error instanceof Error) return redact(`${error.name}: ${error.message}`)
  return redact(String(error))
}

async function closeRemote(client, transport) {
  if (transport.sessionId) {
    await timeout(transport.terminateSession(), CLOSE_TIMEOUT_MS, 'remote session DELETE').catch((error) => {
      console.error(`[mneme-proxy] cleanup warning: ${safeError(error)}`)
    })
  }
  await timeout(client.close(), CLOSE_TIMEOUT_MS, 'remote client close').catch((error) => {
    console.error(`[mneme-proxy] cleanup warning: ${safeError(error)}`)
  })
}

async function withFreshRemote(label, operation) {
  const sequence = ++callSequence
  const startedAt = Date.now()
  const client = new Client(
    { name: 'mneme-codex-stdio-proxy', version: '1.0.0' },
    { capabilities: {} },
  )
  const transport = new StreamableHTTPClientTransport(parsedUrl, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${BEARER_TOKEN}`,
      },
    },
    reconnectionOptions: {
      maxReconnectionDelay: 250,
      initialReconnectionDelay: 50,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 0,
    },
  })

  console.error(`[mneme-proxy] #${sequence} ${label} start`)
  try {
    await client.connect(transport, {
      timeout: REQUEST_TIMEOUT_MS,
      maxTotalTimeout: REQUEST_TIMEOUT_MS,
    })
    const result = await operation(client, {
      timeout: REQUEST_TIMEOUT_MS,
      maxTotalTimeout: REQUEST_TIMEOUT_MS,
    })
    console.error(
      `[mneme-proxy] #${sequence} ${label} ok session=${transport.sessionId?.slice(0, 8) || 'stateless'} elapsed=${Date.now() - startedAt}ms`,
    )
    return result
  } catch (error) {
    console.error(`[mneme-proxy] #${sequence} ${label} failed elapsed=${Date.now() - startedAt}ms: ${safeError(error)}`)
    throw error
  } finally {
    await closeRemote(client, transport)
  }
}

const proxy = new Server(
  { name: 'chinatsu-memory-recovery-proxy', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'Transparent recovery proxy for chinatsu-memory. Every tool call uses a fresh remote HTTP session. Failed calls are not retried automatically.',
  },
)

proxy.setRequestHandler(ListToolsRequestSchema, async (request) => {
  try {
    return await withFreshRemote('tools/list', (client, options) =>
      client.listTools(request.params, options),
    )
  } catch (error) {
    // Server-side JSON-RPC error: preserve code + data so codex can render
    // it correctly instead of a generic Internal Error.
    if (error instanceof McpError && !isTransportError(error)) throw redactMcpError(error)
    throw new McpError(
      ErrorCode.InternalError,
      `mneme proxy: tools/list failed. ${safeError(error)}`,
    )
  }
})

proxy.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name
  try {
    return await withFreshRemote(`tools/call ${toolName}`, (client, options) =>
      client.callTool(request.params, undefined, options),
    )
  } catch (error) {
    // Preserve JSON-RPC error shape when the remote returned a structured
    // error (auth, method-not-found, invalid-params, etc.). Only synthesize
    // a tool-level isError result when the failure is a transport-layer
    // interruption without a JSON-RPC envelope from the server.
    if (error instanceof McpError && !isTransportError(error)) throw redactMcpError(error)
    return {
      content: [{
        type: 'text',
        text: `mneme proxy: remote tool '${toolName}' failed before a response; not retried. ${safeError(error)}`,
      }],
      isError: true,
    }
  }
})

const stdio = new StdioServerTransport()
await proxy.connect(stdio)
console.error(
  `[mneme-proxy] ready stdio -> ${parsedUrl.origin}${parsedUrl.pathname} timeout=${REQUEST_TIMEOUT_MS}ms fresh-session-per-request`,
)

