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

// 4b. tail ending in the tool-call envelope closer (most summary-side rows)
{
  const r = repairTagLeak({ ...base, content: '正文', summary: '摘要</summary>\n<importance>9</importance>\n<category>project</category>\n<tags>["a","b"]</tags>\n</invoke>' })
  check('envelope closer at the end', r.repaired && r.args.summary === '摘要' && r.args.importance === 9 && r.args.category === 'project' && r.args.tags.join() === 'a,b', r.args)
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

// 7. nothing valid recovered → no truncation, flagged suspect
{
  const content = 'x</content><parameter name="category">nonsense</parameter><parameter name="importance">42</parameter>'
  const r = repairTagLeak({ ...base, content })
  check('invalid values only → untouched + suspect', !r.repaired && r.suspect && r.args.content === content && r.args.importance === 6, r)
}

// 8. leak-shaped closer whose tail is prose → suspect, not repaired
{
  const content = '正文</content><parameter name="summary">摘要</parameter> 然后又接了一段正文'
  const r = repairTagLeak({ ...base, content })
  check('unparseable tail → suspect only', !r.repaired && r.suspect && r.args.content === content, r)
}

// 9. markup that happens to use field-named elements is not a leak
for (const [label, content] of [
  ['atom entry with wrapper', 'Atom feed 示例：\n<entry>\n  <content>正文内容</content>\n  <summary>摘要内容</summary>\n</entry>'],
  ['atom elements at the very end', 'Atom 里正文和摘要这样写：\n<content>正文内容</content>\n<summary>摘要内容</summary>'],
  ['jsx-ish', '组件结构：<Foo>\n<content>bar</content>\n<tags>x</tags>\n</Foo>'],
  ['html with invalid enum', '这是页面结构：\n<div>\n  <content>正文</content>\n  <category>news</category>\n</div>'],
]) {
  const r = repairTagLeak({ ...base, content })
  check(`markup: ${label}`, !r.repaired && r.args.content === content && r.args.summary === undefined, r)
}

// 10. an explicitly passed non-default value is never overridden
{
  const r = repairTagLeak({ ...base, importance: 10, category: 'decision', content: '示例正文</content><parameter name="importance">3</parameter><parameter name="category">bug</parameter><parameter name="summary">S</parameter>' })
  check('explicit importance/category kept', r.args.importance === 10 && r.args.category === 'decision' && r.args.summary === 'S' && r.args.content === '示例正文', r.args)
}

// 11. leak consumes the whole field → nothing left, don't store a blank row
{
  const content = '</content><parameter name="summary">S</parameter>'
  const r = repairTagLeak({ ...base, content })
  check('empty head → untouched + suspect', !r.repaired && r.suspect && r.args.content === content, r)
}

// 12. content and summary both leak the same field → content side wins
{
  const r = repairTagLeak({ ...base, content: 'c</content><parameter name="importance">3</parameter>', summary: 's</summary><parameter name="importance">8' })
  check('content-side value wins on conflict', r.args.importance === 3 && r.args.summary === 's' && r.args.content === 'c', r.args)
}

// 13. remaining fields: memory_type / supersedes / event_time / is_anchor
{
  const r = repairTagLeak({ ...base, content: 'x</content><parameter name="memory_type">permanent</parameter><parameter name="supersedes">["12","34"]</parameter><parameter name="event_time">2026-01-02</parameter><parameter name="is_anchor">true</parameter>' })
  check('other fields recovered', r.args.memory_type === 'permanent' && r.args.supersedes.join() === '12,34' && r.args.event_time === '2026-01-02' && r.args.is_anchor === true, r.args)
}

// 14. long repetitive near-leak stays linear
{
  const content = 'Z</content>' + '<parameter name="summary">Y</parameter>'.repeat(8000) + '\u0000POISON'
  const t0 = Date.now()
  const r = repairTagLeak({ ...base, content })
  const ms = Date.now() - t0
  check(`${Math.round(content.length / 1000)}KB adversarial input in ${ms}ms (< 500)`, ms < 500 && !r.repaired, { ms, repaired: r.repaired })
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed')
process.exit(fail ? 1 : 0)
