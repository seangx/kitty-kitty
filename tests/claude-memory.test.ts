import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  CLAUDE_MEMORY_MAX_BYTES,
  CLAUDE_MEMORY_MAX_LINES,
  buildClaudeMemoryStartupPrompt,
  findClaudeMemoryIndex,
  readClaudeMemorySnapshot,
} from '../src/main/claude-memory.ts'

function encoded(projectPath: string): string {
  return projectPath.replace(/[/.]/g, '-')
}

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

test('uses the source JSONL project memory instead of guessing from a stale cwd', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kitty-claude-memory-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const claudeHome = join(root, '.claude')
  const projectDir = join(claudeHome, 'projects', '-actual-project')
  const jsonl = join(projectDir, 'session.jsonl')
  const memory = join(projectDir, 'memory', 'MEMORY.md')
  write(jsonl, '{}\n')
  write(memory, '# Actual project memory\n')

  assert.equal(
    findClaudeMemoryIndex(jsonl, '/stale/cwd', { claudeHome, repoRoot: null }),
    memory,
  )
})

test('maps a worktree session to the repository-shared Claude memory', (t) => {
  // macOS exposes tmpdir through both /var and /private/var. Git resolves the
  // real path, so use the same canonical spelling Claude receives from git.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kitty-claude-worktree-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const worktree = join(root, 'worktree')
  const claudeHome = join(root, '.claude')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test'])
  write(join(repo, 'tracked.txt'), 'tracked\n')
  execFileSync('git', ['-C', repo, 'add', 'tracked.txt'])
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'init'])
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-qb', 'test-worktree', worktree])

  const sessionProject = join(claudeHome, 'projects', encoded(worktree))
  const jsonl = join(sessionProject, 'session.jsonl')
  const sharedMemory = join(claudeHome, 'projects', encoded(repo), 'memory', 'MEMORY.md')
  write(jsonl, '{}\n')
  write(sharedMemory, '# Shared across worktrees\n')

  assert.equal(findClaudeMemoryIndex(jsonl, worktree, { claudeHome }), sharedMemory)
})

test('injects the effective memory snapshot and respects Claude startup limits', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kitty-claude-memory-limit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const claudeHome = join(root, '.claude')
  const projectDir = join(claudeHome, 'projects', '-project')
  const jsonl = join(projectDir, 'session.jsonl')
  const memory = join(projectDir, 'memory', 'MEMORY.md')
  const lines = Array.from({ length: CLAUDE_MEMORY_MAX_LINES + 20 }, (_, i) => `${i}: ${'记'.repeat(100)}`)
  write(jsonl, '{}\n')
  write(memory, lines.join('\n'))

  const snapshot = readClaudeMemorySnapshot(jsonl, '/project', { claudeHome, repoRoot: null })
  assert.ok(snapshot)
  assert.equal(snapshot.truncated, true)
  assert.ok(snapshot.content.split('\n').length <= CLAUDE_MEMORY_MAX_LINES)
  assert.ok(Buffer.byteLength(snapshot.content, 'utf8') <= CLAUDE_MEMORY_MAX_BYTES)
  assert.ok(!snapshot.content.includes(`${CLAUDE_MEMORY_MAX_LINES + 19}:`))

  const prompt = buildClaudeMemoryStartupPrompt(jsonl, '/project', { claudeHome, repoRoot: null })
  assert.ok(prompt?.includes('<claude-project-memory>'))
  assert.ok(prompt?.includes('0: 记'))
  assert.ok(prompt?.includes('当前用户指令、AGENTS.md 与仓库实时状态优先'))
})

test('honors Claude autoMemoryDirectory when configured', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kitty-claude-memory-config-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const claudeHome = join(root, '.claude')
  const customMemory = join(root, 'custom-memory', 'MEMORY.md')
  const jsonl = join(claudeHome, 'projects', '-project', 'session.jsonl')
  write(join(claudeHome, 'settings.json'), JSON.stringify({ autoMemoryDirectory: dirname(customMemory) }))
  write(customMemory, '# Custom location\n')
  write(jsonl, '{}\n')

  assert.equal(
    findClaudeMemoryIndex(jsonl, '/project', { claudeHome, repoRoot: null }),
    customMemory,
  )
})
