import test from 'node:test'
import assert from 'node:assert/strict'

import { shouldTriggerPromptRecall } from './prompt-recall-trigger.mjs'

test('memory diagnostics reach the live prompt hook', () => {
  assert.equal(
    shouldTriggerPromptRecall('正好测试下KOS和Mneme和memory现在的召回和注入逻辑，之前尤其是KOS的recall一直欠佳'),
    true,
  )
  assert.equal(shouldTriggerPromptRecall('mneme recall 一直欠佳，排查一下'), true)
  assert.equal(shouldTriggerPromptRecall('跨项目记忆为什么没有注入'), true)
})

test('short steering and long pasted text stay outside the gate', () => {
  assert.equal(shouldTriggerPromptRecall('推进'), false)
  assert.equal(shouldTriggerPromptRecall('召回'.repeat(751)), false)
})
