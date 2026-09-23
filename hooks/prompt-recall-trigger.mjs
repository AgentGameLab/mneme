// Single source of truth for the UserPromptSubmit recall population.
// The live hook and its evaluation-set builder both import this module.

const TRIGGERS = [
  // How-to / where-is / operations.
  /\bhow\s+(?:to|do|does|can)\b/i,
  /\bwhere\s+(?:is|are|do|does)\b/i,
  /\bwhat(?:'s| is)\s+the\s+(?:path|port|config|command|key|token|url|endpoint)\b/i,
  /怎么(?:启|跑|运行|开|连|装|配|改|修|登|连接|设置)/,
  /(?:在|放在|位于|装在)哪/,
  /如何(?:启动|运行|配置|连接|登录|使用|安装)/,

  // Memory-system diagnostics often state a symptom instead of using a
  // generic question phrase. Route those explicitly so recall can inspect
  // its own prior evidence.
  /\bmneme\b|个人记忆|长期记忆|跨项目记忆|记忆系统|记忆库|召回|注入/i,

  // Infrastructure / config nouns.
  /\b(?:path|port|token|api[\s_-]?key|env|environment|config|settings?)\b/i,
  /\b(?:daemon|service|process|script|binary|executable)\b/i,
  /\b(?:restart|start|stop|spawn|launch)\b/i,
  /(?:路径|目录|位置|端口|凭证|密钥|环境变量|配置|脚本|工具|命令|启动|重启|守护进程)/,
]

// UserPromptSubmit carries more than what the user typed. In Claude Code,
// background-agent reports arrive as <task-notification>, messages from other
// sessions as <cross-session-message>, and app notices get prepended as
// <system-reminder>. Recalling on the raw prompt means recalling on that
// wrapper text: on one store, 631 of 688 fast-path queries over two weeks were
// wrapper text, and those reports are dense with exactly the infrastructure
// nouns the triggers below look for.
//
// Returns '' when nothing user-authored remains. Known trade-off: a user who
// pastes text that itself starts with one of these tags gets no recall for it.
const NOT_USER_INPUT = /^<(task-notification|cross-session-message)\b/

export function userPromptText(raw) {
  if (!raw || typeof raw !== 'string') return ''
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  // An unterminated block (truncated upstream) would otherwise survive whole
  // and be sent as the query.
  if (NOT_USER_INPUT.test(text) || text.startsWith('<system-reminder')) return ''
  return text
}

export function shouldTriggerPromptRecall(prompt) {
  if (!prompt || prompt.length < 4) return false
  if (prompt.length > 1500) return false
  return TRIGGERS.some((re) => re.test(prompt))
}
