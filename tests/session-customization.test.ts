import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const ROOT = new URL('../', import.meta.url)

async function source(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), 'utf8')
}

test('session and group icon colors persist and render in the Deck', async () => {
  const [types, database, repo, handlers, deck, css] = await Promise.all([
    source('src/shared/types/session.ts'),
    source('src/main/db/database.ts'),
    source('src/main/db/session-repo.ts'),
    source('src/main/ipc/session-handlers.ts'),
    source('src/renderer/pet/SessionDeck.tsx'),
    source('src/renderer/pet/SessionDeck.css'),
  ])

  assert.match(types, /color\?: string/)
  assert.match(database, /ALTER TABLE sessions ADD COLUMN color TEXT/)
  assert.match(repo, /export function updateSessionColor/)
  assert.match(repo, /s\.color/)
  assert.match(handlers, /ipcMain\.handle\('session:set-color'/)
  assert.match(handlers, /color: row\.color \|\| undefined/)
  assert.match(deck, /<ToolIcon tool=\{session\.tool\} color=\{session\.color\}/)
  assert.match(deck, /<GroupIcon color=\{node\.group\.color\}/)
  assert.match(deck, /window\.api\.invoke\('session:set-color'/)
  assert.match(deck, /window\.api\.invoke\('group:set-color'/)
  assert.match(css, /\.session-deck__color-swatch\.is-selected/)
})

test('creating a session from a group routes through the shared tool picker', async () => {
  const [deck, canvas, handlers] = await Promise.all([
    source('src/renderer/pet/SessionDeck.tsx'),
    source('src/renderer/pet/PetCanvas.tsx'),
    source('src/main/ipc/session-handlers.ts'),
  ])

  assert.match(deck, /onCreateDirect: \(groupId\?: string\) => void/)
  assert.match(deck, /onCreateDirect\(selectedGroup\.id\)/)
  assert.match(canvas, /const \[createTargetGroupId, setCreateTargetGroupId\]/)
  assert.match(canvas, /window\.api\.invoke\('session:create-in-group', targetGroupId, tool, message\)/)

  const start = handlers.indexOf('ipcMain.handle(IPC.SESSION_CREATE_IN_GROUP')
  const end = handlers.indexOf('ipcMain.handle(IPC.GROUP_SET_MAIN_SESSION', start)
  const block = handlers.slice(start, end)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  assert.match(block, /groupId: string, tool: string, firstMessage\?: string/)
  assert.match(block, /ensureReady\(t\)/)
  assert.doesNotMatch(block, /ensureReady\('claude'\)/)
  assert.match(block, /tool: t/)
  assert.match(block, /initialPrompt: cleanMessage/)
})

test('settings exposes a global Skills and MCP repository manager', async () => {
  const [settings, router, panel, ipcTypes, skillsHandlers] = await Promise.all([
    source('src/renderer/pet/SettingsPanel.tsx'),
    source('src/renderer/pet/PopupRouter.tsx'),
    source('src/renderer/pet/SkillsPanel.tsx'),
    source('src/shared/types/ipc.ts'),
    source('src/main/ipc/skills-handlers.ts'),
  ])

  assert.match(settings, /popup-open', 'skills', 'global'/)
  assert.match(router, /params === 'global' \? undefined : params/)
  assert.match(panel, /const isGlobal = !sessionId/)
  assert.match(panel, /isGlobal\s*\? await ipc\.installSkill/)
  assert.match(panel, /await ipc\.uninstallSkill/)
  assert.match(panel, /isGlobal\s*\? await ipc\.installMcp/)
  assert.match(panel, /await ipc\.uninstallMcp/)
  assert.match(ipcTypes, /SKILLS_UNINSTALL: 'skills:uninstall'/)
  assert.match(skillsHandlers, /IPC\.SKILLS_UNINSTALL/)
})
