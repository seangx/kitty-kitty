import { ipcMain } from 'electron'
import { IPC } from '@shared/types/ipc'
import * as worktreeManager from '../worktree/worktree-manager'
import * as sessionRepo from '../db/session-repo'

export function registerWorktreeHandlers(): void {
  ipcMain.handle(IPC.WORKTREE_DISCOVER, (_event, projectRoot: string) => {
    return worktreeManager.discoverWorktrees(projectRoot)
  })

  ipcMain.handle(IPC.WORKTREE_CREATE_PANE, (_event, sessionId: string, branch: string, baseBranch?: string, tool?: string) => {
    const session = sessionRepo.listSessions().find(s => s.id === sessionId)
    if (!session) throw new Error('Session not found')
    if (!session.cwd) throw new Error('Session has no working directory')
    return worktreeManager.createWorktreePane(
      sessionId, session.tmuxName, session.cwd, branch, baseBranch || 'main', tool || session.tool
    )
  })

  ipcMain.handle(IPC.WORKTREE_ATTACH_PANES, (_event, sessionId: string, worktrees: Array<{ branch: string; path: string }>, tool?: string) => {
    const session = sessionRepo.listSessions().find(s => s.id === sessionId)
    if (!session) throw new Error('Session not found')
    return worktreeManager.attachWorktrees(
      sessionId, session.tmuxName,
      worktrees.map(w => ({ ...w, isTracked: false })),
      tool || session.tool
    )
  })

  ipcMain.handle(IPC.WORKTREE_REMOVE_PANE, (_event, paneId: string, opts?: { keepWorktree?: boolean }) => {
    worktreeManager.removeWorktreePane(paneId, opts)
    return { success: true }
  })

  ipcMain.handle(IPC.WORKTREE_PRUNE_MERGED, (_event, sessionId: string) => {
    return worktreeManager.pruneMerged(sessionId)
  })

  ipcMain.handle(IPC.WORKTREE_LIST_PANES, (_event, sessionId: string) => {
    return worktreeManager.listPanes(sessionId)
  })
}
