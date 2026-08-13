import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import {
  basename,
  delimiter as pathDelimiter,
  dirname,
  extname,
  join,
  resolve,
} from 'node:path'

const MAX_QUERY_CHARS = 500
const MAX_RESULTS = 20
const DEFAULT_RESULTS = 8
const MAX_FILES = 5_000
const MAX_FILE_BYTES = 1024 * 1024
const MAX_PREVIEW_CHARS = 1_200

function unquoteScalar(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed.at(-1)
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function splitFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/)
  if (!match) return { fields: {}, body: raw }

  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (/^\s/.test(line)) continue
    const field = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!field) continue
    fields[field[1]] = unquoteScalar(field[2])
  }

  return { fields, body: match[2] }
}

export function parseClaudeMemory(raw, { filePath, project } = {}) {
  if (typeof raw !== 'string' || raw.includes('\uFFFD')) return null

  const { fields, body } = splitFrontmatter(raw)
  const fileName = basename(filePath || 'memory.md')
  const fallbackName = fileName.slice(0, fileName.length - extname(fileName).length)

  return {
    project: project || '',
    name: fields.name || fallbackName,
    description: fields.description || '',
    type: fields.type || '',
    body,
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function normalizeExistingDirectories(paths) {
  const unique = new Map()
  for (const value of paths) {
    if (typeof value !== 'string' || !value.trim()) continue
    const absolute = resolve(value.trim())
    if (!isDirectory(absolute)) continue
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
    if (!unique.has(key)) unique.set(key, absolute)
  }
  return [...unique.values()].sort()
}

export function resolveClaudeMemoryDirs({
  env = process.env,
  home = env.USERPROFILE || env.HOME,
  projectsRoot,
  memoryDirs,
} = {}) {
  if (Array.isArray(memoryDirs)) {
    return normalizeExistingDirectories(memoryDirs)
  }

  const override = env.MNEME_CLAUDE_MEMORY_DIRS
  if (typeof override === 'string' && override.trim()) {
    return normalizeExistingDirectories(override.split(pathDelimiter))
  }

  const root = projectsRoot || (home ? join(home, '.claude', 'projects') : '')
  if (!root || !isDirectory(root)) return []

  try {
    const candidates = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(root, entry.name, 'memory'))
    return normalizeExistingDirectories(candidates)
  } catch {
    return []
  }
}

function safeSlice(value, maxChars) {
  return [...value].slice(0, maxChars).join('')
}

function normalizeSearchText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('und')
}

function searchTokens(value) {
  const normalized = normalizeSearchText(value)
  const tokens = new Set()
  for (const match of normalized.matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu)) {
    const segment = match[0]
    if (/^\p{Script=Han}+$/u.test(segment)) {
      const chars = [...segment]
      for (const char of chars) tokens.add(char)
      for (let i = 0; i + 1 < chars.length; i++) tokens.add(chars[i] + chars[i + 1])
    } else {
      tokens.add(segment)
    }
  }
  return [...tokens]
}

function scoreCandidate(candidate, query, tokens) {
  const name = normalizeSearchText(`${candidate.fileStem} ${candidate.name}`)
  const description = normalizeSearchText(candidate.description)
  const body = normalizeSearchText(candidate.body)
  let score = 0

  for (const token of tokens) {
    if (name.includes(token)) score += 8
    if (description.includes(token)) score += 5
    if (body.includes(token)) score += 1
  }

  const phrase = normalizeSearchText(query)
  if (phrase && `${name}\n${description}\n${body}`.includes(phrase)) score += 12
  return score
}

function boundedLimit(value) {
  const numeric = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : DEFAULT_RESULTS
  return Math.min(MAX_RESULTS, Math.max(1, numeric))
}

function publicHit(candidate) {
  return {
    project: candidate.project,
    name: candidate.name,
    description: candidate.description,
    type: candidate.type,
    path: candidate.path,
    modified_at: candidate.modified_at,
    score: candidate.score,
    preview: safeSlice(candidate.body, MAX_PREVIEW_CHARS),
  }
}

export function recallClaudeMarkdownMemory({
  query,
  limit = DEFAULT_RESULTS,
  project,
  memoryDirs,
  env,
  home,
  projectsRoot,
} = {}) {
  const boundedQuery = safeSlice(String(query || '').trim(), MAX_QUERY_CHARS)
  const tokens = searchTokens(boundedQuery)
  const empty = { hits: [], scanned_files: 0, skipped_files: 0, capped: false }
  if (!boundedQuery || tokens.length === 0) return empty

  const directories = resolveClaudeMemoryDirs({ memoryDirs, env, home, projectsRoot })
  const requestedProject = project ? normalizeSearchText(project.trim()) : ''
  const byContentHash = new Map()
  let scannedFiles = 0
  let skippedFiles = 0
  let capped = false

  scanDirectories:
  for (const memoryDir of directories) {
    const projectName = basename(dirname(memoryDir))
    if (requestedProject && normalizeSearchText(projectName) !== requestedProject) continue

    let entries
    try {
      entries = readdirSync(memoryDir, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .filter(entry => extname(entry.name).toLowerCase() === '.md')
        .filter(entry => entry.name.toLowerCase() !== 'memory.md')
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      continue
    }

    for (const entry of entries) {
      if (scannedFiles >= MAX_FILES) {
        capped = true
        break scanDirectories
      }
      scannedFiles++

      const filePath = resolve(memoryDir, entry.name)
      let stat
      let raw
      try {
        stat = statSync(filePath)
        if (stat.size > MAX_FILE_BYTES) {
          skippedFiles++
          continue
        }
        raw = readFileSync(filePath, 'utf8')
      } catch {
        skippedFiles++
        continue
      }

      const parsed = parseClaudeMemory(raw, { filePath, project: projectName })
      if (!parsed) {
        skippedFiles++
        continue
      }

      const candidate = {
        ...parsed,
        fileStem: basename(filePath, extname(filePath)),
        path: filePath,
        modified_at: new Date(stat.mtimeMs).toISOString(),
        mtimeMs: stat.mtimeMs,
      }
      candidate.score = scoreCandidate(candidate, boundedQuery, tokens)
      if (candidate.score === 0) continue

      const hash = createHash('sha256').update(raw).digest('hex')
      const existing = byContentHash.get(hash)
      if (!existing || candidate.mtimeMs > existing.mtimeMs
        || (candidate.mtimeMs === existing.mtimeMs && candidate.path < existing.path)) {
        byContentHash.set(hash, candidate)
      }
    }
  }

  const hits = [...byContentHash.values()]
    .sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
    .slice(0, boundedLimit(limit))
    .map(publicHit)

  return {
    hits,
    scanned_files: scannedFiles,
    skipped_files: skippedFiles,
    capped,
  }
}
