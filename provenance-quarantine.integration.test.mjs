// End-to-end: channel-derived provenance (migration 011) + quarantine (012)
//
// These two shipped in a downstream runtime copy before this repo had them,
// and were renumbered on the way up. The contract worth protecting: a host
// label is EVIDENCE, and evidence comes from the channel — a caller can never
// assert its own provenance, and an untrusted host's writes are invisible to
// recall by construction rather than by remembering a WHERE clause.
//
// Run: node provenance-quarantine.integration.test.mjs
import {
  initMemory, closeMemory, storeMemory,
  storeMemoryQuarantined, listQuarantine, resolveQuarantine, getQuarantineStats,
  recallMemories,
} from './index.mjs'
import { parseHostTokens, resolveAuthMode, resolveHost, HOST_LABEL_RE } from './auth.mjs'
import Database from 'better-sqlite3'

const DB_PATH = process.env.TOKENMEM_DB_PATH
if (!DB_PATH) { console.error('FATAL: set TOKENMEM_DB_PATH'); process.exit(2) }

let pass = 0, fail = 0
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' — ' + detail : ''}`) }
}

// ── auth.mjs unit surface ──
{
  const map = parseHostTokens('cc=tok1,codex=tok2')
  check('parseHostTokens builds token->host map', map.get('tok1') === 'cc' && map.get('tok2') === 'codex')
  check('parseHostTokens tolerates empty input', parseHostTokens('').size === 0 && parseHostTokens(undefined).size === 0)

  check('auth mode defaults to soft once tokens exist', resolveAuthMode(undefined, map) !== 'off', resolveAuthMode(undefined, map))
  check('auth mode is off with no tokens', resolveAuthMode(undefined, new Map()) === 'off')

  const good = resolveHost('Bearer tok2', map, { mode: 'enforce', defaultHost: 'cc' })
  check('known token resolves to its host', good.ok && good.host === 'codex' && good.authed === true)

  const bad = resolveHost('Bearer nope', map, { mode: 'enforce', defaultHost: 'cc' })
  check('enforce mode rejects an unknown token', bad.ok === false && bad.host === null, JSON.stringify(bad))

  const soft = resolveHost(undefined, map, { mode: 'soft', defaultHost: 'cc' })
  check('soft mode falls back to default host, marked unauthed', soft.ok && soft.host === 'cc' && soft.authed === false)

  check('host label regex rejects junk', !HOST_LABEL_RE.test('not a host!!') && HOST_LABEL_RE.test('codex'))
}

initMemory()

// ── provenance is channel-derived, never caller-asserted ──
{
  const ok = storeMemory({ content: 'row written by codex runtime', memoryType: 'short_term', sourceHost: 'codex' })
  const forged = storeMemory({ content: 'row claiming a bogus host', memoryType: 'short_term', sourceHost: 'not a host!!' })
  const none = storeMemory({ content: 'row with no host at all', memoryType: 'short_term' })

  const db = new Database(DB_PATH, { readonly: true })
  const hostOf = id => db.prepare('SELECT source_host FROM memories WHERE rowid = ?').get(id).source_host
  check('valid host label is stored', hostOf(ok) === 'codex')
  check('malformed host label is dropped to NULL, not stored', hostOf(forged) === null, String(hostOf(forged)))
  check('absent host stays NULL rather than being defaulted', hostOf(none) === null,
    'unlabeled writes must stay visibly unlabeled')
  db.close()
}

// ── quarantined writes are invisible to recall BY CONSTRUCTION ──
{
  const qid = storeMemoryQuarantined({
    content: 'quarantined claim about zzqmarker widget calibration',
    summary: 'zzqmarker quarantined entry',
    importance: 7, sourceHost: 'newhost',
    supersedes: ['1'],
  })
  check('quarantined write returns a qid', !!qid, String(qid))

  const db = new Database(DB_PATH, { readonly: true })
  const inMain = db.prepare("SELECT COUNT(*) c FROM memories WHERE content LIKE '%zzqmarker%'").get().c
  check('quarantined row is NOT in the main pool', inMain === 0, `found ${inMain}`)
  check('quarantined row did NOT execute its requested supersede',
    db.prepare('SELECT superseded_by FROM memories WHERE rowid = 1').get()?.superseded_by == null)
  db.close()

  const pending = listQuarantine({ status: 'pending' })
  check('listQuarantine surfaces it for review', pending.length === 1 && pending[0].source_host === 'newhost')
  check('getQuarantineStats groups by host', getQuarantineStats().byHost?.newhost?.pending === 1,
    JSON.stringify(getQuarantineStats().byHost))
}

// ── approval merges into the main pool, preserving provenance ──
{
  const pending = listQuarantine({ status: 'pending' })
  const res = await resolveQuarantine(pending[0].qid, { action: 'approve' })
  check('approve reports ok + merged rowid', res.ok && res.action === 'approved' && !!res.merged_rowid, JSON.stringify(res))

  const db = new Database(DB_PATH, { readonly: true })
  const row = db.prepare("SELECT rowid, source_host FROM memories WHERE content LIKE '%zzqmarker%'").get()
  check('approved row lands in the main pool', !!row)
  check('approved row keeps its originating host', row?.source_host === 'newhost', String(row?.source_host))
  check('nothing is left pending', db.prepare("SELECT COUNT(*) c FROM memories_quarantine WHERE review_status='pending'").get().c === 0)
  db.close()
}

// ── rejection keeps the row out and records the reason ──
// Note discipline ("reject requires a note") is enforced at the MCP tool
// boundary, not here: this engine is a library and records what it is given.
// What the engine must guarantee is that rejected content never reaches recall
// and that the reason is durably attached for the trust record.
{
  const qid = storeMemoryQuarantined({ content: 'a claim that should be rejected', importance: 4, sourceHost: 'newhost' })
  const done = await resolveQuarantine(qid, { action: 'reject', note: 'not worth keeping' })
  check('reject succeeds and reports the action', done.ok === true && done.action === 'rejected', JSON.stringify(done))

  const db = new Database(DB_PATH, { readonly: true })
  check('rejected content never reaches the main pool',
    db.prepare("SELECT COUNT(*) c FROM memories WHERE content LIKE '%should be rejected%'").get().c === 0)
  check('rejection reason is persisted for the trust record',
    db.prepare('SELECT review_note FROM memories_quarantine WHERE qid = ?').get(qid)?.review_note === 'not worth keeping')

  const again = await resolveQuarantine(qid, { action: 'approve' })
  check('an already-resolved entry cannot be re-resolved', again.ok === false, JSON.stringify(again))
  check('and it still did not reach the main pool',
    db.prepare("SELECT COUNT(*) c FROM memories WHERE content LIKE '%should be rejected%'").get().c === 0)
  db.close()
}

closeMemory()
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
