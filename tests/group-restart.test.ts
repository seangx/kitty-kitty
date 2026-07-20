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
  const deck = await readFile(new URL('../src/renderer/pet/SessionDeck.tsx', import.meta.url), 'utf8')
  const handlers = await readFile(new URL('../src/main/ipc/session-handlers.ts', import.meta.url), 'utf8')
  const contextMenus = [...deck.matchAll(/onContextMenu=\{\(event\) => \{([\s\S]*?)\n\s*\}\}/g)]

  assert.ok(contextMenus.length >= 2)
  assert.equal(contextMenus.slice(0, 2).some((match) => match[1].includes('collapseBranches()')), false)
  assert.match(handlers, /sessionRepo\.listGroupSubtreeIds\(groupId\)/)
  assert.match(handlers, /event\.sender\.send\('group:restart-progress'/)
  assert.match(deck, /role="progressbar"/)
  assert.match(deck, />重启整个分组<\/button>/)
})
