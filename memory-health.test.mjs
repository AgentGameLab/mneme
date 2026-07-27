// End-to-end smoke: memory-health module + --health / --surface-cold /
// --consolidate CLIs. Uses a fresh temp DB via TOKENMEM_DB_PATH so it's
// safe to run in CI and never touches a user's real store.
// Run: TOKENMEM_DB_PATH=$(mktemp -u) node memory-health.test.mjs

import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, unlinkSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.TOKENMEM_DB_PATH
if (!DB_PATH) {
  console.error('FATAL: set TOKENMEM_DB_PATH to a temp path before running this test.')
  process.exit(2)
}
for (const suffix of ['', '-shm', '-wal']) {
  const p = DB_PATH + suffix
  if (existsSync(p)) unlinkSync(p)
}

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' — ' + detail : ''}`) }
}

// ── Unit: isNoiseQuery ──
{
  const { isNoiseQuery } = await import('./memory-health.mjs')
  check('isNoiseQuery: ok', isNoiseQuery('ok'))
  check('isNoiseQuery: thanks', isNoiseQuery('thanks'))
  check('isNoiseQuery: id:123', isNoiseQuery('id: 42'))
  check('isNoiseQuery: url', isNoiseQuery('https://example.com'))
  check('isNoiseQuery: file path', isNoiseQuery('foo.mjs'))
  check('isNoiseQuery: node cmd', isNoiseQuery('node index.mjs --stats'))
  check('isNoiseQuery: real question', !isNoiseQuery('how do I start the daemon?'))
  check('isNoiseQuery: real short zh', !isNoiseQuery('内存 gate 是啥'))
}

// ── Initialize a fresh DB via index.mjs migrations ──
{
  const { initMemory, closeMemory, storeMemory, runDecayCycle } = await import('./index.mjs')
  initMemory()
  // Seed with a handful of rows across levels + importances + ages.
  const now = Date.now()
  const D45 = 45 * 86400_000
  // 3 hot meta, 2 stale meta, 4 stale concrete
  storeMemory({ content: 'hot meta pattern one', memoryLevel: 'meta_knowledge', importance: 8, memoryType: 'long_term' })
  storeMemory({ content: 'hot meta pattern two', memoryLevel: 'meta_knowledge', importance: 8, memoryType: 'long_term' })
  storeMemory({ content: 'stale meta candidate one', memoryLevel: 'meta_knowledge', importance: 8, memoryType: 'long_term' })
  storeMemory({ content: 'stale meta candidate two', memoryLevel: 'meta_knowledge', importance: 8, memoryType: 'long_term' })
  storeMemory({ content: 'concrete op log one', memoryLevel: 'concrete_trace', importance: 4, memoryType: 'long_term' })
  storeMemory({ content: 'concrete op log two', memoryLevel: 'concrete_trace', importance: 4, memoryType: 'long_term' })
  storeMemory({ content: 'concrete op log three', memoryLevel: 'concrete_trace', importance: 4, memoryType: 'long_term' })
  // Violation: concrete with importance>5 (health should surface it).
  storeMemory({ content: 'concrete rule violation', memoryLevel: 'concrete_trace', importance: 8, memoryType: 'long_term' })
  // Age some rows backward via raw SQL to trip surface-cold / dead-knowledge.
  const Database = (await import('better-sqlite3')).default
  const db = new Database(DB_PATH)
  db.prepare('UPDATE memories SET last_accessed = ?, created_at = ? WHERE content LIKE ?').run(now - D45, now - D45, '%stale meta%')
  db.prepare('UPDATE memories SET last_accessed = ?, decay_score = 0.2 WHERE content LIKE ?').run(now - D45, '%op log%')
  db.close()
  closeMemory()
}

// ── --health JSON: structure + counts ──
{
  const r = spawnSync(process.execPath, [resolve(__dirname, 'index.mjs'), '--health', '--format', 'json'], {
    encoding: 'utf-8', env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH },
  })
  check('--health exit=0', r.status === 0, `stderr=${(r.stderr||'').slice(0,200)}`)
  const body = (r.stdout || '').split('\n').filter(l => l.trim().startsWith('{')).slice(-1)[0]
    || (r.stdout || '').split('\n').find(l => l.trim().startsWith('{'))
  let report
  try { report = JSON.parse((r.stdout || '').substring((r.stdout || '').indexOf('{'))) } catch { report = null }
  check('--health JSON parseable', report !== null)
  if (report) {
    check('--health inflation.total >= 8', report.inflation.total >= 8, `total=${report.inflation.total}`)
    check('--health surfaces concrete importance violation', report.inflation.concrete_importance_violations >= 1)
    check('--health lists dead_concrete rows', report.dead_concrete.length >= 3, `count=${report.dead_concrete.length}`)
    check('--health blindspot gracefully unavailable on fresh DB',
      report.blindspot && report.blindspot.available === false)
    check('--health has thresholds', typeof report.thresholds === 'object' && report.thresholds.sim_dup > 0)
  }
}

// ── --health text: renders headings ──
{
  const r = spawnSync(process.execPath, [resolve(__dirname, 'index.mjs'), '--health', '--format', 'text'], {
    encoding: 'utf-8', env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH },
  })
  check('--health text exit=0', r.status === 0)
  check('--health text has TL;DR', /## TL;DR/.test(r.stdout))
  check('--health text has (a) section', /## \(a\)/.test(r.stdout))
}

// ── --surface-cold text + JSON ──
{
  const rj = spawnSync(process.execPath, [resolve(__dirname, 'index.mjs'), '--surface-cold', '--min-importance', '7', '--days', '30', '--limit', '10', '--format', 'json'], {
    encoding: 'utf-8', env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH },
  })
  check('--surface-cold JSON exit=0', rj.status === 0, rj.stderr?.slice(0, 200))
  let payload
  try { payload = JSON.parse((rj.stdout || '').substring((rj.stdout || '').indexOf('{'))) } catch { payload = null }
  check('--surface-cold JSON parseable', payload !== null)
  check('--surface-cold surfaces stale meta rows', payload && payload.count >= 2 && payload.rows.every(r => r.importance >= 7),
    payload ? `count=${payload.count}` : 'no payload')

  const rt = spawnSync(process.execPath, [resolve(__dirname, 'index.mjs'), '--surface-cold', '--min-importance', '7', '--days', '30', '--limit', '3'], {
    encoding: 'utf-8', env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH },
  })
  check('--surface-cold text exit=0', rt.status === 0)
  check('--surface-cold text has READ-ONLY footer', /READ-ONLY/.test(rt.stdout))
}

// ── --consolidate --dry-run: no writes ──
{
  const Database = (await import('better-sqlite3')).default
  const dbBefore = new Database(DB_PATH, { readonly: true })
  const active_before = dbBefore.prepare('SELECT COUNT(*) c FROM memories WHERE deleted_at IS NULL').get().c
  dbBefore.close()

  const r = spawnSync(process.execPath, [resolve(__dirname, 'index.mjs'), '--consolidate', '--dry-run'], {
    encoding: 'utf-8', env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH },
  })
  check('--consolidate --dry-run exit=0', r.status === 0, r.stderr?.slice(0, 200))
  let result
  try { result = JSON.parse((r.stdout || '').substring((r.stdout || '').indexOf('{'))) } catch { result = null }
  check('--consolidate --dry-run JSON parseable', result !== null)
  check('--consolidate --dry-run marks dryRun=true', result?.dryRun === true)
  check('--consolidate --dry-run reports level_migrate', typeof result?.level_migrate === 'object')

  const dbAfter = new Database(DB_PATH, { readonly: true })
  const active_after = dbAfter.prepare('SELECT COUNT(*) c FROM memories WHERE deleted_at IS NULL').get().c
  dbAfter.close()
  check('--consolidate --dry-run did NOT mutate', active_before === active_after, `${active_before} -> ${active_after}`)
}

// ── --consolidate (real run): idempotent-ish ──
{
  const r1 = spawnSync(process.execPath, [resolve(__dirname, 'index.mjs'), '--consolidate'], {
    encoding: 'utf-8', env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH },
  })
  check('--consolidate exit=0', r1.status === 0, r1.stderr?.slice(0, 200))
  let result
  try { result = JSON.parse((r1.stdout || '').substring((r1.stdout || '').indexOf('{'))) } catch { result = null }
  check('--consolidate returned decay + level_migrate', result?.decay && result?.level_migrate)
  check('--consolidate demoted at least one stale meta', (result?.level_migrate?.demoted || 0) >= 1,
    `demoted=${result?.level_migrate?.demoted}`)

  // Second run should be idempotent — no more meta rows to demote.
  const r2 = spawnSync(process.execPath, [resolve(__dirname, 'index.mjs'), '--consolidate'], {
    encoding: 'utf-8', env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH },
  })
  check('--consolidate second run exit=0', r2.status === 0)
  const result2 = JSON.parse((r2.stdout || '').substring((r2.stdout || '').indexOf('{')))
  check('--consolidate second run: no additional demotes', (result2?.level_migrate?.demoted || 0) === 0,
    `demoted=${result2?.level_migrate?.demoted}`)
}

// ── --level-anchor: JSONL rollback file is actually written and parseable ──
{
  // Age enough meta rows to have at least one demotion candidate again.
  const Database = (await import('better-sqlite3')).default
  const db = new Database(DB_PATH)
  const D45 = 45 * 86400_000
  db.prepare('UPDATE memories SET last_accessed = ?, created_at = ?, memory_level = ?, access_count = 0 WHERE rowid = (SELECT MIN(rowid) FROM memories WHERE deleted_at IS NULL)')
    .run(Date.now() - D45, Date.now() - D45, 'meta_knowledge')
  db.close()

  const anchorPath = DB_PATH + '.anchor.jsonl'
  try { if (existsSync(anchorPath)) unlinkSync(anchorPath) } catch {}
  const r = spawnSync(process.execPath, [
    resolve(__dirname, 'index.mjs'), '--consolidate',
    '--skip-expire', '--skip-decay', '--level-anchor', anchorPath,
  ], { encoding: 'utf-8', env: { ...process.env, TOKENMEM_DB_PATH: DB_PATH } })
  check('--consolidate --level-anchor exit=0', r.status === 0, r.stderr?.slice(0, 200))
  check('--level-anchor file exists', existsSync(anchorPath))
  if (existsSync(anchorPath)) {
    const raw = (await import('node:fs')).readFileSync(anchorPath, 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    check('--level-anchor at least one line written', lines.length >= 1, `lines=${lines.length}`)
    let allParseable = true, allHaveShape = true
    for (const l of lines) {
      let parsed
      try { parsed = JSON.parse(l) } catch { allParseable = false; break }
      if (typeof parsed.rowid !== 'number' || typeof parsed.old_level !== 'string' || typeof parsed.old_importance !== 'number') {
        allHaveShape = false; break
      }
    }
    check('--level-anchor every line is parseable JSON', allParseable)
    check('--level-anchor every line has {rowid, old_level, old_importance}', allHaveShape)
    try { unlinkSync(anchorPath) } catch {}
  }
}

// ── detectNearDup: supersede band (0.85 <= cos < simFloor) ──
// Vectors are synthesized rather than embedded: the band logic is what is under
// test, and CI has no embedding key. parseVec/normalize/dot are dimension-
// agnostic, so 3-d unit-ish vectors reproduce the exact cosines we need.
{
  const Database = (await import('node:module')).createRequire(import.meta.url)('better-sqlite3')
  const { detectNearDup } = await import('./memory-health.mjs')
  const db = new Database(DB_PATH)

  const DAY = 86400_000
  const now = Date.now()
  // cos(A,B) ≈ 0.906 → supersede band; cos(C,D) ≈ 0.999 → dup band.
  const seed = [
    ['sb-iter-old', 'people', 'semi_abstract', 7, '[1,0,0]', now - 40 * DAY],
    ['sb-iter-new', 'people', 'semi_abstract', 7, '[0.906,0.423,0]', now - 5 * DAY],
    ['sb-dup-a', 'relationship', 'semi_abstract', 6, '[1,0,0]', now - 9 * DAY],
    ['sb-dup-b', 'relationship', 'semi_abstract', 6, '[0.9995,0.0316,0]', now - 8 * DAY],
    ['sb-series-old', 'bug', 'concrete_trace', 4, '[1,0,0]', now - 20 * DAY],
    ['sb-series-new', 'bug', 'concrete_trace', 4, '[0.906,0.423,0]', now - 2 * DAY],
  ]
  const ins = db.prepare(`
    INSERT INTO memories (id, content, summary, category, memory_level, memory_type,
                          importance, content_vector, created_at, updated_at, last_accessed, access_count)
    VALUES (?, ?, ?, ?, ?, 'long_term', ?, ?, ?, ?, ?, 0)
  `)
  for (const [id, cat, lvl, imp, vec, created] of seed) {
    ins.run(id, `content for ${id}`, `summary for ${id}`, cat, lvl, imp, vec, created, created, created)
  }
  db.prepare(`UPDATE memories SET is_pinned = 1 WHERE id = 'sb-iter-old'`).run()

  const nd = detectNearDup(db, { simFloor: 0.95, simDup: 0.97, simSupersede: 0.85 })
  const inCat = (list, cat) => list.filter(c => c.cat === cat)

  const sup = inCat(nd.supersede_candidates || [], 'people')
  check('supersede band catches a 0.85..0.95 pair', sup.length === 1,
    `got ${sup.length}`)
  check('supersede band leaves dup band untouched (back-compat)',
    inCat(nd.dup_candidates, 'relationship').length === 1 && inCat(nd.supersede_candidates || [], 'relationship').length === 0)

  if (sup.length === 1) {
    const d = sup[0].detail
    const older = db.prepare(`SELECT rowid FROM memories WHERE id = 'sb-iter-old'`).get().rowid
    const newer = db.prepare(`SELECT rowid FROM memories WHERE id = 'sb-iter-new'`).get().rowid
    check('supersede detail names the newer row', d.newer_rowid === newer,
      `newer_rowid=${d.newer_rowid} expected=${newer}`)
    check('supersede detail reports the write gap', d.age_gap_days === 35, `gap=${d.age_gap_days}`)
    check('supersede detail flags a pinned side', d.any_protected === true)
    check('supersede detail carries per-side review signals',
      d.a.rowid === older || d.b.rowid === older)
    check('supersede detail keeps summaries readable',
      (d.a.summary + d.b.summary).includes('summary for sb-iter'))
  }

  const series = inCat(nd.supersede_candidates || [], 'bug')
  check('two concrete_trace rows are flagged as a repeated series, not an iteration',
    series.length === 1 && series[0].detail.likely_series === true,
    `len=${series.length} flag=${series[0]?.detail?.likely_series}`)
  check('a non-concrete pair is not flagged as a series',
    sup.length === 1 && sup[0].detail.likely_series === false)

  db.close()
}

// ── (a3) shrink victims: collapse vs legitimate ledger rotation ──
{
  const { detectShrinkVictims } = await import('./memory-health.mjs')
  const Database = (await import('better-sqlite3')).default
  const db = new Database(DB_PATH)

  const OPS = 'ops entry: http://10.0.0.5:9000 root, /api/svc/v1 routes, SVC_TOKEN and SVC_URL env, '
    + 'code at E:/Project/svc/, handler src/http.mjs, schema src/db.mjs. '
    + 'Padding so the row clears the 200B floor and has a real historical peak to measure against.'
  const priors = (content) => JSON.stringify([{ content, summary: null, merged_at: Date.now(), source_rowid: 1, created_at: Date.now() }])
  const ins = db.prepare(`INSERT INTO memories (content, summary, memory_type, category, importance, memory_level, access_count, prior_versions, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
  const t = Date.now()

  // collapsed: high importance, shrank far below peak, identifiers gone
  ins.run('svc status: now v2.', 'collapsed ref entry', 'long_term', 'general', 9, 'semi_abstract', 40, priors(OPS), t, t)
  // ledger: rotates an old name out (so it DOES lose a token) yet still grows
  // past its own peak — the daily-log shape, expected, must NOT flag
  ins.run(OPS.replace('schema src/db.mjs. ', 'schema new/other.mjs. ')
    + ' Plus a later section that makes this entry longer than any prior version, which is what a running ledger does every day.',
    'growing ledger', 'long_term', 'general', 9, 'semi_abstract', 5, priors(OPS), t, t)
  // low importance: shrank the same way but below the review bar
  ins.run('svc status: now v2.', 'low-imp shrink', 'long_term', 'general', 4, 'semi_abstract', 1, priors(OPS), t, t)
  // faithful rewrite: shorter prose, every identifier carried over
  ins.run('http://10.0.0.5:9000 · /api/svc/v1 · SVC_TOKEN · SVC_URL · E:/Project/svc/ · src/http.mjs · src/db.mjs',
    'faithful tightening', 'long_term', 'general', 9, 'semi_abstract', 3, priors(OPS), t, t)

  const sh = detectShrinkVictims(db)
  const by = (s) => sh.victims.filter(v => (v.summary || '').includes(s))
  check('(a3) scan available', sh.available === true)
  check('(a3) flags the collapsed reference entry', by('collapsed ref entry').length === 1,
    `victims=${sh.victims.map(v => v.summary).join(' / ')}`)
  check('(a3) growing ledger counted as rotation, not flagged',
    by('growing ledger').length === 0 && sh.ledger_growing >= 1, `ledger_growing=${sh.ledger_growing}`)
  check('(a3) below-importance shrink filtered out', by('low-imp shrink').length === 0)
  check('(a3) faithful tightening not flagged', by('faithful tightening').length === 0)

  const v = by('collapsed ref entry')[0]
  check('(a3) names the lost identifiers',
    !!v && ['SVC_TOKEN', 'SVC_URL', '/api/svc/v1', 'src/db.mjs'].every(tok => v.lost.includes(tok)),
    JSON.stringify(v?.lost))
  check('(a3) reports peak-relative ratio', !!v && v.ratio < 0.8 && v.peak_len > v.now_len,
    `${v?.peak_len}->${v?.now_len} ratio=${v?.ratio}`)
  check('(a3) honours a raised importance bar',
    detectShrinkVictims(db, { shrinkMinImportance: 10 }).victims.length === 0)

  db.close()
}

// Cleanup temp DB files
for (const suffix of ['', '-shm', '-wal']) {
  const p = DB_PATH + suffix
  try { if (existsSync(p)) unlinkSync(p) } catch {}
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
