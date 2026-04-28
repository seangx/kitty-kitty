import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { IPC } from '@shared/types/ipc'
import { readdirSync, existsSync, statSync, mkdirSync, readFileSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { execSync, spawn } from 'child_process'
import { v4 as uuid } from 'uuid'
import { log } from '../logger'
import * as tmux from '../tmux/session-manager'
import { generateLaunchScript, isToolInstalled, getInstallHint, getNtfyTopic, setNtfyTopic, needsDevChannelAutoAccept } from '../tmux/cli-wrapper'
import * as sessionRepo from '../db/session-repo'
import { getDB } from '../db/database'
import * as ntfy from '../ntfy'
import { getProvider } from '../sessions'
import type { SessionInfo } from '@shared/types/session'

/**
 * Fire-and-forget kitty-hive CLI call. If hive isn't installed or the command fails,
 * we silently ignore — hive is optional and kitty must keep running without it.
 */
function hiveCli(args: string[]): void {
  try {
    const child = spawn('kitty-hive', args, {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
    })
    const timeout = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 3000)
    child.on('exit', () => clearTimeout(timeout))
    child.on('error', () => { /* hive not installed / PATH miss — ignore */ })
    child.unref()
  } catch { /* ignore */ }
}

/** List recent on-disk CLI sessions for the given tool, started from `projectDir`. */
function findExternalSessions(tool: string, projectDir: string): Array<{ id: string; summary: string; date: string }> {
  const provider = getProvider(tool)
  if (!provider) return []
  try { return provider.findSessions(projectDir) } catch { return [] }
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
    const existingSessions = findExternalSessions(tool || 'claude', dir)
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
    tmux.attachSession(session.tmuxName)
    return toSessionInfo(session)
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
      // This session may exist as a pane in its group's host session
      if (session.groupId) {
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
  // Detect if claude/codex has rolled over to a newer on-disk session id than the
  // one kitty has stored. Returns drift info or null. Used by attach flow to
  // prompt the user before reattaching to a stale session.
  ipcMain.handle('session:check-drift', (_event, id: string) => {
    const rows = sessionRepo.listSessions()
    const session = rows.find((s) => s.id === id)
    if (!session || !session.cwd) return null

    const provider = getProvider(session.tool)
    if (!provider) return null

    let entries: Array<{ id: string; summary: string; date: string }> = []
    try { entries = provider.findSessions(session.cwd) } catch { return null }
    if (entries.length === 0) return null

    const latest = entries[0]
    if (!latest?.id || latest.id === session.externalSessionId) return null
    return {
      currentId: session.externalSessionId || null,
      latestId: latest.id,
      latestSummary: latest.summary,
      latestDate: latest.date,
    }
  })

  // Kill the live tmux session and rebind to a different external session id.
  // Next attach goes through the restore path and resumes with the new id.
  ipcMain.handle('session:rebind-external', (_event, id: string, newExternalId: string) => {
    const rows = sessionRepo.listSessions()
    const session = rows.find((s) => s.id === id)
    if (!session) return { success: false }
    try { tmux.killSession(session.tmuxName) } catch { /* ignore */ }
    sessionRepo.updateSessionExternalId(id, newExternalId)
    sessionRepo.updateSessionStatus(id, 'detached')
    log('session', `rebind ${session.title} → ${newExternalId.slice(0, 8)}`)
    return { success: true }
  })

  ipcMain.handle(IPC.SESSION_KILL, (_event, id: string) => {
    const rows = sessionRepo.listSessions()
    const session = rows.find((s) => s.id === id)
    if (session) {
      tmux.killSession(session.tmuxName)
      sessionRepo.deleteSession(id)
      hiveCli(['agent', 'remove', '--key', id, '--yes'])
    }
    return { success: true }
  })

  // Kill + delete session data files (session dir under ~/.kitty-kitty/sessions/ and claude session file)
  ipcMain.handle('session:kill-and-delete', (_event, id: string) => {
    const fs = require('fs') as typeof import('fs')
    const rows = sessionRepo.listSessions()
    const session = rows.find((s) => s.id === id)
    if (!session) return { success: true }

    tmux.killSession(session.tmuxName)

    // Delete session directory if under ~/.kitty-kitty/sessions/
    const kittySessionsDir = join(homedir(), '.kitty-kitty', 'sessions')
    if (session.cwd && session.cwd.startsWith(kittySessionsDir)) {
      try { fs.rmSync(session.cwd, { recursive: true, force: true }) } catch { /* ignore */ }
    }

    // Delete the on-disk CLI session file if we know its id
    if (session.externalSessionId && session.cwd) {
      const provider = getProvider(session.tool)
      if (provider) {
        try { provider.deleteSessionFile(session.externalSessionId, session.cwd) } catch { /* ignore */ }
      }
    }

    sessionRepo.deleteSession(id)
    hiveCli(['agent', 'remove', '--key', id, '--yes'])
    log('session', `kill-and-delete: ${session.title}`)
    return { success: true }
  })

  // Rename a session
  ipcMain.handle('session:rename', (_event, id: string, title: string) => {
    sessionRepo.updateSessionTitle(id, title)
    // Sync display_name to hive so agents keep the same id but show the new title
    if (title && title.trim()) {
      hiveCli(['agent', 'register', '--key', id, '--display-name', title])
    }
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
    restartSessionPane(session)
    return { success: true }
  })

  // Restart all alive sessions in one go
  ipcMain.handle('session:restart-all', () => {
    const rows = sessionRepo.listSessions()
    let ok = 0, fail = 0
    for (const session of rows) {
      if (session.hidden) continue
      if (!tmux.isSessionAlive(session.tmuxName)) continue
      try {
        restartSessionPane(session)
        ok++
      } catch (err) {
        log('session', `restart-all: failed for ${session.title}:`, err)
        fail++
      }
    }
    log('session', `restart-all: ok=${ok} fail=${fail}`)
    return { ok, fail }
  })

  // Restart all sessions in a given group
  ipcMain.handle('group:restart-sessions', (_event, groupId: string) => {
    const rows = sessionRepo.listSessions().filter(s => s.groupId === groupId)
    let ok = 0, fail = 0
    for (const session of rows) {
      if (session.hidden) continue
      if (!tmux.isSessionAlive(session.tmuxName)) continue
      try {
        restartSessionPane(session)
        ok++
      } catch (err) {
        log('session', `group-restart: failed for ${session.title}:`, err)
        fail++
      }
    }
    log('session', `group-restart: group=${groupId} ok=${ok} fail=${fail}`)
    return { ok, fail }
  })

  // Get session env vars (returns object)
  ipcMain.handle('session:get-env', (_event, id: string) => {
    const row = sessionRepo.listSessions().find(s => s.id === id)
    if (!row) return {}
    try {
      return row.env ? JSON.parse(row.env) : {}
    } catch {
      return {}
    }
  })

  // Set session env vars
  ipcMain.handle('session:set-env', (_event, id: string, env: Record<string, string>) => {
    sessionRepo.updateSessionEnv(id, JSON.stringify(env || {}))
    return { success: true }
  })

  // Delete an external CLI session file (claude / codex / ...)
  ipcMain.handle('session:delete-external-session', (_event, tool: string, projectDir: string, sessionId: string) => {
    const provider = getProvider(tool)
    if (!provider) return { success: false }
    try { provider.deleteSessionFile(sessionId, projectDir) } catch { /* ignore */ }
    return { success: true }
  })

  // Sync tmux state with DB
  ipcMain.handle(IPC.SESSION_SYNC, () => {
    return syncAndList()
  })

  // --- Group management ---
  ipcMain.handle('group:list', () => {
    return sessionRepo.listGroups()
  })

  ipcMain.handle('group:create', (_event, name: string, color?: string) => {

    const id = uuid().slice(0, 8)
    sessionRepo.createGroup(id, name, color)
    return { id, name, color }
  })

  ipcMain.handle('group:delete', (_event, groupId: string) => {
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

    // Move the pane between group tmux sessions
    {
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
        } else if (!sourcePaneId && groupId && tmux.isSessionAlive(session.tmuxName)) {
          // No pane_id: this is a standalone session, join it as a whole into the target group
          const targetGroupSessions = sessionRepo.listSessionsByGroup(groupId)
            .filter(s => !s.hidden && s.id !== sessionId && tmux.isSessionAlive(s.tmuxName))
          const targetHost = targetGroupSessions[0]
          if (targetHost) {
            tmux.joinSessionAsPane(session.tmuxName, targetHost.tmuxName)
            const newPanes = execSync(
              `${tmux.TMUX} list-panes -t "${targetHost.tmuxName}" -F '#{pane_id}'`,
              { encoding: 'utf-8' }
            ).trim().split('\n')
            sessionRepo.updateSessionPaneId(sessionId, newPanes[newPanes.length - 1])
            const db = getDB()
            db.prepare("UPDATE sessions SET tmux_name = ? WHERE id = ?").run(targetHost.tmuxName, sessionId)
            tmux.applyMainVerticalLayout(targetHost.tmuxName)
          }
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

    // Kill/restore the corresponding pane
    if (session) {
      if (hidden) {
        const groupSessions = session.groupId
          ? sessionRepo.listSessionsByGroup(session.groupId).filter(s => tmux.isSessionAlive(s.tmuxName))
          : []
        const hostTmux = groupSessions[0]?.tmuxName || session.tmuxName
        if (tmux.isSessionAlive(hostTmux)) {
          let targetPane = session.paneId || ''
          // Fallback: match by cwd if paneId not stored
          if (!targetPane && session.cwd) {
            try {
              const panes = execSync(
                `${tmux.TMUX} list-panes -t "${hostTmux}" -F '#{pane_id} #{pane_current_path}'`,
                { encoding: 'utf-8' }
              ).trim().split('\n')
              for (const line of panes) {
                const [pid, ...pp] = line.split(' ')
                if (pp.join(' ') === session.cwd) { targetPane = pid; break }
              }
            } catch { /* ignore */ }
          }
          if (targetPane) {
            try {
              execSync(`${tmux.TMUX} kill-pane -t ${targetPane}`, { stdio: 'ignore' })
              if (tmux.getPaneCount(hostTmux) > 1) {
                tmux.applyMainVerticalLayout(hostTmux)
              }
            } catch { /* ignore */ }
          }
        }
      } else {
        // Unhide: restore pane in background so IPC returns fast for UI refresh
        const sid = sessionId
        const sCwd = session.cwd
        const sTool = session.tool
        const sTmuxName = session.tmuxName
        const gid = session.groupId
        setTimeout(() => {
          try {
            if (gid) {
              // Grouped: re-join as a pane in the group's host session
              const groupSessions = sessionRepo.listSessionsByGroup(gid)
                .filter(s => s.id !== sid && !s.hidden && tmux.isSessionAlive(s.tmuxName))
              const hostTmux = groupSessions[0]?.tmuxName
              if (hostTmux && sCwd && existsSync(sCwd)) {
                const tempName = `kitty_tmp_${Date.now()}`
                const script = generateLaunchScript(sTool || 'claude', 'restore')
                execSync(
                  `${tmux.TMUX} new-session -d -s "${tempName}" -c "${sCwd}" "${script}"`,
                  { stdio: 'ignore', env: { ...process.env, TERM: 'xterm-256color' } }
                )
                tmux.joinSessionAsPane(tempName, hostTmux)
                const newPanes = execSync(
                  `${tmux.TMUX} list-panes -t "${hostTmux}" -F '#{pane_id}'`,
                  { encoding: 'utf-8' }
                ).trim().split('\n')
                sessionRepo.updateSessionPaneId(sid, newPanes[newPanes.length - 1])
                getDB().prepare("UPDATE sessions SET tmux_name = ? WHERE id = ?").run(hostTmux, sid)
                sessionRepo.updateSessionStatus(sid, 'detached')
                tmux.applyMainVerticalLayout(hostTmux)
              }
            } else {
              // Ungrouped: rebuild standalone tmux session if the old one is gone
              if (sTmuxName && !tmux.isSessionAlive(sTmuxName) && sCwd && existsSync(sCwd)) {
                const script = generateLaunchScript(sTool || 'claude', 'restore')
                execSync(
                  `${tmux.TMUX} new-session -d -s "${sTmuxName}" -c "${sCwd}" "${script}"`,
                  { stdio: 'ignore', env: { ...process.env, TERM: 'xterm-256color' } }
                )
                tmux.applyKittyStatusBar(sTmuxName)
                sessionRepo.updateSessionStatus(sid, 'detached')
              } else if (tmux.isSessionAlive(sTmuxName)) {
                sessionRepo.updateSessionStatus(sid, 'detached')
              }
            }
          } catch (err) {
            log('pane-mode', `unhide restore failed:`, err)
          }
        }, 0)
      }
    }

    tmux.refreshAllStatusBars()
  })

  // --- Ntfy ---
  ipcMain.handle(IPC.NTFY_TOPIC_GET, () => {
    return getNtfyTopic()
  })

  ipcMain.handle(IPC.NTFY_TOPIC_SET, (_event, topic: string) => {
    setNtfyTopic(topic)
    ntfy.updateTopic(topic)
  })

  ipcMain.handle(IPC.SESSION_CREATE_IN_GROUP, (_event, groupId: string) => {
    ensureReady('claude')

    const group = sessionRepo.getGroupById(groupId)
    if (!group) throw new Error('Group not found')

    // Pick an ALIVE, non-hidden host session in the group to split into.
    // Prefer the group's main session; fall back to any other alive one.
    const allGroupSessions = sessionRepo.listSessionsByGroup(groupId)
    const aliveGroupSessions = allGroupSessions.filter(s => !s.hidden && tmux.isSessionAlive(s.tmuxName))
    const hostSession = aliveGroupSessions.find(s => s.id === group.mainSessionId) || aliveGroupSessions[0]

    // Use a fresh session dir so claude starts a new conversation
    const freshId = uuid().slice(0, 8)
    const freshCwd = join(homedir(), '.kitty-kitty', 'sessions', freshId)
    mkdirSync(freshCwd, { recursive: true })

    const script = generateLaunchScript('claude', 'new')

    if (hostSession) {
      // Split into the group's tmux session
      const hostTmuxName = hostSession.tmuxName
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
        sessionRepo.setGroupMainSession(groupId, hostSession.id)
      }

      try { tmux.applyMainVerticalLayout(hostTmuxName) } catch { /* ignore */ }
      tmux.focusSession(hostTmuxName)
      tmux.refreshAllStatusBars()
      return toSessionInfo(session)
    }

    // No alive host in the group: create a standalone tmux session and attach it to the group
    const session = tmux.createTmuxSession('claude', undefined, freshCwd, script)
    sessionRepo.saveSession(session)
    try {
      const newPaneId = execSync(
        `${tmux.TMUX} list-panes -t "${session.tmuxName}" -F '#{pane_id}'`,
        { encoding: 'utf-8' }
      ).trim().split('\n')[0]
      if (newPaneId) sessionRepo.updateSessionPaneId(session.id, newPaneId)
    } catch { /* ignore */ }
    sessionRepo.updateSessionGroup(session.id, groupId)

    if (!group.mainSessionId) {
      sessionRepo.setGroupMainSession(groupId, session.id)
    }

    tmux.applyKittyStatusBar(session.tmuxName)
    tmux.attachSession(session.tmuxName)
    tmux.refreshAllStatusBars()
    return toSessionInfo(session)
  })

  ipcMain.handle(IPC.GROUP_SET_MAIN_SESSION, (_event, groupId: string, sessionId: string) => {
    sessionRepo.setGroupMainSession(groupId, sessionId)

    syncPaneIds()
    const session = sessionRepo.listSessions().find(s => s.id === sessionId)
    if (!session?.paneId || !tmux.isSessionAlive(session.tmuxName)) return { success: true }

    try {
      tmux.swapMainPane(session.tmuxName, session.paneId)
      tmux.applyMainVerticalLayout(session.tmuxName)
    } catch (err) {
      log('pane-mode', `swap main pane failed:`, err)
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

    // Kill extra panes on main session first
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
        // Update by row id only — `WHERE tmux_name = ?` previously could cross-update
        // sessions in OTHER groups that happened to share the same tmux_name.
        db.prepare("UPDATE sessions SET tmux_name = ? WHERE id = ?").run(mainSession.tmuxName, other.id)
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

/**
 * Sync pane_id for ALL non-hidden sessions from actual tmux state.
 * Builds a map of tmux pane_id → cwd, then matches each DB session.
 * Called after every migration and on every sync cycle in pane mode.
 */
function syncPaneIds(): void {
  // Build a global map: pane_id → cwd from all alive tmux sessions
  const paneMap = new Map<string, { tmuxName: string; cwd: string }>()
  for (const s of tmux.listTmuxSessions()) {
    try {
      const panes = execSync(
        `${tmux.TMUX} list-panes -t "${s.name}" -F '#{pane_id} #{pane_current_path}'`,
        { encoding: 'utf-8' }
      ).trim().split('\n')
      for (const line of panes) {
        const [paneId, ...pp] = line.split(' ')
        paneMap.set(paneId, { tmuxName: s.name, cwd: pp.join(' ') })
      }
    } catch { /* ignore */ }
  }

  for (const session of sessionRepo.listSessions()) {
    if (session.hidden || !session.paneId) continue

    // Validate: does this pane_id still exist in tmux?
    if (paneMap.has(session.paneId)) {
      // Pane alive — sync tmux_name if it moved to a different session
      const info = paneMap.get(session.paneId)!
      if (session.tmuxName !== info.tmuxName) {
        getDB().prepare("UPDATE sessions SET tmux_name = ? WHERE id = ?").run(info.tmuxName, session.id)
      }
    } else {
      // Pane gone — clear stale pane_id
      sessionRepo.updateSessionPaneId(session.id, '')
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
          // Use resume with external session id if available, otherwise fallback to restore
          const script = row.externalSessionId
            ? generateLaunchScript(row.tool, 'resume', row.externalSessionId)
            : generateLaunchScript(row.tool, 'restore')

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

    // Merge sessions of the same group into panes
    migrateToPane()
    syncPaneIds()

    // Apply status bar to all live sessions
    for (const name of liveNames) {
      tmux.applyKittyStatusBar(name)
    }
    // Bind global keys once after all status bars are applied
    tmux.refreshAllStatusBars()
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

  // Keep pane_ids in sync with actual tmux state
  syncPaneIds()

  // Sync external CLI session IDs (claude/codex/...) for live sessions missing them
  syncExternalSessionIds()

  const result = sessionRepo.listSessions().map((row) => ({
    id: row.id,
    tmuxName: row.tmuxName,
    title: row.title,
    tool: row.tool,
    cwd: row.cwd,
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
  }))
  log('sync', result.map(r => `${r.title}:${r.status}`).join(', '))
  return result
}

/**
 * Backfill `external_session_id` for live sessions that don't have one yet, by
 * asking each tool's provider to find the most-recent on-disk session file
 * matching the session's cwd. Skips sessions whose tool has no on-disk store
 * (e.g. `shell`).
 */
function syncExternalSessionIds(): void {
  const sessions = sessionRepo.listSessions()
  const needsSync = sessions.filter(s => !s.externalSessionId && s.cwd && getProvider(s.tool))
  if (needsSync.length === 0) return

  // Already-claimed ids across ALL sessions (avoid double-assignment within kitty)
  const claimed = new Set(sessions.map(s => s.externalSessionId).filter(Boolean))

  for (const row of needsSync) {
    const provider = getProvider(row.tool)
    if (!provider) continue
    try {
      const id = provider.findUnclaimedSessionId(row.cwd, claimed)
      if (id) {
        sessionRepo.updateSessionExternalId(row.id, id)
        claimed.add(id)
        log('sync', `${row.tool} session ID: ${row.title} → ${id.slice(0, 8)}`)
      }
    } catch { /* ignore */ }
  }
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
    paneId: '',
    status: s.status,
    createdAt: s.createdAt,
    isGitRepo: s.cwd ? isGitRepository(s.cwd) : false,
  }
}

function restartSessionPane(session: sessionRepo.SessionRow): void {
  // In pane mode, use paneId (%N) to target the exact pane; otherwise use mainPane
  const target = session.paneId
    ? session.paneId
    : resolvePaneTarget(session.tmuxName, session.mainPane || '0.0')
  const mode = session.externalSessionId ? 'resume' : 'continue'
  const launch = generateLaunchScript(session.tool, mode, session.externalSessionId || undefined)

  // Parse per-session env and pass via respawn-pane -e KEY=VALUE
  let envFlags = ''
  if (session.env) {
    try {
      const parsed = JSON.parse(session.env) as Record<string, string>
      for (const [k, v] of Object.entries(parsed)) {
        envFlags += ` -e "${k}=${String(v).replace(/"/g, '\\"')}"`
      }
    } catch { /* ignore bad env json */ }
  }
  // Hive identity — re-inject on every restart so MCP re-registers this agent
  envFlags += ` -e "HIVE_AGENT_KEY=${session.id}"`
  envFlags += ` -e "HIVE_AGENT_NAME=${String(session.title || '').replace(/"/g, '\\"')}"`

  execSync(`${tmux.TMUX} respawn-pane -k${envFlags} -t "${target}" "${launch}"`, { stdio: 'ignore' })
  log('session', `restart: ${session.title} (mode=${mode})`)

  // For claude --dangerously-load-development-channels: auto-accept the prompt
  if (needsDevChannelAutoAccept(session.tool)) {
    pollAndAcceptDevChannelPrompt(target)
  }
}

/**
 * Non-blocking poller: watch the target pane and send Enter when the
 * dev-channels confirmation prompt appears. Max 5s (25 × 200ms).
 */
function pollAndAcceptDevChannelPrompt(paneTarget: string): void {
  const deadline = Date.now() + 5000
  const interval = setInterval(() => {
    if (Date.now() > deadline) { clearInterval(interval); return }
    try {
      const content = execSync(`${tmux.TMUX} capture-pane -p -t "${paneTarget}"`, {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore']
      })
      if (/development channels?|dangerously-load|trust these|continue\?/i.test(content)) {
        execSync(`${tmux.TMUX} send-keys -t "${paneTarget}" Enter`, { stdio: 'ignore' })
        clearInterval(interval)
      }
    } catch { /* pane gone, stop */ clearInterval(interval) }
  }, 200)
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
