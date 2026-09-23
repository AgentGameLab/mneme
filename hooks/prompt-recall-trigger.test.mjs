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

test('only user-authored text reaches the trigger and the query', async () => {
  const { userPromptText } = await import('./prompt-recall-trigger.mjs')
  // App notice prepended to a real prompt: the notice goes, the prompt stays.
  assert.equal(
    userPromptText('<system-reminder>\nThe user started background task X ("fix daemon restart")\n</system-reminder>\nwhy is recall noisy'),
    'why is recall noisy',
  )
  // Background-agent reports and other sessions' messages are not user input,
  // even though they are full of the nouns the triggers look for.
  assert.equal(userPromptText('<task-notification>\n<result>daemon config path port restart</result>\n</task-notification>'), '')
  assert.equal(userPromptText('<cross-session-message from="x">where is the config</cross-session-message>'), '')
  assert.equal(shouldTriggerPromptRecall(userPromptText('<task-notification>how to restart the daemon</task-notification>')), false)
  // Plain prompts pass through untouched.
  assert.equal(userPromptText('  how to restart the daemon '), 'how to restart the daemon')
  assert.equal(userPromptText(undefined), '')
})
