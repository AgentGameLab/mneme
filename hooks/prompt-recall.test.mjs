import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

async function runRecall(t, hits, prompt = '看下为何耗这么多token') {
  const stateDir = mkdtempSync(join(tmpdir(), 'mneme-relevance-'))
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ hits }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.close(); rmSync(stateDir, { recursive: true, force: true }) })
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./prompt-recall.mjs', import.meta.url))], {
      env: { ...process.env, MNEME_HTTP_URL: `http://127.0.0.1:${server.address().port}/recall`, MNEME_STATE_DIR: stateDir },
      timeout: 5000,
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => stdout += data)
    child.stderr.on('data', data => stderr += data)
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) { reject(new Error(`hook exited ${code}: ${stderr}`)); return }
      resolve(stdout)
    })
    child.stdin.end(JSON.stringify({ session_id: 'relevance-test', prompt }))
  })
}

const hit = (id, content, extra = {}) => ({ id, content, importance: 8, ...extra })

test('several unrelated search hits are not relevance evidence', async t => {
  const stdout = await runRecall(t, [
    hit(101, '分段视频切点要留悬念，不在论述收尾处断开'),
    hit(102, '波动区间很大的量应明确表达不确定性'),
    hit(103, '视频片尾和音乐衔接不顺畅，要检查转场'),
  ])
  assert.equal(stdout, '')
})

test('one directly relevant hit survives without a count heuristic', async t => {
  const stdout = await runRecall(t, [hit(1, 'Codex token 消耗由长上下文和重复轮询放大')])
  assert.match(stdout, /\[id:1 /)
})

test('filter individual hits, including weak vector matches', async t => {
  const stdout = await runRecall(t, [
    hit(1, 'Codex token 消耗由长上下文和重复轮询放大', { vec_distance: 0.4 }),
    hit(2, '片尾剪辑要丝滑', { vec_distance: 0.9 }),
  ])
  assert.match(stdout, /\[id:1 /)
  assert.doesNotMatch(stdout, /\[id:2 /)
})

test('CJK topics and tag-only evidence remain recallable', async t => {
  const stdout = await runRecall(t, [hit(3, '正文说明', { tags: ['端口'] })], '端口配置在哪')
  assert.match(stdout, /\[id:3 /)
})
