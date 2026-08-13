import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

import {
  parseClaudeMemory,
  recallClaudeMarkdownMemory,
  resolveClaudeMemoryDirs,
} from './lib/claude-markdown-memory.mjs'

function withTempDir(fn) {
  const root = mkdtempSync(join(tmpdir(), 'mneme-claude-memory-'))
  try {
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeMemory(memoryDir, fileName, content) {
  mkdirSync(memoryDir, { recursive: true })
  const filePath = join(memoryDir, fileName)
  writeFileSync(filePath, content, 'utf8')
  return filePath
}

test('parseClaudeMemory extracts simple frontmatter and body', () => {
  const parsed = parseClaudeMemory([
    '---',
    'name: "Windows UTF-8 rule"',
    "description: 'Read Chinese files explicitly as UTF-8'",
    'type: playbook',
    'metadata:',
    '  ignored: nested',
    '---',
    'Use Get-Content -Encoding UTF8.',
  ].join('\r\n'), {
    filePath: 'C:\\memory\\windows-utf8.md',
    project: 'E--project',
  })

  assert.equal(parsed.name, 'Windows UTF-8 rule')
  assert.equal(parsed.description, 'Read Chinese files explicitly as UTF-8')
  assert.equal(parsed.type, 'playbook')
  assert.equal(parsed.project, 'E--project')
  assert.equal(parsed.body, 'Use Get-Content -Encoding UTF8.')
})

test('parseClaudeMemory falls back to the file stem', () => {
  const parsed = parseClaudeMemory('Body only', {
    filePath: 'C:\\memory\\fallback-name.md',
    project: 'project-a',
  })

  assert.equal(parsed.name, 'fallback-name')
  assert.equal(parsed.description, '')
  assert.equal(parsed.type, '')
  assert.equal(parsed.body, 'Body only')
})

test('parseClaudeMemory rejects replacement-character text', () => {
  assert.equal(parseClaudeMemory('damaged \uFFFD content', {
    filePath: 'C:\\memory\\damaged.md',
    project: 'project-a',
  }), null)
})

test('resolveClaudeMemoryDirs discovers immediate Claude project memory directories', () => {
  withTempDir(home => {
    const alpha = join(home, '.claude', 'projects', 'project-alpha', 'memory')
    const beta = join(home, '.claude', 'projects', 'project-beta', 'memory')
    const tooDeep = join(home, '.claude', 'projects', 'nested', 'child', 'memory')
    mkdirSync(alpha, { recursive: true })
    mkdirSync(beta, { recursive: true })
    mkdirSync(tooDeep, { recursive: true })
    mkdirSync(join(home, '.claude', 'projects', 'project-without-memory'), { recursive: true })

    assert.deepEqual(resolveClaudeMemoryDirs({ home }), [resolve(alpha), resolve(beta)])
  })
})

test('resolveClaudeMemoryDirs uses a path-delimited environment override', () => {
  withTempDir(root => {
    const first = join(root, 'first-memory')
    const second = join(root, 'second-memory')
    mkdirSync(first)
    mkdirSync(second)

    const actual = resolveClaudeMemoryDirs({
      env: {
        MNEME_CLAUDE_MEMORY_DIRS: [second, first, second, join(root, 'missing')].join(delimiter),
      },
    })

    assert.deepEqual(actual, [resolve(first), resolve(second)])
  })
})

test('resolveClaudeMemoryDirs fails soft when Claude memory is absent', () => {
  withTempDir(home => {
    assert.deepEqual(resolveClaudeMemoryDirs({ home }), [])
  })
})

test('recallClaudeMarkdownMemory ranks name, description, and body deterministically', () => {
  withTempDir(root => {
    const memoryDir = join(root, 'project-alpha', 'memory')
    writeMemory(memoryDir, 'needle-name.md', 'No match here.')
    writeMemory(memoryDir, 'description.md', [
      '---',
      'name: unrelated',
      'description: needle appears here',
      'type: finding',
      '---',
      'No match here.',
    ].join('\n'))
    writeMemory(memoryDir, 'body.md', [
      '---',
      'name: unrelated',
      'description: none',
      'type: note',
      '---',
      'The body contains needle.',
    ].join('\n'))

    const result = recallClaudeMarkdownMemory({ query: 'needle', memoryDirs: [memoryDir] })

    assert.deepEqual(result.hits.map(hit => hit.path.split(/[\\/]/).at(-1)), [
      'needle-name.md',
      'description.md',
      'body.md',
    ])
    assert.deepEqual(result.hits.map(hit => hit.score), [20, 17, 13])
    assert.equal(result.scanned_files, 3)
    assert.equal(result.skipped_files, 0)
    assert.equal(result.capped, false)
    assert.deepEqual(Object.keys(result.hits[0]).sort(), [
      'description',
      'modified_at',
      'name',
      'path',
      'preview',
      'project',
      'score',
      'type',
    ])
  })
})

test('recallClaudeMarkdownMemory supports CJK tokens and project filtering', () => {
  withTempDir(root => {
    const alpha = join(root, 'project-alpha', 'memory')
    const beta = join(root, 'project-beta', 'memory')
    writeMemory(alpha, 'alpha.md', '项目采用中文编码规则。')
    writeMemory(beta, 'beta.md', '另一个项目也有中文编码规则。')

    const result = recallClaudeMarkdownMemory({
      query: '中文编码',
      project: 'project-beta',
      memoryDirs: [alpha, beta],
    })

    assert.equal(result.hits.length, 1)
    assert.equal(result.hits[0].project, 'project-beta')
    assert.match(result.hits[0].preview, /中文编码/)
  })
})

test('recallClaudeMarkdownMemory excludes index, nested, and non-Markdown files', () => {
  withTempDir(root => {
    const memoryDir = join(root, 'project-alpha', 'memory')
    writeMemory(memoryDir, 'MEMORY.md', 'ignoredneedle')
    writeMemory(memoryDir, 'notes.txt', 'ignoredneedle')
    writeMemory(join(memoryDir, 'nested'), 'nested.md', 'ignoredneedle')
    writeMemory(memoryDir, 'visible.md', 'different content')

    const result = recallClaudeMarkdownMemory({ query: 'ignoredneedle', memoryDirs: [memoryDir] })

    assert.equal(result.hits.length, 0)
    assert.equal(result.scanned_files, 1)
  })
})

test('recallClaudeMarkdownMemory deduplicates identical content and keeps the newest file', () => {
  withTempDir(root => {
    const alpha = join(root, 'project-alpha', 'memory')
    const beta = join(root, 'project-beta', 'memory')
    const content = [
      '---',
      'name: sharedneedle',
      'description: duplicate fixture',
      '---',
      'Same portable knowledge.',
    ].join('\n')
    const older = writeMemory(alpha, 'copy-a.md', content)
    const newer = writeMemory(beta, 'copy-b.md', content)
    utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
    utimesSync(newer, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'))

    const result = recallClaudeMarkdownMemory({ query: 'sharedneedle', memoryDirs: [alpha, beta] })

    assert.equal(result.hits.length, 1)
    assert.equal(result.hits[0].project, 'project-beta')
    assert.equal(result.hits[0].path, resolve(newer))
  })
})

test('recallClaudeMarkdownMemory returns no hits for blank and unmatched queries', () => {
  withTempDir(root => {
    const memoryDir = join(root, 'project-alpha', 'memory')
    writeMemory(memoryDir, 'only.md', 'known content')

    assert.equal(recallClaudeMarkdownMemory({ query: '   ', memoryDirs: [memoryDir] }).hits.length, 0)
    assert.equal(recallClaudeMarkdownMemory({ query: 'absent', memoryDirs: [memoryDir] }).hits.length, 0)
  })
})

test('recallClaudeMarkdownMemory enforces file, result, and preview bounds', () => {
  withTempDir(root => {
    const memoryDir = join(root, 'project-alpha', 'memory')
    writeMemory(memoryDir, 'boundaryneedle-long.md', `boundaryneedle ${'界'.repeat(2_000)}`)
    for (let i = 0; i < 24; i++) {
      writeMemory(memoryDir, `match-${String(i).padStart(2, '0')}.md`, `boundaryneedle ${i}`)
    }
    writeMemory(memoryDir, 'oversized.md', Buffer.alloc(1024 * 1024 + 1, 0x61))
    writeMemory(memoryDir, 'replacement.md', 'boundaryneedle \uFFFD damaged')

    const result = recallClaudeMarkdownMemory({
      query: 'boundaryneedle',
      limit: 100,
      memoryDirs: [memoryDir],
    })

    assert.equal(result.hits.length, 20)
    assert.equal(result.scanned_files, 27)
    assert.equal(result.skipped_files, 2)
    const longHit = result.hits.find(hit => hit.path.endsWith('boundaryneedle-long.md'))
    assert.ok(longHit)
    assert.equal([...longHit.preview].length, 1_200)
  })
})

test('recallClaudeMarkdownMemory caps each scan at 5000 eligible files', () => {
  withTempDir(root => {
    const memoryDir = join(root, 'project-alpha', 'memory')
    for (let i = 0; i < 5_001; i++) {
      writeMemory(memoryDir, `cap-${String(i).padStart(4, '0')}.md`, `capneedle ${i}`)
    }

    const result = recallClaudeMarkdownMemory({ query: 'capneedle', memoryDirs: [memoryDir] })

    assert.equal(result.scanned_files, 5_000)
    assert.equal(result.capped, true)
    assert.equal(result.hits.length, 8)
  })
})

test('recallClaudeMarkdownMemory fails soft for nonexistent explicit directories', () => {
  withTempDir(root => {
    const result = recallClaudeMarkdownMemory({
      query: 'anything',
      memoryDirs: [join(root, 'missing')],
    })

    assert.deepEqual(result, {
      hits: [],
      scanned_files: 0,
      skipped_files: 0,
      capped: false,
    })
  })
})
