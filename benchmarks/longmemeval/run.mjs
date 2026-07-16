#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aggregateResults, DEFAULT_KS, evaluateRanking } from './metrics.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ENGINE = resolve(__dirname, '..', '..', 'index.mjs')

function flagValues(name) {
  const values = []
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && process.argv[i + 1]) values.push(process.argv[i + 1])
  }
  return values
}

function flag(name, fallback = null) {
  return flagValues(name).at(-1) ?? fallback
}

function hasFlag(name) {
  return process.argv.includes(name)
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = seed + 0x6D2B79F5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

function shuffle(items, seed) {
  const out = items.slice()
  const random = mulberry32(seed)
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export function selectStratified(dataset, perCategory, seed, includeAbstention = false) {
  const groups = new Map()
  for (const item of dataset) {
    if (!includeAbstention && String(item.question_id || '').endsWith('_abs')) continue
    const category = String(item.question_type || 'unknown')
    if (!groups.has(category)) groups.set(category, [])
    groups.get(category).push(item)
  }
  const selected = []
  for (const [category, items] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const categorySeed = [...category].reduce((sum, char) => sum + char.charCodeAt(0), seed)
    selected.push(...shuffle(items, categorySeed).slice(0, perCategory))
  }
  return selected
}

function moduleGraphFingerprint(entryPath) {
  const root = dirname(entryPath)
  const pending = [entryPath]
  const seen = new Set()
  const records = []
  while (pending.length > 0) {
    const path = pending.pop()
    if (seen.has(path) || !existsSync(path)) continue
    seen.add(path)
    const source = readFileSync(path)
    records.push({
      path: relative(root, path).replace(/\\/g, '/'),
      sha256: createHash('sha256').update(source).digest('hex'),
    })
    const text = source.toString('utf-8')
    const pattern = /(?:\b(?:import|export)\s+(?:[^'\"]*?\s+from\s+)?|\bimport\s*\()\s*['\"](\.[^'\"]+)['\"]/g
    for (const match of text.matchAll(pattern)) {
      const dependency = resolve(dirname(path), match[1])
      if (existsSync(dependency)) pending.push(dependency)
    }
  }
  records.sort((a, b) => a.path.localeCompare(b.path))
  const graphSha256 = createHash('sha256')
    .update(records.map(row => `${row.path}\0${row.sha256}`).join('\n'))
    .digest('hex')
  return { moduleGraphSha256: graphSha256, moduleFiles: records }
}

function gitProvenance(path) {
  const git = (...args) => spawnSync('git', ['-C', dirname(path), ...args], {
    encoding: 'utf-8',
    windowsHide: true,
  })
  const head = git('rev-parse', 'HEAD')
  if (head.status !== 0) return { gitHead: null, gitDirty: null }
  const status = git('status', '--porcelain', '--untracked-files=all')
  return {
    gitHead: head.stdout.trim(),
    gitDirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
  }
}

function describeEngine(engine) {
  return { ...engine, ...moduleGraphFingerprint(engine.path), ...gitProvenance(engine.path) }
}

function parseEngines(values) {
  if (values.length === 0) return [describeEngine({ label: 'current', path: DEFAULT_ENGINE })]
  return values.map(value => {
    const split = value.indexOf('=')
    if (split <= 0) throw new Error(`invalid --engine ${value}; expected label=path`)
    const label = value.slice(0, split)
    if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error(`invalid engine label: ${label}`)
    const path = resolve(value.slice(split + 1))
    if (!existsSync(path)) throw new Error(`engine not found: ${path}`)
    return describeEngine({ label, path })
  })
}

function runWorker({ itemPath, dbPath, engine, mode, granularity, limit, queryExpansion, stopwordFiltering, ftsScoring }) {
  const workerPath = resolve(__dirname, 'worker.mjs')
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      workerPath,
      '--case', itemPath,
      '--engine', engine.path,
      '--mode', mode,
      '--granularity', granularity,
      '--limit', String(limit),
      '--query-expansion', queryExpansion,
      '--stopword-filtering', stopwordFiltering,
      '--fts-scoring', ftsScoring,
    ], {
      env: { ...process.env, TOKENMEM_DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`${engine.label}/${basename(itemPath)} exited ${code}: ${stderr.slice(-2000)}`))
        return
      }
      try {
        resolvePromise({ ...JSON.parse(stdout), engine: engine.label, stderr })
      } catch (error) {
        reject(new Error(`${engine.label}/${basename(itemPath)} invalid JSON: ${error.message}\n${stdout.slice(-1000)}`))
      }
    })
  })
}

