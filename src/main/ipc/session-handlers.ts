import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { IPC } from '@shared/types/ipc'
import { readdirSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import { log } from '../logger'
import * as tmux from '../tmux/session-manager'
import { generateLaunchScript, isToolInstalled, getInstallHint } from '../tmux/cli-wrapper'
import * as collab from '../mcp/collab-manager'
import * as sessionMcp from '../mcp/session-mcp-manager'
import * as sessionRepo from '../db/session-repo'
import * as worktreeManager from '../worktree/worktree-manager'
import type { SessionInfo } from '@shared/types/session'

/**
 * Find Claude session IDs in a project directory.
 * Claude stores sessions under ~/.claude/projects/<encoded-path>/
 */
function findClaudeSessions(projectDir: string): Array<{ id: string; summary: string; date: string }> {
  const sessions: Array<{ id: string; summary: string; date: string }> = []
  try {
    const claudeDir = join(homedir(), '.claude', 'projects')
    if (!existsSync(claudeDir)) return sessions

    // Claude encodes path: /Users/foo/bar → -Users-foo-bar
    const encodedPath = projectDir.replace(/\//g, '-')

    // Find matching project directories
    const projectDirs = readdirSync(claudeDir).filter((d) => d === encodedPath)
    if (projectDirs.length === 0) return sessions

    for (const dir of projectDirs) {
      const projPath = join(claudeDir, dir)

      // Session .jsonl files are directly in the project dir (not in a sessions/ subfolder)
      const fs = require('fs')
      const files = readdirSync(projPath)
        .filter((f: string) => f.endsWith('.jsonl'))
        .map((f: string) => ({
          name: f,
          mtime: fs.statSync(join(projPath, f)).mtime.getTime()
        }))
        .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime) // newest first
        .slice(0, 5)

      for (const file of files) {
        const id = file.name.replace('.jsonl', '')
        let summary = ''
        let customTitle = ''
        try {
          const content = fs.readFileSync(join(projPath, file.name), 'utf-8')
          for (const line of content.split('\n')) {
            if (!line.trim()) continue
            try {
              const parsed = JSON.parse(line)
              // Prefer custom-title
              if (parsed.type === 'custom-title' && parsed.customTitle) {
                customTitle = parsed.customTitle
              }
              // First user message as fallback summary
              if (!summary && parsed.type === 'user') {
                let text = parsed.message?.content
                if (Array.isArray(text)) {
                  text = text.find((c: any) => c.type === 'text')?.text || ''
                }
                if (typeof text === 'string' && text) {
                  summary = text.slice(0, 60)
                }
              }
              // Stop early once we have both
              if (customTitle && summary) break
            } catch { /* skip bad line */ }
          }
        } catch { /* ignore */ }

        const displaySummary = customTitle || summary || id.slice(0, 8)
        const date = new Date(file.mtime).toISOString().slice(0, 16).replace('T', ' ')
        sessions.push({ id, summary: displaySummary, date })
      }
    }
  } catch { /* ignore */ }
  return sessions
}

let statusBarsInitialized = false

function ensureReady(tool: string): void {
  if (!tmux.hasTmux()) {
    log('session', 'ensureReady failed: tmux not found')
    throw new Error('tmux 未安装。请先安装: brew install tmux')
  }
  if (!isToolInstalled(tool)) {
    log('session', `ensureReady failed: ${tool} not found`)
    throw new Error(`${tool} 未安装。${getInstallHint(tool)}`)
  }
}

export function registerSessionHandlers(): void {
  // Keep MCP runtime scripts in sync with latest source at app boot.
  collab.ensureRuntimeArtifacts()

  // Open a path in Finder
  ipcMain.handle('shell:open-path', (_event, p: string) => shell.openPath(p))

  // Create new tmux session and open terminal
  ipcMain.handle(IPC.SESSION_CREATE, (_event, tool: string, firstMessage?: string) => {
    ensureReady(tool || 'claude')

    const script = generateLaunchScript(tool || 'claude', 'new')
    const session = tmux.createTmuxSession(tool || 'claude', firstMessage, undefined, script)
    sessionRepo.saveSession(session)
    try {
      sessionMcp.injectSessionMcp(session.id, session.cwd, session.tmuxName, session.title, '', '', session.tool)
      collab.watchInbox(session.id, session.tmuxName, session.tool)
    } catch (e) { log('session', 'mcp inject failed (non-fatal):', e) }
    tmux.attachSession(session.tmuxName)
    return toSessionInfo(session)
  })

  // Step 1: Pick directory and detect existing Claude sessions
  ipcMain.handle(IPC.SESSION_CREATE_IN_DIR, async (_event, tool: string) => {
    ensureReady(tool || 'claude')

    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const result = win
      ? await dialog.showOpenDialog(win, { title: '选择项目目录', properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ title: '选择项目目录', properties: ['openDirectory'] })

    if (result.canceled || result.filePaths.length === 0) return null

    const dir = result.filePaths[0]
    const existingSessions = tool === 'claude' ? findClaudeSessions(dir) : []
    const isGitRepo = isGitRepository(dir)

    if (existingSessions.length > 0 || isGitRepo) {
      return { type: 'pick' as const, dir, sessions: existingSessions, isGitRepo }
    }

    // No existing sessions — create new directly
    const script = generateLaunchScript(tool || 'claude', 'new')
    const session = tmux.createTmuxSession(tool || 'claude', undefined, dir, script)
    sessionRepo.saveSession(session)
    tmux.attachSession(session.tmuxName)
    return { type: 'created' as const, session: toSessionInfo(session) }
  })

  // Step 2: Start session in dir with optional resume
  ipcMain.handle('session:create-in-dir-confirm', (_event, tool: string, dir: string, resumeId?: string) => {
    let mode: 'new' | 'continue' | 'resume'
    if (resumeId === '__new__') mode = 'new'
    else if (resumeId) mode = 'resume'
    else mode = 'continue'

    const script = generateLaunchScript(tool || 'claude', mode, resumeId === '__new__' ? undefined : resumeId || undefined)
    const session = tmux.createTmuxSession(tool || 'claude', undefined, dir, script)
    sessionRepo.saveSession(session)
    try {
      sessionMcp.injectSessionMcp(session.id, dir, session.tmuxName, session.title, '', '', session.tool)
      collab.watchInbox(session.id, session.tmuxName, session.tool)
    } catch (e) { log('session', 'mcp inject failed (non-fatal):', e) }
    tmux.attachSession(session.tmuxName)
    return toSessionInfo(session)
  })

  // Create worktree and start session in it
  ipcMain.handle('session:create-worktree', (_event, tool: string, dir: string, branch: string, resumeId?: string) => {
    // Validate branch name
    const safeBranch = branch.replace(/[^a-zA-Z0-9/_.-]/g, '-')
    if (!safeBranch) throw new Error('无效的分支名')

    // Create worktree inside repo: .worktrees/branch-name
    const worktreePath = join(dir, '.worktrees', safeBranch.replace(/\//g, '-'))

    try {
      // Check if branch already exists
      try {
        execSync(`git -C "${dir}" rev-parse --verify "${safeBranch}"`, { stdio: 'ignore' })
        // Branch exists — create worktree from existing branch
        execSync(`git -C "${dir}" worktree add "${worktreePath}" "${safeBranch}"`, {
          stdio: 'ignore'
        })
      } catch {
        // Branch doesn't exist — create new branch
        execSync(`git -C "${dir}" worktree add -b "${safeBranch}" "${worktreePath}"`, {
          stdio: 'ignore'
        })
      }
    } catch (err: any) {
      throw new Error(`worktree 创建失败: ${err.message}`)
    }

    // Ensure .worktrees is in .gitignore
    const fs = require('fs')
    const gitignorePath = join(dir, '.gitignore')
    try {
      const content = existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : ''
      if (!content.split('\n').some((l: string) => l.trim() === '.worktrees')) {
        fs.appendFileSync(gitignorePath, `${content.endsWith('\n') ? '' : '\n'}.worktrees\n`)
      }
    } catch { /* ignore */ }

    // Symlink Claude project dir so worktree shares sessions with main repo
    // Claude encodes path: /Users/foo/bar → -Users-foo-bar
    const claudeProjectsDir = join(homedir(), '.claude', 'projects')
    const mainEncoded = dir.replace(/\//g, '-')
    const wtEncoded = worktreePath.replace(/\//g, '-')
    const mainClaudeDir = join(claudeProjectsDir, mainEncoded)
    const wtClaudeDir = join(claudeProjectsDir, wtEncoded)
    try {
      // Ensure main project dir exists
      if (!existsSync(mainClaudeDir)) {
        fs.mkdirSync(mainClaudeDir, { recursive: true })
      }
      // Create symlink: worktree claude dir → main claude dir
      if (!existsSync(wtClaudeDir)) {
        fs.symlinkSync(mainClaudeDir, wtClaudeDir)
      }
    } catch { /* ignore — sessions just won't be shared */ }

    // Symlink openspec dir so worktree shares specs/changes with main repo
    const mainOpenspec = join(dir, 'openspec')
    const wtOpenspec = join(worktreePath, 'openspec')
    try {
      if (existsSync(mainOpenspec) && !existsSync(wtOpenspec)) {
        fs.symlinkSync(mainOpenspec, wtOpenspec)
      }
    } catch { /* ignore */ }

    // Start session in the worktree directory
    const script = generateLaunchScript(
      tool || 'claude',
      resumeId ? 'resume' : 'continue',
      resumeId || undefined
    )
    const session = tmux.createTmuxSession(tool || 'claude', undefined, worktreePath, script)
    sessionRepo.saveSession(session)
    sessionMcp.injectSessionMcp(session.id, worktreePath, session.tmuxName, session.title, '', '', session.tool)
    collab.watchInbox(session.id, session.tmuxName, session.tool)
    tmux.attachSession(session.tmuxName)
    return toSessionInfo(session)
  })

  // Import existing tmux sessions (non-kitty ones)
  ipcMain.handle(IPC.SESSION_IMPORT, () => {
    const allSessions = tmux.listAllTmuxSessions()
    const tracked = new Set(sessionRepo.listSessions().map((s) => s.tmuxName))

    const untracked = allSessions.filter((s) => !tracked.has(s.name))
    if (untracked.length === 0) return []

    const imported: SessionInfo[] = []
    for (const s of untracked) {
      const session = tmux.importTmuxSession(s.name)
      session.status = s.attached ? 'running' : 'detached'
      sessionRepo.saveSession(session)
      imported.push(toSessionInfo(session))
    }
    return imported
  })

  // List all sessions with live status sync
  ipcMain.handle(IPC.SESSION_LIST, () => {
    return syncAndList()
  })

  // Re-attach to existing session (skip if already attached via kitty)
  ipcMain.handle(IPC.SESSION_ATTACH, (_event, id: string) => {
    const rows = sessionRepo.listSessions()
    const session = rows.find((s) => s.id === id)
    if (!session) throw new Error('Session not found')

    if (!tmux.isSessionAlive(session.tmuxName)) {
      sessionRepo.updateSessionStatus(id, 'dead')
      return false
    }

    if (tmux.isSessionAttached(session.tmuxName)) {
      // Focus the existing Ghostty window and switch tmux client to this session
      tmux.focusSession(session.tmuxName)
      return true
    }

    // If any other tmux client is connected, switch it instead of opening a new window
    if (tmux.hasAnyAttachedClient()) {
      tmux.focusSession(session.tmuxName)
      return true
    }

    tmux.attachSession(session.tmuxName)
    return true
  })

  // Kill a session
  ipcMain.handle(IPC.SESSION_KILL, (_event, id: string) => {
    const rows = sessionRepo.listSessions()
    const session = rows.find((s) => s.id === id)
    if (session) {
      sessionMcp.removeSessionMcp(session.id, session.cwd)
      tmux.killSession(session.tmuxName)
      sessionRepo.deleteSession(id)
    }
    return { success: true }
  })

  // Rename a session
  ipcMain.handle('session:rename', (_event, id: string, title: string) => {
    sessionRepo.updateSessionTitle(id, title)
    return { success: true }
  })

  // Change a session CLI tool and restart the tmux command in-place.
  ipcMain.handle('session:set-tool', (_event, id: string, tool: string) => {
    const nextTool = (tool || '').trim()
    if (!['claude', 'codex', 'shell'].includes(nextTool)) {
      throw new Error(`Unsupported tool: ${tool}`)
    }
    ensureReady(nextTool)

    const rows = sessionRepo.listSessions()
    const session = rows.find((s) => s.id === id)
    if (!session) throw new Error('Session not found')
    if (session.tool === nextTool) return { success: true }

    if (tmux.isSessionAlive(session.tmuxName)) {
      restartSessionTool(session.tmuxName, session.mainPane || '0.0', session.tool, nextTool)
    }
    sessionRepo.updateSessionTool(id, nextTool)

    // Re-inject MCP after tool switch
    sessionMcp.removeSessionMcp(id, session.cwd)
    const grp = session.groupId ? sessionRepo.getGroupById(session.groupId) : undefined
    sessionMcp.injectSessionMcp(session.id, session.cwd, session.tmuxName, session.title, session.groupId || '', grp?.name || '', nextTool)
    collab.watchInbox(session.id, session.tmuxName, nextTool)

    return { success: true }
  })

  // Restart current session agent process in-place.
  // For codex this uses --yolo restart path, and if group collaboration is enabled
  // env injection is re-applied automatically.
  ipcMain.handle('session:restart-agent', (_event, id: string) => {
    const rows = sessionRepo.listSessions()
    const session = rows.find((s) => s.id === id)
    if (!session) throw new Error('Session not found')
    if (!tmux.isSessionAlive(session.tmuxName)) {
      sessionRepo.updateSessionStatus(id, 'dead')
      throw new Error('Session is not running')
    }
    // Run in background to avoid blocking UI
    setTimeout(() => {
      try {
        collab.restartSessionAgent(
          session.id,
          session.title,
          session.groupId || null,
          session.cwd,
          session.tmuxName,
          session.tool,
          true
        )
      } catch (err) {
        log('session', `restart-agent failed for ${id}:`, err)
      }
    }, 0)
    return { success: true }
  })

  // Delete a Claude session file
  ipcMain.handle('session:delete-claude-session', (_event, projectDir: string, sessionId: string) => {
    const fs = require('fs')
    const encodedPath = projectDir.replace(/\//g, '-')
    const claudeDir = join(homedir(), '.claude', 'projects')
    const projPath = join(claudeDir, encodedPath)
    const filePath = join(projPath, `${sessionId}.jsonl`)
    if (existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
    // Also remove directory if it exists (session folder)
    const dirPath = join(projPath, sessionId)
    if (existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true })
    }
    return { success: true }
  })

  // Sync tmux state with DB
  ipcMain.handle(IPC.SESSION_SYNC, () => {
    return syncAndList()
  })

  // --- Group management ---
  ipcMain.handle('group:list', () => {
    return sessionRepo.listGroups().map((g) => ({
      ...g,
      collabEnabled: Boolean(g.collabEnabled),
    }))
  })

  ipcMain.handle('group:create', (_event, name: string, color?: string) => {
    const { v4: uuid } = require('uuid')
    const id = uuid().slice(0, 8)
    sessionRepo.createGroup(id, name, color)
    return { id, name, color, collabEnabled: false }
  })

  ipcMain.handle('group:delete', (_event, groupId: string) => {
    for (const session of sessionRepo.listSessionsByGroup(groupId)) {
      sessionMcp.updateGroupId(session.id, session.cwd, '', '')
    }
    sessionRepo.deleteGroup(groupId)
  })

  ipcMain.handle('group:rename', (_event, groupId: string, name: string) => {
    sessionRepo.renameGroup(groupId, name)
  })

  ipcMain.handle('session:set-group', (_event, sessionId: string, groupId: string | null) => {
    const rows = sessionRepo.listSessions()
    const session = rows.find((s) => s.id === sessionId)
    if (!session) throw new Error('Session not found')

    sessionRepo.updateSessionGroup(sessionId, groupId)

    const nextGroup = groupId ? sessionRepo.getGroupById(groupId) : undefined
    sessionMcp.updateGroupId(sessionId, session.cwd, groupId || '', nextGroup?.name || '')
  })

  // --- Collaboration (MCP) ---
  ipcMain.handle('collab:status', (_event, sessionId: string) => {
    const rows = sessionRepo.listSessions()
    const session = rows.find(s => s.id === sessionId)
    if (!session) throw new Error('Session not found')
    const active = sessionMcp.hasSessionMcp(sessionId)
    return { active }
  })
}

/**
 * Sync tmux session states with our DB and return updated list.
 * On first sync, auto-restore sessions that were previously alive.
 */
function syncAndList(): SessionInfo[] {
  const liveSessions = tmux.listAllTmuxSessions()
  const liveNames = new Set(liveSessions.map((s) => s.name))
  const liveAttached = new Map(liveSessions.map((s) => [s.name, s.attached]))

  const dbSessions = sessionRepo.listSessions()

  // On first sync, restore sessions that were previously alive
  if (!statusBarsInitialized) {
    statusBarsInitialized = true

    for (const row of dbSessions) {
      // Restore any session whose tmux is gone but cwd still exists
      // (includes 'dead' from previous crash — only user-kill deletes from DB entirely)
      if (!liveNames.has(row.tmuxName) && row.cwd && existsSync(row.cwd)) {
        try {
          // Use wrapper to restore: try continue → new → shell fallback
          const script = generateLaunchScript(row.tool, 'restore')

          execSync(
            `tmux new-session -d -s "${row.tmuxName}" -c "${row.cwd}" "${script}"`,
            { stdio: 'ignore', env: { ...process.env, TERM: 'xterm-256color' } }
          )
          tmux.applyKittyStatusBar(row.tmuxName)
          sessionRepo.updateSessionStatus(row.id, 'detached')
          liveNames.add(row.tmuxName)
          console.log(`[restore] Rebuilt session: ${row.title} (${row.tmuxName})`)
        } catch (err) {
          console.error(`[restore] Failed to restore ${row.tmuxName}:`, err)
          sessionRepo.updateSessionStatus(row.id, 'dead')
        }
      }
    }

      // Restore worktree panes for all live sessions
      for (const row of sessionRepo.listSessions()) {
        if (liveNames.has(row.tmuxName)) {
          try {
            worktreeManager.restorePanes(row.id, row.tmuxName)
          } catch (err) {
            console.error(`[restore] Failed to restore worktree panes for ${row.tmuxName}:`, err)
          }
        }
      }

    // Apply status bar to all live sessions
    for (const name of liveNames) {
      tmux.applyKittyStatusBar(name)
    }

    // Start inbox watcher for all live sessions with cwd
    for (const row of sessionRepo.listSessions()) {
      if (liveNames.has(row.tmuxName) && row.cwd) {
        const group = row.groupId ? sessionRepo.getGroupById(row.groupId) : undefined
        sessionMcp.injectSessionMcp(row.id, row.cwd, row.tmuxName, row.title, row.groupId || '', group?.name || '', row.tool)
        collab.watchInbox(row.id, row.tmuxName, row.tool)
      }
    }
    collab.cleanupStaleAgents(new Set(sessionRepo.listSessions().filter(r => liveNames.has(r.tmuxName)).map(r => r.id)))
  }

  // Normal sync: update status based on tmux state
  // tmux gone → keep as 'detached' (restorable on next launch), NOT 'dead'
  // Only user-initiated kill sets 'dead'
  const refreshedLive = tmux.listAllTmuxSessions()
  const refreshedNames = new Set(refreshedLive.map((s) => s.name))
  const refreshedAttached = new Map(refreshedLive.map((s) => [s.name, s.attached]))

  for (const row of sessionRepo.listSessions()) {
    if (refreshedNames.has(row.tmuxName)) {
      // tmux session is alive — always update status from tmux state
      if (refreshedAttached.get(row.tmuxName)) {
        sessionRepo.updateSessionStatus(row.id, 'running')
      } else {
        sessionRepo.updateSessionStatus(row.id, 'detached')
      }
    } else if (row.status === 'running') {
      // Was running but tmux gone — mark detached (restorable), not dead
      sessionRepo.updateSessionStatus(row.id, 'detached')
    }
    // dead or detached without tmux: keep as-is
  }

  // Auto-discover worktrees created by agents (e.g. via git worktree add)
  for (const row of sessionRepo.listSessions()) {
    if (!row.cwd) continue
    // Only check repos that have a .worktrees/ directory
    if (!existsSync(join(row.cwd, '.worktrees'))) continue
    try {
      const discovered = worktreeManager.discoverWorktrees(row.cwd)
      for (const wt of discovered) {
        // Only auto-track worktrees under .worktrees/
        if (wt.isTracked) continue
        if (!wt.path.startsWith(join(row.cwd, '.worktrees'))) continue
        // Register with empty paneId (no kitty-managed tmux pane)
        worktreeManager.autoRegisterWorktree(row.id, wt)
      }
    } catch { /* ignore discovery errors */ }
  }

  const result = sessionRepo.listSessions().map((row) => ({
    id: row.id,
    tmuxName: row.tmuxName,
    title: row.title,
    tool: row.tool,
    cwd: row.cwd,
    mainPane: row.mainPane || '0.0',
    status: row.status as SessionInfo['status'],
    createdAt: row.createdAt,
    groupId: row.groupId || undefined,
    groupName: row.groupName || undefined,
    groupColor: row.groupColor || undefined,
    isGitRepo: row.cwd ? isGitRepository(row.cwd) : false,
    worktreePanes: worktreeManager.listPanes(row.id),
  }))
  log('sync', result.map(r => `${r.title}:${r.status}`).join(', '))
  return result
}

function isGitRepository(dir: string): boolean {
  try {
    execSync(`git -C "${dir}" rev-parse --git-dir`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function toSessionInfo(s: tmux.TmuxSession): SessionInfo {
  return {
    id: s.id,
    tmuxName: s.tmuxName,
    title: s.title,
    tool: s.tool,
    cwd: s.cwd,
    mainPane: '0.0',
    status: s.status,
    createdAt: s.createdAt,
    isGitRepo: s.cwd ? isGitRepository(s.cwd) : false,
    worktreePanes: worktreeManager.listPanes(s.id),
  }
}

function restartSessionTool(tmuxName: string, mainPane: string, prevTool: string, nextTool: string): void {
  const target = resolvePaneTarget(tmuxName, mainPane)
  try {
    if (prevTool === 'claude') {
      execSync(`${tmux.TMUX} send-keys -t "${target}" "/exit" Enter`, { stdio: 'ignore' })
    } else {
      execSync(`${tmux.TMUX} send-keys -t "${target}" C-c`, { stdio: 'ignore' })
    }
    waitForPaneShell(target, 12000)
  } catch {
    forceStopPaneForegroundProcess(target)
    waitForPaneShell(target, 5000)
  }

  const launch = generateLaunchScript(nextTool, 'continue')
  const escaped = launch.replace(/"/g, '\\"')
  execSync(`${tmux.TMUX} send-keys -t "${target}" "${escaped}" Enter`, { stdio: 'ignore' })
}

function waitForPaneShell(tmuxTarget: string, timeoutMs: number): void {
  const shellCommands = new Set(['zsh', 'bash', 'fish', 'sh', 'login'])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const current = execSync(
        `${tmux.TMUX} display-message -p -t "${tmuxTarget}" "#{pane_current_command}"`,
        { encoding: 'utf-8' }
      ).trim()
      if (shellCommands.has(current)) return
    } catch {
      // Keep polling: pane can be mid-transition while command exits.
    }
    execSync('sleep 0.2', { stdio: 'ignore' })
  }
  throw new Error(`Timed out waiting for tmux pane "${tmuxTarget}" to return to shell`)
}

function forceStopPaneForegroundProcess(tmuxTarget: string): void {
  try {
    execSync(`${tmux.TMUX} send-keys -t "${tmuxTarget}" C-c`, { stdio: 'ignore' })
  } catch { /* ignore */ }
  let panePid = ''
  try {
    panePid = execSync(`${tmux.TMUX} display-message -p -t "${tmuxTarget}" "#{pane_pid}"`, { encoding: 'utf-8' }).trim()
  } catch { /* ignore */ }
  if (!panePid) return

  let childPids: string[] = []
  try {
    childPids = execSync(`pgrep -P "${panePid}" || true`, { encoding: 'utf-8' })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  } catch { /* ignore */ }
  if (!childPids.length) return

  for (const pid of childPids) {
    try { execSync(`kill -TERM ${pid}`, { stdio: 'ignore' }) } catch { /* ignore */ }
  }
  execSync('sleep 0.3', { stdio: 'ignore' })
  for (const pid of childPids) {
    try { execSync(`kill -0 ${pid}`, { stdio: 'ignore' }); execSync(`kill -KILL ${pid}`, { stdio: 'ignore' }) } catch { /* ignore */ }
  }
}

function resolvePaneTarget(tmuxName: string, mainPane: string): string {
  const pane = (mainPane || '0.0').trim()
  if (!pane) return `${tmuxName}:0.0`
  if (pane.startsWith('%')) return pane
  if (pane.includes(':')) return pane
  return `${tmuxName}:${pane}`
}
