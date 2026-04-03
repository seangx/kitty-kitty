import { execSync } from 'child_process'
import { existsSync, symlinkSync, mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { v4 as uuid } from 'uuid'
import { generateLaunchScript } from '../tmux/cli-wrapper'
import * as wtRepo from '../db/worktree-pane-repo'
import type { WorktreePaneInfo, DiscoveredWorktree } from '@shared/types/worktree'

/**
 * Sanitize a branch name for use as a filesystem path component.
 */
function sanitizeBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9/_.-]/g, '-')
}

/**
 * Check if a tmux pane is alive.
 */
function isPaneAlive(paneId: string): boolean {
  try {
    execSync(`tmux display-message -t "${paneId}" ""`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Convert a DB row to WorktreePaneInfo (with default mergeState/aheadBehind).
 */
function rowToInfo(row: wtRepo.WorktreePaneRow): WorktreePaneInfo {
  return {
    id: row.id,
    sessionId: row.sessionId,
    paneId: row.paneId,
    branch: row.branch,
    path: row.path,
    baseBranch: row.baseBranch,
    tool: row.tool,
    mergeState: (row.mergeState as WorktreePaneInfo['mergeState']) || 'unknown',
    status: (row.status as WorktreePaneInfo['status']) || 'active',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Create a git worktree and split it as a tmux pane within an existing session.
 */
export function createWorktreePane(
  sessionId: string,
  tmuxName: string,
  projectRoot: string,
  branch: string,
  baseBranch?: string,
  tool?: string
): WorktreePaneInfo {
  const safeBranch = sanitizeBranch(branch)
  if (!safeBranch) throw new Error('无效的分支名')

  const worktreePath = join(projectRoot, '.worktrees', safeBranch.replace(/\//g, '-'))
  const effectiveTool = tool || 'claude'

  // Step 1: Create the git worktree
  try {
    try {
      execSync(`git -C "${projectRoot}" rev-parse --verify "${safeBranch}"`, { stdio: 'ignore' })
      // Branch exists — create worktree from existing branch
      execSync(`git -C "${projectRoot}" worktree add "${worktreePath}" "${safeBranch}"`, {
        stdio: 'ignore'
      })
    } catch {
      // Branch doesn't exist — create new branch (from baseBranch if provided)
      if (baseBranch) {
        execSync(
          `git -C "${projectRoot}" worktree add -b "${safeBranch}" "${worktreePath}" "${baseBranch}"`,
          { stdio: 'ignore' }
        )
      } else {
        execSync(`git -C "${projectRoot}" worktree add -b "${safeBranch}" "${worktreePath}"`, {
          stdio: 'ignore'
        })
      }
    }
  } catch (err: any) {
    throw new Error(`worktree 创建失败: ${err.message}`)
  }

  // Step 2: Ensure .worktrees is in .gitignore
  const gitignorePath = join(projectRoot, '.gitignore')
  try {
    const content = existsSync(gitignorePath)
      ? require('fs').readFileSync(gitignorePath, 'utf-8')
      : ''
    if (!content.split('\n').some((l: string) => l.trim() === '.worktrees')) {
      appendFileSync(gitignorePath, `${content.endsWith('\n') ? '' : '\n'}.worktrees\n`)
    }
  } catch { /* ignore */ }

  // Step 3: Symlink Claude project dir so worktree shares sessions with main repo
  // Claude encodes path: /Users/foo/bar → -Users-foo-bar
  const claudeProjectsDir = join(homedir(), '.claude', 'projects')
  const mainEncoded = projectRoot.replace(/\//g, '-')
  const wtEncoded = worktreePath.replace(/\//g, '-')
  const mainClaudeDir = join(claudeProjectsDir, mainEncoded)
  const wtClaudeDir = join(claudeProjectsDir, wtEncoded)
  try {
    if (!existsSync(mainClaudeDir)) {
      mkdirSync(mainClaudeDir, { recursive: true })
    }
    if (!existsSync(wtClaudeDir)) {
      symlinkSync(mainClaudeDir, wtClaudeDir)
    }
  } catch { /* ignore — sessions just won't be shared */ }

  // Step 4: Symlink openspec dir
  const mainOpenspec = join(projectRoot, 'openspec')
  const wtOpenspec = join(worktreePath, 'openspec')
  try {
    if (existsSync(mainOpenspec) && !existsSync(wtOpenspec)) {
      symlinkSync(mainOpenspec, wtOpenspec)
    }
  } catch { /* ignore */ }

  // Step 5: Split a new tmux pane and get its ID
  const script = generateLaunchScript(effectiveTool, 'new')
  let paneId: string
  try {
    paneId = execSync(
      `tmux split-window -t "${tmuxName}" -h -c "${worktreePath}" -P -F "#{pane_id}" "${script}"`,
      { encoding: 'utf-8' }
    ).trim()
  } catch (err: any) {
    throw new Error(`tmux split-window 失败: ${err.message}`)
  }

  // Step 6: Save to DB
  const id = uuid()
  wtRepo.saveWorktreePane({
    id,
    sessionId,
    paneId,
    branch: safeBranch,
    path: worktreePath,
    baseBranch: baseBranch || '',
    tool: effectiveTool,
  })

  return {
    id,
    sessionId,
    paneId,
    branch: safeBranch,
    path: worktreePath,
    baseBranch: baseBranch || '',
    tool: effectiveTool,
    mergeState: 'unknown',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Remove a worktree pane. Optionally keep the git worktree on disk.
 */
export function removeWorktreePane(
  paneId: string,
  opts?: { keepWorktree?: boolean }
): void {
  const row = wtRepo.getPaneById(paneId)
  if (!row) return

  // Kill the tmux pane if alive
  if (row.paneId) {
    try {
      execSync(`tmux kill-pane -t "${row.paneId}"`, { stdio: 'ignore' })
    } catch { /* pane may already be dead */ }
  }

  // Remove the git worktree unless caller opts out
  if (!opts?.keepWorktree && row.path) {
    try {
      execSync(`git worktree remove --force "${row.path}"`, { stdio: 'ignore' })
    } catch { /* ignore — worktree may not exist */ }
  }

  // Delete from DB
  wtRepo.deleteWorktreePane(paneId)
}

/**
 * Discover existing git worktrees in a project that are not tracked in the DB.
 */
export function discoverWorktrees(projectRoot: string): DiscoveredWorktree[] {
  let output: string
  try {
    output = execSync(`git -C "${projectRoot}" worktree list --porcelain`, {
      encoding: 'utf-8'
    })
  } catch {
    return []
  }

  // Parse porcelain output
  // Each worktree block is separated by blank lines:
  //   worktree /path/to/wt
  //   HEAD <sha>
  //   branch refs/heads/<name>
  const blocks = output.trim().split(/\n\n+/)
  const trackedPaths = new Set(
    wtRepo.listAllActivePanes().map((p) => p.path)
  )

  const result: DiscoveredWorktree[] = []
  for (const block of blocks) {
    const lines = block.split('\n')
    let wtPath = ''
    let branch = ''

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice('worktree '.length).trim()
      } else if (line.startsWith('branch refs/heads/')) {
        branch = line.slice('branch refs/heads/'.length).trim()
      }
    }

    // Skip main worktree
    if (!wtPath || wtPath === projectRoot) continue
    // Skip bare worktrees (no branch)
    if (!branch) continue

    result.push({
      branch,
      path: wtPath,
      isTracked: trackedPaths.has(wtPath),
    })
  }

  return result
}

/**
 * Attach discovered worktrees as panes to an existing session.
 */
export function attachWorktrees(
  sessionId: string,
  tmuxName: string,
  worktrees: DiscoveredWorktree[],
  tool?: string
): WorktreePaneInfo[] {
  const effectiveTool = tool || 'claude'
  const created: WorktreePaneInfo[] = []

  for (const wt of worktrees) {
    if (wt.isTracked) continue
    if (!existsSync(wt.path)) continue

    try {
      const script = generateLaunchScript(effectiveTool, 'continue')
      const paneId = execSync(
        `tmux split-window -t "${tmuxName}" -h -c "${wt.path}" -P -F "#{pane_id}" "${script}"`,
        { encoding: 'utf-8' }
      ).trim()

      const id = uuid()
      wtRepo.saveWorktreePane({
        id,
        sessionId,
        paneId,
        branch: wt.branch,
        path: wt.path,
        baseBranch: '',
        tool: effectiveTool,
      })

      created.push({
        id,
        sessionId,
        paneId,
        branch: wt.branch,
        path: wt.path,
        baseBranch: '',
        tool: effectiveTool,
        mergeState: 'unknown',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    } catch (err) {
      console.error(`[worktree] Failed to attach worktree ${wt.path}:`, err)
    }
  }

  return created
}

/**
 * Prune worktree panes whose branches have been merged into base.
 * Returns list of pane IDs that were pruned.
 */
export function pruneMerged(sessionId: string): string[] {
  const panes = wtRepo.listPanesBySession(sessionId)
  const pruned: string[] = []

  for (const pane of panes) {
    if (pane.status !== 'active') continue

    // Check if branch is merged into its base
    if (pane.baseBranch && pane.path && existsSync(pane.path)) {
      try {
        // Get the project root from worktree path (parent of .worktrees/)
        const projectRoot = pane.path.replace(/\/\.worktrees\/[^/]+$/, '')
        execSync(
          `git -C "${projectRoot}" branch --merged "${pane.baseBranch}" | grep -q "^\\s*${pane.branch}$"`,
          { stdio: 'ignore' }
        )
        // If we get here, branch is merged
        wtRepo.updatePaneMergeState(pane.id, 'merged')
        wtRepo.updatePaneStatus(pane.id, 'done')
        pruned.push(pane.id)
      } catch {
        // Not merged — keep active
      }
    }
  }

  return pruned
}

/**
 * Restore worktree panes for a session on app restart.
 * For each active pane: if tmux pane is dead, split a new one and update the pane ID.
 * If the worktree path is gone, mark as 'done'.
 */
export function restorePanes(sessionId: string, tmuxName: string): void {
  const panes = wtRepo.listPanesBySession(sessionId)

  for (const pane of panes) {
    if (pane.status !== 'active') continue

    // Check if worktree path still exists
    if (!pane.path || !existsSync(pane.path)) {
      wtRepo.updatePaneStatus(pane.id, 'done')
      continue
    }

    // Check if tmux pane is alive
    if (pane.paneId && isPaneAlive(pane.paneId)) {
      continue // Already alive, nothing to do
    }

    // Pane is dead — split a new one
    try {
      const script = generateLaunchScript(pane.tool || 'claude', 'restore')
      const newPaneId = execSync(
        `tmux split-window -t "${tmuxName}" -h -c "${pane.path}" -P -F "#{pane_id}" "${script}"`,
        { encoding: 'utf-8' }
      ).trim()
      wtRepo.updatePanePaneId(pane.id, newPaneId)
      console.log(`[worktree] Restored pane for branch ${pane.branch}: ${newPaneId}`)
    } catch (err) {
      console.error(`[worktree] Failed to restore pane for ${pane.branch}:`, err)
    }
  }
}

/**
 * List all worktree panes for a session.
 */
export function listPanes(sessionId: string): WorktreePaneInfo[] {
  const panes = wtRepo.listPanesBySession(sessionId)
  // Auto-clean: remove panes whose worktree path no longer exists
  const result: WorktreePaneInfo[] = []
  for (const p of panes) {
    if (p.status === 'done' || p.status === 'stale') {
      if (!p.path || !existsSync(p.path)) {
        wtRepo.deleteWorktreePane(p.id)
        continue
      }
    }
    if (p.path && !existsSync(p.path)) {
      wtRepo.deleteWorktreePane(p.id)
      continue
    }
    result.push(rowToInfo(p))
  }
  return result
}

/**
 * Auto-register a discovered worktree (created externally, e.g. by an agent).
 * Does NOT create a tmux pane — just tracks it in DB for UI display and monitoring.
 */
export function autoRegisterWorktree(
  sessionId: string,
  wt: DiscoveredWorktree
): void {
  // Check by path to avoid race with UI-initiated createWorktreePane
  const existing = wtRepo.listPanesBySession(sessionId)
  if (existing.some(p => p.path === wt.path)) return

  // Derive projectRoot from worktree path (path = projectRoot/.worktrees/<branch>)
  const wtIdx = wt.path.indexOf('/.worktrees/')
  const projectRoot = wtIdx > 0 ? wt.path.slice(0, wtIdx) : ''

  // Symlink Claude project dir so worktree shares sessions with main repo
  if (projectRoot) {
    const claudeProjectsDir = join(homedir(), '.claude', 'projects')
    const mainEncoded = projectRoot.replace(/\//g, '-')
    const wtEncoded = wt.path.replace(/\//g, '-')
    const mainClaudeDir = join(claudeProjectsDir, mainEncoded)
    const wtClaudeDir = join(claudeProjectsDir, wtEncoded)
    try {
      if (!existsSync(mainClaudeDir)) mkdirSync(mainClaudeDir, { recursive: true })
      if (!existsSync(wtClaudeDir)) symlinkSync(mainClaudeDir, wtClaudeDir)
    } catch { /* ignore */ }

    // Symlink openspec dir
    const mainOpenspec = join(projectRoot, 'openspec')
    const wtOpenspec = join(wt.path, 'openspec')
    try {
      if (existsSync(mainOpenspec) && !existsSync(wtOpenspec)) {
        symlinkSync(mainOpenspec, wtOpenspec)
      }
    } catch { /* ignore */ }
  }

  // Detect base branch
  let baseBranch = 'main'
  try {
    execSync(`git -C "${wt.path}" rev-parse --verify main`, { stdio: 'ignore' })
  } catch {
    try {
      execSync(`git -C "${wt.path}" rev-parse --verify master`, { stdio: 'ignore' })
      baseBranch = 'master'
    } catch { /* keep main */ }
  }

  const id = uuid().slice(0, 8)
  wtRepo.saveWorktreePane({
    id,
    sessionId,
    paneId: '',
    branch: wt.branch,
    path: wt.path,
    baseBranch,
    tool: 'claude',
  })
}
