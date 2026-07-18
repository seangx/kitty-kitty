import { ipcMain } from 'electron'
import { IPC } from '@shared/types/ipc'
import * as mcps from '../mcps/mcps-manager'
import * as sessionRepo from '../db/session-repo'

export function registerMcpsHandlers(): void {
  ipcMain.handle(IPC.MCPS_LIST, async (_event, sessionId: string) => {
    const available = await mcps.isAvailable()
    const session = sessionRepo.listSessions().find((s) => s.id === sessionId)
    const { central, deployed } = await mcps.listMcps(session?.cwd, session?.tool)
    return { available, central, deployed }
  })

  ipcMain.handle(IPC.MCPS_ADD, async (_event, sessionId: string, source: string) => {
    const session = sessionRepo.listSessions().find((s) => s.id === sessionId)
    if (!session?.cwd) {
      return { success: false, message: '该会话没有工作目录' }
    }
    return mcps.addMcp(session.cwd, source, session.tool)
  })

  ipcMain.handle(IPC.MCPS_REMOVE, async (_event, sessionId: string, name: string) => {
    const session = sessionRepo.listSessions().find((s) => s.id === sessionId)
    if (!session?.cwd) {
      return { success: false, message: '该会话没有工作目录' }
    }
    return mcps.removeMcp(session.cwd, name)
  })

  ipcMain.handle(IPC.MCPS_INSTALL, async (_event, source: string) => {
    return mcps.installMcp(source)
  })

  ipcMain.handle(IPC.MCPS_UNINSTALL, async (_event, name: string) => {
    return mcps.uninstallMcp(name)
  })

  ipcMain.handle(IPC.MCPS_WRITE_MANUAL, async (_event, sessionId: string, jsonText: string) => {
    const session = sessionRepo.listSessions().find((s) => s.id === sessionId)
    if (!session?.cwd) {
      return { success: false, message: '该会话没有工作目录' }
    }
    return mcps.writeManualMcp(session.cwd, jsonText, session.tool)
  })
}
