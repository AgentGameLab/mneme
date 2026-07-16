import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

function getFlag(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

function eventTime(dateText) {
  const match = String(dateText || '').match(/(\d{4})[/-](\d{2})[/-](\d{2}).*?(\d{2}):(\d{2})/)
  if (!match) return null
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]))
}

function renderSession(turns, dateText) {
  const body = turns.map(turn => {
    const role = turn?.role === 'assistant' ? 'assistant' : 'user'
    return `${role}: ${String(turn?.content || '')}`
  }).join('\n')
  return `Session date: ${dateText || 'unknown'}\n${body}`
}

const casePath = getFlag('--case')
const enginePath = getFlag('--engine')
const mode = getFlag('--mode') || 'fts'
const granularity = getFlag('--granularity') || 'session'
const requestedLimit = Number.parseInt(getFlag('--limit') || '10', 10)
const queryExpansion = getFlag('--query-expansion') || 'on'
const stopwordFiltering = getFlag('--stopword-filtering') || 'on'
const ftsScoring = getFlag('--fts-scoring') || 'normalized'
if (!casePath || !enginePath || !process.env.TOKENMEM_DB_PATH) {
  process.stderr.write('worker requires --case, --engine, and TOKENMEM_DB_PATH\n')
  process.exit(2)
}

if (mode === 'fts') {
  delete process.env.EMBEDDING_API_BASE_URL
  delete process.env.EMBEDDING_API_KEY
  delete process.env.EMBEDDING_MODEL
  delete process.env.EMBEDDING_DIMENSION
}

const item = JSON.parse(readFileSync(casePath, 'utf-8'))
const engine = await import(pathToFileURL(enginePath).href)
engine.initMemory()

const sessions = item.haystack_sessions || []
const dates = item.haystack_dates || []
const sessionIds = item.haystack_session_ids || []
const count = Math.min(sessions.length, dates.length, sessionIds.length)
const rowidToSession = new Map()
const startedAt = Date.now()
let storedMemories = 0

for (let i = 0; i < count; i++) {
  const values = granularity === 'turn'
    ? sessions[i]
        .map((turn, turnIndex) => ({ turn, turnIndex }))
        .filter(({ turn }) => turn?.role === 'user')
        .map(({ turn, turnIndex }) => ({
          content: `Session date: ${dates[i] || 'unknown'}\nuser: ${String(turn.content || '')}`,
          turnIndex,
        }))
    : [{ content: renderSession(sessions[i], dates[i]), turnIndex: null }]

  for (const value of values) {
    const mem = {
      content: value.content,
      summary: null,
      memoryType: 'long_term',
      memoryLevel: 'concrete_trace',
      category: 'general',
      importance: 5,
      source: 'extraction',
      sourceId: String(sessionIds[i]),
      sourcePlatform: 'longmemeval',
      tags: ['longmemeval', String(item.question_type || 'unknown')],
      metadata: {
        question_id: item.question_id,
        session_index: i,
        turn_index: value.turnIndex,
        session_date: dates[i],
      },
      eventTime: eventTime(dates[i]),
    }
    const rowid = mode === 'hybrid' && typeof engine.storeMemoryAsync === 'function'
      ? await engine.storeMemoryAsync(mem)
      : engine.storeMemory(mem)
    if (rowid) {
      rowidToSession.set(String(rowid), String(sessionIds[i]))
      storedMemories++
    }
  }
}

const recallLimit = granularity === 'turn' ? 20 : requestedLimit
const recallOptions = {
  query: item.question,
  limit: recallLimit,
  minImportance: 1,
  _noQueryExpansion: queryExpansion === 'off',
  _noStopwordFiltering: stopwordFiltering === 'off',
  _legacyFtsScoring: ftsScoring === 'legacy',
}
const recalled = typeof engine.recallMemoriesHybrid === 'function'
  ? await engine.recallMemoriesHybrid(recallOptions)
  : engine.recallMemories(recallOptions)

const retrieved = []
const seenSessions = new Set()
for (const row of recalled) {
  const sessionId = String(row.source_id || rowidToSession.get(String(row.rowid)) || '')
  if (!sessionId || seenSessions.has(sessionId)) continue
  seenSessions.add(sessionId)
  retrieved.push({
    rank: retrieved.length + 1,
    sourceRank: recalled.indexOf(row) + 1,
    rowid: String(row.rowid),
    sessionId,
    score: Number(row.score || 0),
    sources: Array.isArray(row.recall_sources) ? row.recall_sources : [],
    eventTime: row.event_time ?? null,
    preview: String(row.content || '').slice(0, 300),
  })
  if (retrieved.length >= requestedLimit) break
}

const result = {
  questionId: String(item.question_id || 'unknown'),
  questionType: String(item.question_type || 'unknown'),
  question: String(item.question || ''),
  answerSessionIds: (item.answer_session_ids || []).map(String),
  retrieved,
  ingestion: {
    sessions: count,
    memories: storedMemories,
    mode,
    granularity,
    durationMs: Date.now() - startedAt,
  },
  traceId: recalled.recallTrace?.traceId || null,
  traceMode: recalled.recallTrace?.mode || null,
}

engine.closeMemory()
process.stdout.write(JSON.stringify(result))
