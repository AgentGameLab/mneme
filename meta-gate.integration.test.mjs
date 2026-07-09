// End-to-end: storeMemory + meta-gate integration
// Run: node meta-gate.integration.test.mjs
import { storeMemory, initMemory } from './index.mjs'

initMemory()

const cases = [
  {
    label: 'meta_with_project_name_should_downgrade',
    mem: {
      content: 'AbyssDatabase v0.2.0 已发布，策划工具落地',
      memoryLevel: 'meta_knowledge',
      memoryType: 'short_term',
      importance: 5,
    },
    expectDowngrade: true,
  },
  {
    label: 'pure_meta_should_stay',
    mem: {
      content: '跨项目通用原则：写记忆时如果绑定具体事件就用 semi，抽象原则才是 meta',
      memoryLevel: 'meta_knowledge',
      memoryType: 'short_term',
      importance: 5,
    },
    expectDowngrade: false,
  },
  {
    label: 'semi_request_untouched',
    mem: {
      content: 'AbyssDatabase v0.2.0 已发布',
      memoryLevel: 'semi_abstract',
      memoryType: 'short_term',
      importance: 5,
    },
    expectDowngrade: false,
  },
]

let pass = 0, fail = 0
for (const c of cases) {
  // 加时间戳避免命中 5-min dedup
  const stamp = Math.floor(Math.random() * 1e6)
  const mem = { ...c.mem, content: c.mem.content + ` [test-marker-${stamp}]` }
  const out = {}
  const id = storeMemory(mem, { out })
  const gotDowngrade = !!out.metaDowngrade
  const ok = gotDowngrade === c.expectDowngrade
  if (ok) pass++
  else fail++
  const flag = ok ? '✓' : '✗'
  console.log(`${flag} [${c.label}] id=${id} downgrade=${gotDowngrade} expect=${c.expectDowngrade}`)
  if (out.metaDowngrade) {
    console.log(`    from=${out.metaDowngrade.fromLevel} to=${out.metaDowngrade.toLevel}`)
    console.log(`    reasons: ${out.metaDowngrade.reasons.join(' | ')}`)
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
