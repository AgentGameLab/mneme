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

// Soft-binding vocabularies are project-specific. Ship empty defaults and let
// the caller supply their own via env vars — a public mneme install shouldn't
// carry any team's roster or roadmap in its regex.
//
//   MNEME_META_GATE_PROJECT_NAMES  comma-separated project/product identifiers
//   MNEME_META_GATE_PERSON_NAMES   comma-separated person names
//   MNEME_META_GATE_SIGNAL_WORDS   comma-separated "this really is cross-project" cues
//                                  (defaults to a small EN+ZH set below)
//
// Empty vocabularies simply mean soft bindings never fire — hard bindings
// (dates, mem refs, hashes, paths, versions) still work out of the box.
function parseCsvEnv(name) {
  const raw = process.env[name]
  if (!raw) return []
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

const PROJECT_NAMES = parseCsvEnv('MNEME_META_GATE_PROJECT_NAMES')
const PERSON_NAMES = parseCsvEnv('MNEME_META_GATE_PERSON_NAMES')

const DEFAULT_SIGNAL_WORDS = [
  'cross-project', 'cross-context', 'cross-session',
  'heuristic', 'pattern', 'meta-rule',
  '跨项目', '跨场景', '跨领域', '普适', '通用原则', '通用模式', '任何项目', '铁律',
]
const META_SIGNAL_WORDS = (() => {
  const custom = parseCsvEnv('MNEME_META_GATE_SIGNAL_WORDS')
  return custom.length > 0 ? custom : DEFAULT_SIGNAL_WORDS
})()

// Hard bindings: structural references to specific things. Signal-word
// exemption does NOT apply here — a memory that names a real commit hash
// is bound to that commit even if the caller wrote "cross-project" up top.
const HARD_BINDINGS = [
  { name: 'iso_date', re: /\b20\d{2}-\d{2}-\d{2}\b/, hint: 'ISO date binds to a specific event' },
  { name: 'mem_ref', re: /(?:\bmem[\s_]*|\[id[\s:_-]*|\bid[\s:_-]*)\d{2,6}\b/i, hint: 'references a specific memory rowid' },
  { name: 'version', re: /\bv\d+\.\d+(?:\.\d+)?\b/, hint: 'specific version string' },
  // Commit hashes have to include at least one letter [a-f] — pure-digit
  // strings like "8080000" or "port 1234567" would otherwise match.
  { name: 'commit_hash', re: /\b(?=[a-f0-9]*[a-f])[a-f0-9]{7,40}\b/, hint: 'specific commit hash' },
  // Absolute paths — Windows drive-letter form OR POSIX-style `/`-rooted paths
  // with at least two segments (avoids matching a lone `/` sentence separator).
  { name: 'abs_path', re: /(?:(?:^|[\s`'"(])[A-Za-z]:[\/\\][A-Za-z0-9_\-\.\/\\]{3,}|(?:^|[\s`'"(])\/(?:[A-Za-z0-9_\-\.]+\/){1,}[A-Za-z0-9_\-\.]+)/, hint: 'specific absolute path' },
  { name: 'port_host', re: /:\d{2,5}\/|https?:\/\/[a-z0-9\.\-]+\.[a-z]{2,}/i, hint: 'specific port or host' },
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
