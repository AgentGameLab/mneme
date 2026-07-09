// Quick self-check for meta-gate. Run: node meta-gate.test.mjs
import { checkMetaGate, applyMetaGate } from './meta-gate.mjs'

const cases = [
  // 应降级：具体项目名
  { content: 'AbyssDatabase v0.2.0 已发布', expect: true, label: 'project+version' },
  // 应降级：ISO 日期
  { content: '2026-05-05 完成 BlueBlob 精修', expect: true, label: 'iso_date+project' },
  // 应降级：memory 引用
  { content: '接续 mem 6008 千夏人格铁律', expect: true, label: 'mem_ref' },
  // 应降级：绝对路径
  { content: '改 E:/Project/chinatsu-workspace/memory/index.mjs 的 storeMemory', expect: true, label: 'abs_path' },
  // 应降级：多个人名
  { content: '小天 + 千夏 讨论了下', expect: true, label: 'multi_person' },
  // 不降级：显式跨项目信号词开头
  { content: '跨项目通用原则：写记忆前先判断"完全无关的项目里还有用吗"', expect: false, label: 'meta_signal_head' },
  // 不降级：纯抽象原则无绑定
  { content: '写代码前先想清楚 API 边界，别 refactor 到一半又变卦', expect: false, label: 'pure_abstract' },
  // 不降级：铁律信号
  { content: '铁律：任何 tool_use 提交前扫一遍 close tag 匹配', expect: false, label: 'meta_signal_teilv' },
  // 应降级：commit hash
  { content: '按 41171eb 那次事故的教训，push 前必须 verify committer', expect: true, label: 'commit_hash' },
  // 边缘：一个人名 → 不降（≥2 才触发）
  { content: '写记忆时不要为了让小天满意而虚报 importance', expect: false, label: 'single_person' },
]

let pass = 0, fail = 0
for (const c of cases) {
  const r = applyMetaGate(c.content, 'meta_knowledge')
  const ok = r.downgraded === c.expect
  if (ok) pass++
  else fail++
  const flag = ok ? '✓' : '✗'
  console.log(`${flag} [${c.label}] downgrade=${r.downgraded} expect=${c.expect}`)
  if (r.reasons.length) console.log(`    reasons: ${r.reasons.join(' | ')}`)
  if (!ok) console.log(`    content: ${c.content}`)
}

// 也测非 meta_knowledge 请求 → 不改
const passThrough = applyMetaGate('AbyssDatabase v0.2.0', 'semi_abstract')
console.log(`\n[pass-through] semi 请求 → level=${passThrough.finalLevel} downgraded=${passThrough.downgraded}`)
if (passThrough.finalLevel !== 'semi_abstract' || passThrough.downgraded) fail++
else pass++

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
