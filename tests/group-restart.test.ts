import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { selectGroupRestartCandidates } from '../src/main/group-restart.ts'

test('group restart includes live sessions from descendant groups', () => {
  const sessions = [
    { id: 'root', groupId: 'root', tmuxName: 'root-pane' },
    { id: 'child', groupId: 'child', tmuxName: 'child-pane' },
    { id: 'grandchild', groupId: 'grandchild', tmuxName: 'grandchild-pane' },
    { id: 'hidden', groupId: 'child', tmuxName: 'hidden-pane', hidden: true },
    { id: 'dead', groupId: 'grandchild', tmuxName: 'dead-pane' },
    { id: 'outside', groupId: 'other', tmuxName: 'outside-pane' },
  ]
  const alive = new Set(['root-pane', 'child-pane', 'grandchild-pane', 'hidden-pane', 'outside-pane'])

  assert.deepEqual(
    selectGroupRestartCandidates(['root', 'child', 'grandchild'], sessions, (name) => alive.has(name))
      .map((session) => session.id),
    ['root', 'child', 'grandchild'],
  )
})

test('Deck context menus preserve branches and group restart reports progress', async () => {
  const [deck, handlers, hitTest, appMenu, canvas] = await Promise.all([
    readFile(new URL('../src/renderer/pet/SessionDeck.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/main/ipc/session-handlers.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/pet/deck-hit-test.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/pet/ContextMenu.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/pet/PetCanvas.tsx', import.meta.url), 'utf8'),
  ])
  const contextMenus = [...deck.matchAll(/onContextMenu=\{\(event\) => \{([\s\S]*?)\n\s*\}\}/g)]

  assert.ok(contextMenus.length >= 2)
  assert.equal(contextMenus.slice(0, 2).some((match) => match[1].includes('collapseBranches()')), false)
  assert.match(handlers, /sessionRepo\.listGroupSubtreeIds\(groupId\)/)
  assert.match(handlers, /event\.sender\.send\('group:restart-progress'/)
  assert.match(deck, /role="progressbar"/)
  assert.match(deck, />重启整个分组<\/button>/)
  assert.match(deck, /onOpenAppMenu: \(x: number, y: number\) => void/)
  assert.match(deck, /onOpenAppMenu\(event\.clientX, event\.clientY\)/)
  assert.match(hitTest, /'\.pet-context-menu'/)
  assert.match(appMenu, /className="pet-context-menu"/)
  assert.ok((deck.match(/className="session-deck__menu-separator"/g) || []).length >= 7)

  const sessionMenuStart = deck.indexOf('{sessionMenu && selectedSession')
  const groupMenuStart = deck.indexOf('{groupMenu && selectedGroup', sessionMenuStart)
  const sessionMenu = deck.slice(sessionMenuStart, groupMenuStart)
  assert.ok(sessionMenu.indexOf('打开会话') < sessionMenu.indexOf('重启'))
  assert.ok(sessionMenu.indexOf('重启') < sessionMenu.indexOf('技能 / MCP'))
  assert.ok(sessionMenu.indexOf('技能 / MCP') < sessionMenu.indexOf('移动到分组'))
  assert.ok(sessionMenu.indexOf('移动到分组') < sessionMenu.indexOf('结束会话'))

  const appMenuStart = canvas.indexOf('const menuItems = useMemo')
  const appMenuEnd = canvas.indexOf('// When popup is open', appMenuStart)
  const appMenuBlock = canvas.slice(appMenuStart, appMenuEnd)
  assert.ok(appMenuBlock.indexOf('新建分组') < appMenuBlock.indexOf('⚙️ 设置'))
  assert.ok(appMenuBlock.indexOf('⚙️ 设置') < appMenuBlock.indexOf('重启全部会话'))
})
