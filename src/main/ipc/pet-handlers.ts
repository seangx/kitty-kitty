import { ipcMain, shell } from 'electron'
import { IPC } from '@shared/types/ipc'
import * as petRepo from '../db/pet-state-repo'
import type { InteractionType } from '@shared/types/pet'

export function registerPetHandlers(): void {
  ipcMain.handle('open-external', (_event, url: string) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      shell.openExternal(url)
    }
  })
  ipcMain.handle(IPC.PET_STATE_GET, () => {
    return petRepo.getPetState()
  })

  ipcMain.handle(IPC.PET_STATE_UPDATE, (_event, updates: Record<string, unknown>) => {
    return petRepo.updatePetState(updates)
  })

  ipcMain.handle(IPC.PET_INTERACT, (_event, type: InteractionType, detail?: string) => {
    return petRepo.recordInteraction(type, detail)
  })
}
