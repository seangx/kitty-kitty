import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { IPC } from '@shared/types/ipc'
import { readdirSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import { v4 as uuid } from 'uuid'
import { log } from '../logger'
import * as tmux from '../tmux/session-manager'
import { generateLaunchScript, isToolInstalled, getInstallHint, getPaneMode } from '../tmux/cli-wrapper'
import * as sessionMcp from '../mcp/session-mcp-manager'
import * as sessionRepo from '../db/session-repo'
import { getDB } from '../db/database'
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
  // Open a path in Finder
  ipcMain.handle('shell:open-path', (_event, p: string) => shell.openPath(p))

  // Create new tmux session and open terminal
  ipcMain.handle(IPC.SESSION_CREATE, (_event, tool: string, firstMessage?: string) => {
    ensureReady(tool || 'claude')

    const script = generateLaunchScript(tool || 'claude', 'new')
    const session = tmux.createTmuxSession(tool || 'claude', firstMessage, undefined, script)
    sessionRepo.saveSession(session)
    try {
      sessionMcp.injectSessionMcp(session.id, session.cwd, session.tmuxName, session.title)
    } catch (e) { log('session', 'mcp inject failed (non-fatal):', e) }
    tmux.attachSession(session.tmuxName)
    return toSessionInfo(session)
  })

  // Step 1: Pick directory and detect existing Claude sessions
  ipcMain.handle(IPC.SESSION_CREATE_IN_DIR, async (_event, tool: string) => {
    ensureReady(tool || 'claude')

    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const result = win
      ? await dialog.showOpenDialog(win, { title: '选择项目目录', properties: ['openDirectory', 'showHiddenFiles'] })
      : await dialog.showOpenDialog({ title: '选择项目目录', properties: ['openDirectory', 'showHiddenFiles'] })

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
      sessionMcp.injectSessionMcp(session.id, dir, session.tmuxName, session.title)
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
    sessionMcp.injectSessionMcp(session.id, worktreePath, session.tmuxName, session.title)
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
      // In pane mode, this session may exist as a pane in its group's host session
      if (getPaneMode() && session.groupId) {
        const groupSessions = sessionRepo.listSessionsByGroup(session.groupId)
          .filter(s => tmux.isSessionAlive(s.tmuxName))
        const hostSession = groupSessions[0]
        if (hostSession) {
          tmux.focusSession(hostSession.tmuxName)
          return true
        }
      }
      sessionRepo.updateSessionStatus(id, 'dead')
      return false
    }

    if (tmux.isSessionAttached(session.tmuxName)) {
      log('session', `attach ${id}: already attached, focusing`)
      tmux.focusSession(session.tmuxName)
      return true
    }

    if (tmux.hasAnyAttachedClient()) {
      log('session', `attach ${id}: switching client`)
      tmux.focusSession(session.tmuxName)
      return true
    }

    log('session', `attach ${id}: no client, opening new terminal`)
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

  ipcMain.handle('session:set-roles', (_event, id: string, roles: string) => {
    sessionRepo.updateSessionRoles(id, roles)
    return { success: true }
  })

  ipcMain.handle('session:set-expertise', (_event, id: string, expertise: string) => {
    sessionRepo.updateSessionExpertise(id, expertise)
    return { success: true }
  })

  // Aggregate handler: set roles + expertise, re-inject .mcp.json.
  ipcMain.handle('session:set-agent-metadata', (_event, id: string, roles: string, expertise: string) => {
    sessionRepo.updateSessionRoles(id, roles)
    sessionRepo.updateSessionExpertise(id, expertise)

    const session = sessionRepo.listSessions().find(s => s.id === id)
    if (!session) throw new Error('Session not found')

    // Re-inject .mcp.json with new roles/expertise
    try {
      sessionMcp.removeSessionMcp(id, session.cwd)
      sessionMcp.injectSessionMcp(id, session.cwd, session.tmuxName, session.title)
    } catch (err) {
      log('session', `metadata inject failed for ${id}:`, err)
    }

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
    sessionMcp.injectSessionMcp(session.id, session.cwd, session.tmuxName, session.title)

    return { success: true }
  })

  // Restart current session agent process in-place.
  ipcMain.handle('session:restart-agent', (_event, id: string) => {
    const rows = sessionRepo.listSessions()
    const session = rows.find((s) => s.id === id)
    if (!session) throw new Error('Session not found')
    if (!tmux.isSessionAlive(session.tmuxName)) {
      sessionRepo.updateSessionStatus(id, 'dead')
      throw new Error('Session is not running')
    }
    log('session', `restart-agent: not implemented, session=${id}`)
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

  ipcMain.handle('group:set-color', (_event, groupId: string, color: string | null) => {
    sessionRepo.updateGroupColor(groupId, color)
  })

  ipcMain.handle('session:set-group', (_event, sessionId: string, groupId: string | null) => {
    const rows = sessionRepo.listSessions()
    const session = rows.find((s) => s.id === sessionId)
    if (!session) throw new Error('Session not found')

    const oldGroupId = session.groupId

    const nextGroup = groupId ? sessionRepo.getGroupById(groupId) : undefined
    sessionMcp.updateGroupId(sessionId, session.cwd, groupId || '', nextGroup?.name || '')

    // In pane mode, move the pane between group tmux sessions
    if (getPaneMode()) {
      // Find the actual tmux session hosting this session's pane
      let hostTmux = session.tmuxName
      if (!tmux.isSessionAlive(hostTmux) && oldGroupId) {
        const oldGroupSessions = sessionRepo.listSessionsByGroup(oldGroupId)
          .filter(s => tmux.isSessionAlive(s.tmuxName))
        if (oldGroupSessions.length > 0) hostTmux = oldGroupSessions[0].tmuxName
      }

      if (tmux.isSessionAlive(hostTmux)) {
      try {
        // Use stored paneId for precise matching
        const sourcePaneId = session.paneId || ''

        if (sourcePaneId && groupId) {
          const targetGroupSessions = sessionRepo.listSessionsByGroup(groupId)
            .filter(s => !s.hidden && s.id !== sessionId && tmux.isSessionAlive(s.tmuxName))
          const targetHost = targetGroupSessions[0]

          if (targetHost) {
            const targetPanes = execSync(
              `${tmux.TMUX} list-panes -t "${targetHost.tmuxName}" -F '#{pane_id}'`,
              { encoding: 'utf-8' }
            ).trim().split('\n')
            const targetLastPane = targetPanes[targetPanes.length - 1]
            execSync(`${tmux.TMUX} join-pane -s ${sourcePaneId} -t ${targetLastPane} -v`, { stdio: 'ignore' })
            // Query new pane ID after join
            const newPanes = execSync(
              `${tmux.TMUX} list-panes -t "${targetHost.tmuxName}" -F '#{pane_id}'`,
              { encoding: 'utf-8' }
            ).trim().split('\n')
            sessionRepo.updateSessionPaneId(sessionId, newPanes[newPanes.length - 1])
            const db = getDB()
            db.prepare("UPDATE sessions SET tmux_name = ? WHERE id = ?").run(targetHost.tmuxName, sessionId)
            tmux.applyMainVerticalLayout(targetHost.tmuxName)
            if (tmux.isSessionAlive(hostTmux) && tmux.getPaneCount(hostTmux) > 1) {
              tmux.applyMainVerticalLayout(hostTmux)
            }
          } else {
            const newName = `kitty_${uuid().slice(0, 8)}`
            execSync(`${tmux.TMUX} break-pane -d -s ${sourcePaneId}`, { stdio: 'ignore' })
            const db = getDB()
            db.prepare("UPDATE sessions SET tmux_name = ? WHERE id = ?").run(newName, sessionId)
            sessionRepo.updateSessionPaneId(sessionId, '')
          }
        } else if (sourcePaneId && !groupId) {
          const newName = `kitty_${uuid().slice(0, 8)}`
          execSync(`${tmux.TMUX} break-pane -d -s ${sourcePaneId}`, { stdio: 'ignore' })
          const db = getDB()
          db.prepare("UPDATE sessions SET tmux_name = ? WHERE id = ?").run(newName, sessionId)
          sessionRepo.updateSessionPaneId(sessionId, '')
        }
      } catch (err) {
        log('pane-mode', `move pane between groups failed:`, err)
      }
      } // end if (tmux.isSessionAlive(hostTmux))
    }

    // Move DB group update AFTER tmux operations succeed
    sessionRepo.updateSessionGroup(sessionId, groupId)

    tmux.refreshAllStatusBars()
  })

  ipcMain.handle('session:set-hidden', (_event, sessionId: string, hidden: boolean) => {
    const session = sessionRepo.listSessions().find(s => s.id === sessionId)
    sessionRepo.updateSessionHidden(sessionId, hidden)

    // In pane mode, kill/restore the corresponding pane
    if (getPaneMode() && session) {
      if (hidden) {
        // Kill pane by stored paneId
        if (session.paneId) {
          const groupSessions = session.groupId
            ? sessionRepo.listSessionsByGroup(session.groupId).filter(s => tmux.isSessionAlive(s.tmuxName))
            : []
          const hostTmux = groupSessions[0]?.tmuxName || session.tmuxName
          if (tmux.isSessionAlive(hostTmux)) {
            try {
              execSync(`${tmux.TMUX} kill-pane -t ${session.paneId}`, { stdio: 'ignore' })
              if (tmux.getPaneCount(hostTmux) > 1) {
                tmux.applyMainVerticalLayout(hostTmux)
              }
            } catch { /* ignore */ }
          }
        }
      } else {
        // Unhide: restore pane into the group's host tmux session
        if (session.groupId) {
          const groupSessions = sessionRepo.listSessionsByGroup(session.groupId)
            .filter(s => s.id !== sessionId && !s.hidden && tmux.isSessionAlive(s.tmuxName))
          const hostTmux = groupSessions[0]?.tmuxName
          if (hostTmux && session.cwd && existsSync(session.cwd)) {
            try {
              const tempName = `kitty_tmp_${Date.now()}`
              const script = generateLaunchScript('claude', 'restore')
              execSync(
                `${tmux.TMUX} new-session -d -s "${tempName}" -c "${session.cwd}" "${script}"`,
                { stdio: 'ignore', env: { ...process.env, TERM: 'xterm-256color' } }
              )
              tmux.joinSessionAsPane(tempName, hostTmux)
              // Save the new paneId
              const newPanes = execSync(
                `${tmux.TMUX} list-panes -t "${hostTmux}" -F '#{pane_id}'`,
                { encoding: 'utf-8' }
              ).trim().split('\n')
              sessionRepo.updateSessionPaneId(sessionId, newPanes[newPanes.length - 1])
              const db = getDB()
              db.prepare("UPDATE sessions SET tmux_name = ? WHERE id = ?").run(hostTmux, sessionId)
            } catch (err) {
              log('pane-mode', `unhide restore pane failed:`, err)
            }
          }
        }
      }
    }

    tmux.refreshAllStatusBars()
  })

  // --- Pane mode ---
  ipcMain.handle(IPC.PANE_MODE_GET, () => {

    return getPaneMode()
  })

  ipcMain.handle(IPC.PANE_MODE_SET, (_event, enabled: boolean) => {
    const { readFileSync, writeFileSync, mkdirSync } = require('fs')
    const configPath = join(homedir(), '.kitty-kitty', 'config.json')

    let config: any = {}
    try { config = JSON.parse(readFileSync(configPath, 'utf-8')) } catch { /* ignore */ }
    config.paneMode = enabled
    mkdirSync(join(homedir(), '.kitty-kitty'), { recursive: true })
    writeFileSync(configPath, JSON.stringify(config, null, 2))

    if (enabled) {
      migrateToPane()
    } else {
      migrateToSession()
      // Restore merged sessions: give them unique tmux names, then recreate
      // Sessions that were joined share the same tmux_name — assign new ones
      const db = getDB()
      const dupes = db.prepare(`
        SELECT id, tmux_name FROM sessions
        WHERE tmux_name IN (
          SELECT tmux_name FROM sessions GROUP BY tmux_name HAVING COUNT(*) > 1
        )
      `).all() as Array<{ id: string; tmux_name: string }>
      const seen = new Set<string>()
      for (const row of dupes) {
        if (seen.has(row.tmux_name)) {
          // This is a duplicate — give it a new unique tmux name
      
          const newName = `kitty_${uuid().slice(0, 8)}`
          db.prepare("UPDATE sessions SET tmux_name = ? WHERE id = ?").run(newName, row.id)
          log('pane-mode', `reassigned tmux_name for ${row.id}: ${row.tmux_name} → ${newName}`)
        } else {
          seen.add(row.tmux_name)
        }
      }

      const liveNames = new Set(tmux.listTmuxSessions().map(s => s.name))
      for (const row of sessionRepo.listSessions()) {
        if (!liveNames.has(row.tmuxName) && row.cwd && existsSync(row.cwd) && !row.hidden) {
          try {
            const script = generateLaunchScript(row.tool, 'restore')
            execSync(
              `${tmux.TMUX} new-session -d -s "${row.tmuxName}" -c "${row.cwd}" "${script}"`,
              { stdio: 'ignore', env: { ...process.env, TERM: 'xterm-256color' } }
            )
            tmux.applyKittyStatusBar(row.tmuxName)
            sessionRepo.updateSessionStatus(row.id, 'detached')
            log('pane-mode', `restored session: ${row.title} (${row.tmuxName})`)
          } catch (err) {
            log('pane-mode', `restore failed for ${row.tmuxName}:`, err)
          }
        }
      }
    }

    // Re-apply status bar to ALL live sessions (mode changed, need fresh config)
    const allLive = tmux.listTmuxSessions()
    for (const s of allLive) {
      tmux.applyKittyStatusBar(s.name)
    }
    tmux.refreshAllStatusBars()
    return { success: true }
  })

  ipcMain.handle(IPC.SESSION_CREATE_IN_GROUP, (_event, groupId: string) => {

    ensureReady('claude')

    const group = sessionRepo.getGroupById(groupId)
    if (!group) throw new Error('Group not found')

    const groupSessions = sessionRepo.listSessionsByGroup(groupId)
    const mainSession = groupSessions.find(s => s.id === group.mainSessionId) || groupSessions[0]

    // Create a fresh cwd so claude doesn't auto-continue an existing session

    const freshId = uuid().slice(0, 8)
    const { mkdirSync } = require('fs')
    const freshCwd = join(homedir(), '.kitty-kitty', 'sessions', freshId)
    mkdirSync(freshCwd, { recursive: true })

    const script = generateLaunchScript('claude', 'new')

    if (getPaneMode() && groupSessions.length > 0 && mainSession) {
      // Pane mode: split into the group's tmux session
      const hostTmuxName = mainSession.tmuxName
      if (!tmux.isSessionAlive(hostTmuxName)) {
        throw new Error('Group host session is not running')
      }

      const isFirstSplit = tmux.getPaneCount(hostTmuxName) === 1
      const paneId = tmux.createPaneInSession(hostTmuxName, script, isFirstSplit, freshCwd)

      const session: tmux.TmuxSession = {
        id: freshId,
        tmuxName: hostTmuxName,
        title: `${group.name} agent`,
        tool: 'claude',
        cwd: freshCwd,
        status: 'running',
        createdAt: new Date().toISOString(),
      }
      sessionRepo.saveSession(session)
      sessionRepo.updateSessionPaneId(freshId, paneId)
      sessionRepo.updateSessionGroup(freshId, groupId)

      if (!group.mainSessionId) {
        sessionRepo.setGroupMainSession(groupId, groupSessions[0]?.id || freshId)
      }

      try {
        sessionMcp.injectSessionMcp(freshId, freshCwd, hostTmuxName, session.title)
      } catch (e) { log('session', 'mcp inject failed:', e) }

      tmux.focusSession(hostTmuxName)
      tmux.refreshAllStatusBars()
      return toSessionInfo(session)
    } else {
      // Session mode or first session: create independent
      const session = tmux.createTmuxSession('claude', undefined, freshCwd, script)
      sessionRepo.saveSession(session)
      sessionRepo.updateSessionGroup(session.id, groupId)

      if (!group.mainSessionId) {
        sessionRepo.setGroupMainSession(groupId, session.id)
      }

      try {
        sessionMcp.injectSessionMcp(session.id, session.cwd, session.tmuxName, session.title)
      } catch (e) { log('session', 'mcp inject failed:', e) }

      tmux.attachSession(session.tmuxName)
      return toSessionInfo(session)
    }
  })

  ipcMain.handle(IPC.GROUP_SET_MAIN_SESSION, (_event, groupId: string, sessionId: string) => {
    sessionRepo.setGroupMainSession(groupId, sessionId)

    if (getPaneMode()) {
      const session = sessionRepo.listSessions().find(s => s.id === sessionId)
      if (!session) return { success: true }

      // Find the tmux session hosting this group's panes
      const groupSessions = sessionRepo.listSessionsByGroup(groupId)
        .filter(s => !s.hidden && tmux.isSessionAlive(s.tmuxName))
      const hostTmux = groupSessions[0]?.tmuxName
      if (!hostTmux) return { success: true }

      // Use stored paneId for precise matching
      if (session.paneId) {
        try {
          tmux.swapMainPane(hostTmux, session.paneId)
          tmux.applyMainVerticalLayout(hostTmux)
        } catch (err) {
          log('pane-mode', `swap main pane failed:`, err)
        }
      }
    }
    return { success: true }
  })
}

function migrateToPane(): void {
  const groups = sessionRepo.listGroups()
  for (const group of groups) {
    // Only consider visible, alive sessions with unique tmux names
    const sessions = sessionRepo.listSessionsByGroup(group.id)
      .filter(s => !s.hidden && tmux.isSessionAlive(s.tmuxName))
    const uniqueSessions = sessions.filter((s, i, arr) =>
      arr.findIndex(x => x.tmuxName === s.tmuxName) === i
    )
    if (uniqueSessions.length <= 1) continue

    const mainSession = uniqueSessions.find(s => s.id === group.mainSessionId) || uniqueSessions[0]
    const others = uniqueSessions.filter(s => s.tmuxName !== mainSession.tmuxName)

    // Kill extra panes on main session first (worktree forks etc.)
    const mainPanes = tmux.getPaneCount(mainSession.tmuxName)
    if (mainPanes > 1) {
      try {
        const panes = execSync(
          `${tmux.TMUX} list-panes -t "${mainSession.tmuxName}" -F '#{pane_id}'`,
          { encoding: 'utf-8' }
        ).trim().split('\n')
        for (let p = panes.length - 1; p >= 1; p--) {
          try { execSync(`${tmux.TMUX} kill-pane -t ${panes[p]}`, { stdio: 'ignore' }) } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }

    const joinedIds: string[] = []
    for (const other of others) {
      try {
        // Kill extra panes in source session first (keep only the main pane 0.0)
        const srcPaneCount = tmux.getPaneCount(other.tmuxName)
        if (srcPaneCount > 1) {
          const srcPanes = execSync(
            `${tmux.TMUX} list-panes -t "${other.tmuxName}" -F '#{pane_id}'`,
            { encoding: 'utf-8' }
          ).trim().split('\n')
          for (let p = srcPanes.length - 1; p >= 1; p--) {
            try { execSync(`${tmux.TMUX} kill-pane -t ${srcPanes[p]}`, { stdio: 'ignore' }) } catch { /* ignore */ }
          }
        }
        tmux.joinSessionAsPane(other.tmuxName, mainSession.tmuxName)
        const db = getDB()
        db.prepare("UPDATE sessions SET tmux_name = ? WHERE tmux_name = ?").run(mainSession.tmuxName, other.tmuxName)
        joinedIds.push(other.id)
      } catch (err) {
        log('pane-mode', `join failed for ${other.tmuxName}:`, err)
      }
    }

    // Record pane IDs for all sessions after join
    try {
      const allPanes = execSync(
        `${tmux.TMUX} list-panes -t "${mainSession.tmuxName}" -F '#{pane_id}'`,
        { encoding: 'utf-8' }
      ).trim().split('\n')
      // First pane = main session
      sessionRepo.updateSessionPaneId(mainSession.id, allPanes[0])
      // Subsequent panes = joined sessions (in order)
      for (let i = 0; i < joinedIds.length && i + 1 < allPanes.length; i++) {
        sessionRepo.updateSessionPaneId(joinedIds[i], allPanes[i + 1])
      }
    } catch (err) {
      log('pane-mode', `record pane IDs failed for ${mainSession.tmuxName}:`, err)
    }

    tmux.applyMainVerticalLayout(mainSession.tmuxName)

    if (!group.mainSessionId) {
      sessionRepo.setGroupMainSession(group.id, mainSession.id)
    }
  }
}

function migrateToSession(): void {
  // Kill extra panes in all kitty sessions — restore logic in syncAndList
  // will recreate the dead sessions as independent tmux sessions.
  const allSessions = tmux.listTmuxSessions()
  for (const s of allSessions) {
    const paneCount = tmux.getPaneCount(s.name)
    if (paneCount <= 1) continue

    try {
      const panes = execSync(
        `${tmux.TMUX} list-panes -t "${s.name}" -F '#{pane_id}'`,
        { encoding: 'utf-8' }
      ).trim().split('\n')

      // Kill all panes except the first (main pane stays)
      for (let i = panes.length - 1; i >= 1; i--) {
        try {
          execSync(`${tmux.TMUX} kill-pane -t ${panes[i]}`, { stdio: 'ignore' })
        } catch { /* ignore */ }
      }
      log('pane-mode', `killed ${panes.length - 1} extra panes in ${s.name}`)
    } catch (err) {
      log('pane-mode', `migration failed for ${s.name}:`, err)
    }
  }
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
      if (!liveNames.has(row.tmuxName) && row.cwd && existsSync(row.cwd) && !row.hidden) {
        try {
          // Use wrapper to restore: try continue → new → shell fallback
          const script = generateLaunchScript(row.tool, 'restore')

          execSync(
            `${tmux.TMUX} new-session -d -s "${row.tmuxName}" -c "${row.cwd}" "${script}"`,
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

    // Auto-migrate layout based on pane mode
    // Session mode: kill extra panes BEFORE restoring worktree panes
    // Pane mode: merge sessions AFTER restore (worktree panes not needed in pane mode)
    if (!getPaneMode()) {
      migrateToSession()
    }

    // Restore worktree panes for all live sessions (session mode only)
    if (!getPaneMode()) {
      for (const row of sessionRepo.listSessions()) {
        if (liveNames.has(row.tmuxName)) {
          try {
            worktreeManager.restorePanes(row.id, row.tmuxName)
          } catch (err) {
            console.error(`[restore] Failed to restore worktree panes for ${row.tmuxName}:`, err)
          }
        }
      }
    }

    if (getPaneMode()) {
      migrateToPane()
    }

    // Apply status bar to all live sessions
    for (const name of liveNames) {
      tmux.applyKittyStatusBar(name)
    }
    // Bind global keys once after all status bars are applied
    tmux.refreshAllStatusBars()
  }

  // Inject session MCP for all live sessions with cwd (every sync, idempotent)
  for (const row of sessionRepo.listSessions()) {
    if (liveNames.has(row.tmuxName) && row.cwd) {
      sessionMcp.injectSessionMcp(row.id, row.cwd, row.tmuxName, row.title)
    }
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
    paneId: row.paneId || '',
    status: row.status as SessionInfo['status'],
    createdAt: row.createdAt,
    groupId: row.groupId || undefined,
    groupName: row.groupName || undefined,
    groupColor: row.groupColor || undefined,
    hidden: !!row.hidden,
    roles: row.roles || '',
    expertise: row.expertise || '',
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
    paneId: '',
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
