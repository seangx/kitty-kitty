import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { listGlobalDeployedSkills } from '../src/main/skills/global-repository.ts'

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
  assert.match(panel, /await ipc\.addGlobalSkill\(name, 'codex'\)/)
  assert.match(panel, /await ipc\.removeGlobalSkill\(name, 'codex'\)/)
  assert.match(panel, /isGlobal\s*\? await ipc\.installMcp/)
  assert.match(panel, /await ipc\.uninstallMcp/)
  assert.match(panel, /await ipc\.addGlobalMcp\(name, 'codex'\)/)
  assert.match(panel, /await ipc\.removeGlobalMcp\(name, 'codex'\)/)
  assert.match(ipcTypes, /SKILLS_UNINSTALL: 'skills:uninstall'/)
  assert.match(ipcTypes, /SKILLS_GLOBAL_ADD: 'skills:global-add'/)
  assert.match(ipcTypes, /MCPS_GLOBAL_ADD: 'mcps:global-add'/)
  assert.match(skillsHandlers, /IPC\.SKILLS_UNINSTALL/)
  assert.match(skillsHandlers, /IPC\.SKILLS_GLOBAL_ADD/)
})

test('settings configures executable aliases without changing semantic tool ids', async () => {
  const [settings, handlers, wrapper, directoryTools] = await Promise.all([
    source('src/renderer/pet/SettingsPanel.tsx'),
    source('src/main/ipc/session-handlers.ts'),
    source('src/main/tmux/cli-wrapper.ts'),
    source('src/shared/directory-session.ts'),
  ])

  assert.match(settings, /config:tool-commands:get/)
  assert.match(settings, /config:tool-command:set/)
  assert.match(settings, /Hive 中仍使用原 tool id/)
  assert.match(handlers, /IPC\.CONFIG_TOOL_COMMAND_SET/)
  assert.match(handlers, /basename\(getUserToolCommand\('codex'\)\)/)
  assert.match(wrapper, /toolCommands\?: Record<string, string>/)
  assert.match(wrapper, /getUserToolCommand\('codex'/)
  assert.match(directoryTools, /'claude' \| 'codex' \| 'opencode'/)
  assert.doesNotMatch(directoryTools, /codex-debug/)
})

test('global Codex skill state follows the skillsmgr directory and both manifest filename cases', () => {
  const home = mkdtempSync(join(tmpdir(), 'kitty-global-skills-'))
  try {
    const root = join(home, '.codex', 'skills')
    mkdirSync(join(root, 'lowercase'), { recursive: true })
    mkdirSync(join(root, 'uppercase'), { recursive: true })
    mkdirSync(join(root, 'not-a-skill'), { recursive: true })
    writeFileSync(join(root, 'lowercase', 'skill.md'), '# lower')
    writeFileSync(join(root, 'uppercase', 'SKILL.md'), '# upper')

    assert.deepEqual(listGlobalDeployedSkills('codex', { home }), ['lowercase', 'uppercase'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
