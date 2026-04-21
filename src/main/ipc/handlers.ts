import { registerSessionHandlers } from './session-handlers'
import { registerPetHandlers } from './pet-handlers'
import { registerSkillsHandlers } from './skills-handlers'

export function registerIpcHandlers(): void {
  registerSessionHandlers()
  registerPetHandlers()
  registerSkillsHandlers()
}
