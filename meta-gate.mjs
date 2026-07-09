// ============================================================
// meta-gate.mjs — meta_knowledge write-time downgrade gate
// ============================================================
// Problem: default 改成 semi_abstract 后写入方仍显式传 meta_knowledge，
// 库里 meta 占比长期 71%。CLAUDE.md 里"完全无关的项目里还有用吗"这条判据
// 靠人自律没压住。此文件把判据机器化：
//   - content 里含具体项目名 / ISO 日期 / memory 引用 / 版本号 / 具体路径
//     → 认为"跨项目失效" → auto-降级 meta_knowledge → semi_abstract
//   - 例外：显式跨项目信号词（"跨项目 / 跨场景 / 普适 / 通用原则 / heuristic"）
//     出现在 content 前 200 char → 放行（判定 caller 已自觉抽象）
//
// DETECTION ONLY — 只降级不 reject，防止破坏调用方语义（跟 near-dup gate 同哲学）。
// 降级信号通过 return { downgraded, reasons[] } 返回给上层展示。

const PROJECT_NAMES = [
  // 千夏 workspace 核心项目
  'AbyssDatabase', 'XiaQiuQiu', 'ClawGamers', 'Clawgamers',
  'Ombre-Brain', 'Ombre Brain', 'tentacle', '触手',
  'GAI Protocol', 'GAI protocol',
  '太空杀', '镇魂街', '虾球球', '虾球Town', '虾斗士',
  '银发经济', 'elderly-service',
  'Hermes', 'hermes', 'Ariel', 'ariel',
  'OpenClaw', 'openclaw', 'EntroCamp',
  'Spine', 'BlueBlob',
  'AaIT',
  'T5', 'T1',
  '飞书 Daemon', 'daemon v4', 'town-a2a-daemon',
  'chinatsu-memory', 'chinatsu-workspace',
  'engram', 'tokenmem',
  'kos-remember', 'KOS MCP',
]

const PERSON_NAMES = [
  '小天', '岸天', '千夏', '爱芮', '小梦', 'A梦', '阿伦', 'luxi',
  'MXAntian', 'tianzimyq',
]

const META_SIGNAL_WORDS = [
  '跨项目', '跨场景', '跨领域', '普适', '通用原则', '通用模式',
  '任何项目', 'cross-project', 'cross-context', 'cross-session',
  'heuristic', 'pattern', 'meta-rule', '铁律',
]

// 硬绑定：结构化引用具体事物，signal-word 豁免不适用
const HARD_BINDINGS = [
  { name: 'iso_date', re: /\b20\d{2}-\d{2}-\d{2}\b/, hint: 'ISO 日期锁定具体事件' },
  { name: 'mem_ref', re: /(?:\bmem[\s_]*|\[id[\s:_-]*|\bid[\s:_-]*)\d{2,6}\b/i, hint: '引用具体 memory rowid' },
  { name: 'version', re: /\bv\d+\.\d+(?:\.\d+)?\b/, hint: '具体版本号' },
  { name: 'commit_hash', re: /\b[a-f0-9]{7,40}\b/, hint: '具体 commit hash' },
  { name: 'abs_path', re: /(?:^|[\s`'"(])[A-Za-z]:[\/\\][A-Za-z0-9_\-\.\/\\]{3,}/, hint: '具体绝对路径' },
  { name: 'port_host', re: /:\d{2,5}\/|https?:\/\/[a-z0-9\.\-]+\.[a-z]{2,}/i, hint: '具体端口/host' },
]

/**
 * Check if content should be downgraded from meta_knowledge -> semi_abstract.
 * @param {string} content - memory content to inspect
 * @param {object} opts - optional { skipSignalWords: false }
 * @returns {{ downgrade: boolean, reasons: string[] }}
 */
export function checkMetaGate(content, opts = {}) {
  if (typeof content !== 'string' || content.length === 0) {
    return { downgrade: false, reasons: [] }
  }

  const reasons = []

  // 硬绑定：结构化引用，signal-word 豁免不适用
  for (const { name, re, hint } of HARD_BINDINGS) {
    const m = content.match(re)
    if (m) reasons.push(`${name}:${hint} (matched="${m[0].slice(0, 24)}")`)
  }
  const hardHit = reasons.length > 0

  // 软绑定：项目名 / 多人名 — 可被 head-200 meta-signal 豁免
  const softReasons = []
  const projectHits = PROJECT_NAMES.filter(n => content.includes(n))
  if (projectHits.length > 0) {
    softReasons.push(`project_names:${projectHits.slice(0, 3).join(',')}`)
  }
  const personHits = PERSON_NAMES.filter(n => content.includes(n))
  if (personHits.length >= 2) {
    softReasons.push(`person_names(${personHits.length}):${personHits.slice(0, 3).join(',')}`)
  }

  if (hardHit) return { downgrade: true, reasons }

  if (softReasons.length === 0) return { downgrade: false, reasons: [] }

  if (!opts.skipSignalWords) {
    const head = content.slice(0, 200)
    for (const w of META_SIGNAL_WORDS) {
      if (head.includes(w)) {
        return { downgrade: false, reasons: [`meta-signal:"${w}" in head-200 override soft-binding`] }
      }
    }
  }

  return { downgrade: true, reasons: softReasons }
}

/**
 * Apply gate to a memory before insert. If caller wanted meta_knowledge but
 * content is bound, coerce level and return the reasons for logging.
 * @param {string} content
 * @param {string} requestedLevel
 * @returns {{ finalLevel: string, downgraded: boolean, reasons: string[] }}
 */
export function applyMetaGate(content, requestedLevel) {
  if (requestedLevel !== 'meta_knowledge') {
    return { finalLevel: requestedLevel, downgraded: false, reasons: [] }
  }
  const check = checkMetaGate(content)
  if (!check.downgrade) {
    return { finalLevel: 'meta_knowledge', downgraded: false, reasons: check.reasons }
  }
  return { finalLevel: 'semi_abstract', downgraded: true, reasons: check.reasons }
}
