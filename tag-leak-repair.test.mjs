// Self-check for tag-leak-repair. Run: node tag-leak-repair.test.mjs
// Leak cases are shaped after real corrupted rows found in a production store.
import { repairTagLeak } from './tag-leak-repair.mjs'

const base = { summary: undefined, importance: 6, category: 'general', tags: [], memory_type: 'long_term', memory_level: 'semi_abstract' }
let fail = 0
const check = (label, cond, detail) => {
  if (!cond) { fail++; console.log(`✗ ${label}`, detail ?? '') } else console.log(`✓ ${label}`)
}

// 1. </content> then an unclosed summary param (most common Aug shape)
{
  const r = repairTagLeak({ ...base, content: '测量工具介入系统就改变了系统。</content> <parameter name="summary">性能测量前须采样空载基线' })
  check('content leak: summary moved out', r.repaired && r.args.summary === '性能测量前须采样空载基线', r)
  check('content leak: content truncated', r.args.content === '测量工具介入系统就改变了系统。', r.args.content)
}

// 2. bare <summary> / <importance> tags (Jun–Aug shape)
{
  const r = repairTagLeak({ ...base, content: '方案是假的。</content> <summary>备份凭据不能只存在被备份的机器上</summary> <importance>8</importance>' })
  check('bare tags: summary + importance', r.args.summary === '备份凭据不能只存在被备份的机器上' && r.args.importance === 8, r.args)
}

// 3. full sibling set with category / tags / level
{
  const content = '正文\n</content>\n<parameter name="summary">S</parameter>\n<parameter name="importance">9</parameter>\n<parameter name="category">decision</parameter>\n<parameter name="tags">["a","b"]</parameter>\n<parameter name="memory_level">meta_knowledge</parameter>'
  const r = repairTagLeak({ ...base, content })
  check('full set: all fields', r.args.content === '正文' && r.args.summary === 'S' && r.args.importance === 9
    && r.args.category === 'decision' && r.args.tags.join() === 'a,b' && r.args.memory_level === 'meta_knowledge', r.args)
}

// 4. summary-side leak (9/21 shape): importance stuck inside summary
{
  const r = repairTagLeak({ ...base, content: '内容无损', summary: '摘要文本</summary><parameter name="importance">7' })
  check('summary leak: importance recovered', r.args.summary === '摘要文本' && r.args.importance === 7 && r.args.content === '内容无损', r.args)
}

// 5. an existing non-empty summary is never overwritten by a leaked one
{
  const r = repairTagLeak({ ...base, summary: '已有摘要', content: 'x</content><parameter name="summary">泄漏摘要</parameter><parameter name="category">bug</parameter>' })
  check('keeps passed summary, takes leaked category', r.args.summary === '已有摘要' && r.args.category === 'bug' && r.args.content === 'x', r.args)
}

// 6. prose that DESCRIBES the bug must pass untouched
for (const [label, content] of [
  ['prose: backticked closer + field', '尾巴上挂着一段 `</content><parameter name="summary">…` 的裸 XML。\n\n## 分类判据\n关键是分清两种'],
  ['prose: closer followed by Chinese', '把结尾 `</parameter>` 手滑成 </content>, 污染其后 importance'],
  ['prose: field tag mid-paragraph then prose', '写 <parameter name="summary"> 时要记得关 tag，然后继续写正文。这里还有更多说明文字。'],
  ['clean content', '普通的一条记忆，没有任何标签。'],
]) {
  const r = repairTagLeak({ ...base, content })
  check(label, !r.repaired && r.args.content === content, r)
}

// 7. invalid enum / out-of-range values are not applied
{
  const r = repairTagLeak({ ...base, content: 'x</content><parameter name="category">nonsense</parameter><parameter name="importance">42</parameter>' })
  check('invalid values ignored', r.repaired && r.args.category === 'general' && r.args.importance === 6 && r.args.content === 'x', r.args)
}

// 8. leak-shaped closer whose tail is prose → suspect, not repaired
{
  const content = '正文</content><parameter name="summary">摘要</parameter> 然后又接了一段正文'
  const r = repairTagLeak({ ...base, content })
  check('unparseable tail → suspect only', !r.repaired && r.suspect && r.args.content === content, r)
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed')
process.exit(fail ? 1 : 0)
