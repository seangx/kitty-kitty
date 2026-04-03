import { ipcMain } from 'electron'
import { IPC } from '@shared/types/ipc'
import * as skills from '../skills/skills-manager'
import * as sessionRepo from '../db/session-repo'

export function registerSkillsHandlers(): void {
  ipcMain.handle(IPC.SKILLS_LIST, async (_event, sessionId: string) => {
    const available = await skills.isAvailable()
    if (!available) {
      return { available: false, categories: [], groups: [], deployed: [] }
    }

    const session = sessionRepo.listSessions().find((s) => s.id === sessionId)

    const [{ categories, groups }, deployed] = await Promise.all([
      skills.listSkills(),
      session?.cwd ? skills.listDeployed(session.cwd) : Promise.resolve([]),
    ])

    return { available, categories, groups, deployed }
  })

  ipcMain.handle(IPC.SKILLS_ADD, async (_event, sessionId: string, skillName: string) => {
    const session = sessionRepo.listSessions().find((s) => s.id === sessionId)
    if (!session?.cwd) {
      return { success: false, message: '该会话没有工作目录' }
    }
    return skills.addSkill(session.cwd, skillName, session.tool)
  })

  ipcMain.handle(IPC.SKILLS_REMOVE, async (_event, sessionId: string, skillName: string) => {
    const session = sessionRepo.listSessions().find((s) => s.id === sessionId)
    if (!session?.cwd) {
      return { success: false, message: '该会话没有工作目录' }
    }
    return skills.removeSkill(session.cwd, skillName)
  })

  ipcMain.handle(IPC.SKILLS_SEARCH, async (_event, query: string) => {
    return { results: await skills.searchSkills(query) }
  })

  ipcMain.handle(IPC.SKILLS_INSTALL, async (_event, skillName: string) => {
    return skills.installSkill(skillName)
  })
}
