import { execFileSync } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, resolve } from 'path'

// Claude Code loads at most the first 200 lines / 25 KiB of MEMORY.md at
// session start. Mirror that boundary so Alt+X preserves the same effective
// project memory without letting a large index consume the Codex window.
export const CLAUDE_MEMORY_MAX_LINES = 200
export const CLAUDE_MEMORY_MAX_BYTES = 25 * 1024

export interface ClaudeMemorySnapshot {
  file: string
  content: string
  truncated: boolean
}

export interface ClaudeMemoryLookupOptions {
  claudeHome?: string
  repoRoot?: string | null
}

function encodedProjectDirs(projectPath: string, projectsDir: string): string[] {
  if (!projectPath) return []
  return [
    join(projectsDir, projectPath.replace(/[/.]/g, '-')),
    join(projectsDir, projectPath.replace(/\//g, '-')),
  ]
}

function configuredMemoryFile(claudeHome: string): string | null {
  try {
    const settings = JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf8')) as {
      autoMemoryDirectory?: string
    }
    const configured = settings.autoMemoryDirectory?.trim()
    if (!configured) return null
    const dir = configured.startsWith('~/')
      ? join(homedir(), configured.slice(2))
      : configured
    if (!isAbsolute(dir)) return null
    return join(dir, 'MEMORY.md')
  } catch {
    return null
  }
}

/**
 * Claude keys Auto Memory by the git repository, shared across worktrees.
 * `--git-common-dir` points back to the primary checkout for a normal
 * worktree; submodules use a differently-shaped common dir, so retain their
 * own top-level directory instead.
 */
function gitMemoryRoot(cwd: string): string | null {
  if (!cwd) return null
  try {
    const common = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    if (common && basename(common) === '.git') return dirname(common)
    const top = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    return top || null
  } catch {
    // Older git versions may not support --path-format. Resolve their
    // relative --git-common-dir output against cwd before falling back.
    try {
      const raw = execFileSync(
        'git',
        ['-C', cwd, 'rev-parse', '--git-common-dir'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim()
      const common = raw ? resolve(cwd, raw) : ''
      if (common && basename(common) === '.git') return dirname(common)
      const top = execFileSync(
        'git',
        ['-C', cwd, 'rev-parse', '--show-toplevel'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim()
      return top || null
    } catch {
      return null
    }
  }
}

function isNonEmptyFile(file: string): boolean {
  try {
    return existsSync(file) && statSync(file).isFile() && statSync(file).size > 0
  } catch {
    return false
  }
}

/**
 * Resolve the Claude Auto Memory that belongs to the source session.
 *
 * Priority:
 *  1. explicit user-level autoMemoryDirectory;
 *  2. canonical git repository (makes worktrees share memory);
 *  3. the actual Claude JSONL project directory (authoritative outside git);
 *  4. legacy literal-cwd encodings.
 */
export function findClaudeMemoryIndex(
  jsonlPath: string,
  cwd: string,
  options: ClaudeMemoryLookupOptions = {},
): string | null {
  const claudeHome = options.claudeHome || join(homedir(), '.claude')
  const projectsDir = join(claudeHome, 'projects')
  const repoRoot = options.repoRoot === undefined ? gitMemoryRoot(cwd) : options.repoRoot
  const candidates = [
    configuredMemoryFile(claudeHome),
    ...(repoRoot ? encodedProjectDirs(repoRoot, projectsDir).map((p) => join(p, 'memory', 'MEMORY.md')) : []),
    ...(jsonlPath ? [join(dirname(jsonlPath), 'memory', 'MEMORY.md')] : []),
    ...encodedProjectDirs(cwd, projectsDir).map((p) => join(p, 'memory', 'MEMORY.md')),
  ].filter((p): p is string => Boolean(p))

  for (const file of new Set(candidates)) {
    if (isNonEmptyFile(file)) return file
  }
  return null
}

/** Resolve repo-scoped Claude Auto Memory without requiring a source Claude session. */
export function findClaudeMemoryForProject(
  cwd: string,
  options: ClaudeMemoryLookupOptions = {},
): string | null {
  return findClaudeMemoryIndex('', cwd, options)
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const chars: string[] = []
  let bytes = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes) break
    chars.push(char)
    bytes += size
  }
  return chars.join('')
}

export function readClaudeMemorySnapshot(
  jsonlPath: string,
  cwd: string,
  options: ClaudeMemoryLookupOptions = {},
): ClaudeMemorySnapshot | null {
  const file = findClaudeMemoryIndex(jsonlPath, cwd, options)
  if (!file) return null
  try {
    const raw = readFileSync(file, 'utf8')
    const lines = raw.split(/\r?\n/)
    const lineLimited = lines.slice(0, CLAUDE_MEMORY_MAX_LINES).join('\n')
    const content = truncateUtf8(lineLimited, CLAUDE_MEMORY_MAX_BYTES).trim()
    if (!content) return null
    return {
      file,
      content,
      truncated:
        lines.length > CLAUDE_MEMORY_MAX_LINES ||
        Buffer.byteLength(lineLimited, 'utf8') > CLAUDE_MEMORY_MAX_BYTES,
    }
  } catch {
    return null
  }
}

/** Build the actual first Codex message; no follow-up file read is required. */
export function buildClaudeMemoryStartupPrompt(
  jsonlPath: string,
  cwd: string,
  options: ClaudeMemoryLookupOptions = {},
): string | undefined {
  const snapshot = readClaudeMemorySnapshot(jsonlPath, cwd, options)
  if (!snapshot) return undefined
  return [
    '以下是源 Claude Code 仓库的 Auto Memory 只读快照。它只提供历史背景；当前用户指令、AGENTS.md 与仓库实时状态优先。',
    `来源文件: ${JSON.stringify(snapshot.file)}${snapshot.truncated ? '（按 Claude 启动加载上限截取）' : ''}`,
    '<claude-project-memory>',
    snapshot.content,
    '</claude-project-memory>',
    '不要修改上述 Claude Memory；Codex 侧的新发现由各自记忆机制或变回 Claude 时的会话交接处理。',
  ].join('\n')
}
