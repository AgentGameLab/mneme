import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('health reports the package version', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mneme-version-'))
  const port = 19000 + Math.floor(Math.random() * 1000)
  const child = spawn(process.execPath, ['mcp-server.mjs', '--transport=http', `--port=${port}`], {
    cwd: import.meta.dirname,
    env: { ...process.env, TOKENMEM_DB_PATH: join(root, 'test.db') },
    stdio: 'ignore',
  })
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill()
      await once(child, 'exit')
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  let health
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) {
        health = await response.json()
        break
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(health, 'test server did not become healthy')

  const packageJson = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  assert.equal(health.version, packageJson.version)
})