async function runPool(jobs, concurrency) {
  const results = new Array(jobs.length)
  let cursor = 0
  async function consume() {
    while (cursor < jobs.length) {
      const index = cursor++
      results[index] = await runWorker(jobs[index])
      process.stderr.write(`[${index + 1}/${jobs.length}] ${results[index].engine} ${results[index].questionId}\n`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, consume))
  return results
}

function delta(candidate, baseline) {
  if (!candidate || !baseline) return null
  const out = {}
  for (const key of Object.keys(candidate)) {
    if (key === 'cases') out.cases = candidate.cases
    else if (typeof candidate[key] === 'number' && typeof baseline[key] === 'number') {
      out[key] = candidate[key] - baseline[key]
    }
  }
  return out
}

export async function main() {
  const datasetArg = flag('--dataset')
  if (!datasetArg) throw new Error('pass --dataset PATH to an official LongMemEval JSON file')
  const datasetPath = resolve(datasetArg)
  if (!existsSync(datasetPath)) throw new Error(`dataset not found: ${datasetPath}`)
  const perCategory = positiveInt(flag('--per-category', '3'), 3)
  const seed = positiveInt(flag('--seed', '20260716'), 20260716)
  const limit = Math.min(positiveInt(flag('--limit', '10'), 10), 20)
  const concurrency = positiveInt(flag('--concurrency', '2'), 2)
  const mode = flag('--mode', 'fts')
  if (!['fts', 'hybrid'].includes(mode)) throw new Error('--mode must be fts or hybrid')
  const granularity = flag('--granularity', 'session')
  if (!['session', 'turn'].includes(granularity)) throw new Error('--granularity must be session or turn')
  const queryExpansion = flag('--query-expansion', 'on')
  if (!['on', 'off'].includes(queryExpansion)) throw new Error('--query-expansion must be on or off')
  const stopwordFiltering = flag('--stopword-filtering', 'on')
  if (!['on', 'off'].includes(stopwordFiltering)) throw new Error('--stopword-filtering must be on or off')
  const ftsScoring = flag('--fts-scoring', 'normalized')
  if (!['normalized', 'legacy'].includes(ftsScoring)) throw new Error('--fts-scoring must be normalized or legacy')
  const engines = parseEngines(flagValues('--engine'))
  const keepArtifacts = hasFlag('--keep-artifacts')
  const dataset = JSON.parse(readFileSync(datasetPath, 'utf-8'))
  if (!Array.isArray(dataset)) throw new Error('dataset root must be a JSON array')

  const questionIds = new Set(flagValues('--question-id').flatMap(value => value.split(',')).filter(Boolean))
  const selected = questionIds.size > 0
    ? dataset.filter(item => questionIds.has(String(item.question_id)))
    : selectStratified(dataset, perCategory, seed, hasFlag('--include-abstention'))
  if (selected.length === 0) throw new Error('selection produced zero questions')

  const runDir = mkdtempSync(resolve(tmpdir(), 'mneme-longmemeval-'))
  const jobs = []
  selected.forEach((item, itemIndex) => {
    const itemPath = resolve(runDir, `${itemIndex}.json`)
    writeFileSync(itemPath, JSON.stringify(item), 'utf-8')
    for (const engine of engines) {
      jobs.push({
        itemPath,
        dbPath: resolve(runDir, `${engine.label}-${itemIndex}.db`),
        engine,
        mode,
        granularity,
        limit,
        queryExpansion,
        stopwordFiltering,
        ftsScoring,
      })
    }
  })

  let workerResults
  try {
    workerResults = await runPool(jobs, concurrency)
  } catch (error) {
    if (!keepArtifacts) rmSync(runDir, { recursive: true, force: true })
    else process.stderr.write(`failed artifacts kept at ${runDir}\n`)
    throw error
  }

  for (const row of workerResults) {
    row.metrics = evaluateRanking(
      row.retrieved.map(result => result.sessionId),
      row.answerSessionIds,
      DEFAULT_KS,
    )
  }

  const summaries = {}
  for (const engine of engines) {
    summaries[engine.label] = aggregateResults(workerResults.filter(row => row.engine === engine.label))
  }
  const baseline = engines[0].label
  const deltas = {}
  for (const engine of engines.slice(1)) {
    deltas[engine.label] = {
      baseline,
      overall: delta(summaries[engine.label].overall, summaries[baseline].overall),
    }
  }

  const report = {
    protocol: 'LongMemEval session-level retrieval; abstention excluded by default',
    dataset: datasetPath,
    selection: {
      seed,
      perCategory,
      includeAbstention: hasFlag('--include-abstention'),
      questions: selected.length,
      categories: [...new Set(selected.map(item => item.question_type))].sort(),
    },
    retrieval: { mode, granularity, limit, queryExpansion, stopwordFiltering, ftsScoring, ks: DEFAULT_KS },
    engines,
    summaries,
    deltas,
    cases: workerResults.map(({ stderr, ...row }) => row),
  }

  const output = flag('--output')
    ? resolve(flag('--output'))
    : resolve(__dirname, 'results', `retrieval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  try {
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, JSON.stringify(report, null, 2), 'utf-8')
  } catch (error) {
    if (!keepArtifacts) rmSync(runDir, { recursive: true, force: true })
    else process.stderr.write(`failed artifacts kept at ${runDir}\n`)
    throw error
  }
  process.stdout.write(`${JSON.stringify({ output, summaries, deltas }, null, 2)}\n`)
  if (!keepArtifacts) rmSync(runDir, { recursive: true, force: true })
  else process.stderr.write(`artifacts kept at ${runDir}\n`)
  return report
}

const isMain = process.argv[1] && isAbsolute(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`)
    process.exit(1)
  })
}
