import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  buildDeckForest,
  chooseVerticalDirection,
  collectDeckSubtreeGroupIds,
  countDeckDescendants,
  nextDeckAxis,
  openDeckGroup,
  toggleDeckSubtree,
} from '../src/renderer/pet/deck-tree.ts'
import type { GroupInfo, SessionInfo } from '../src/shared/types/session.ts'

const session = (id: string, groupId?: string): SessionInfo => ({
  id,
  tmuxName: `tmux-${id}`,
  title: id,
  tool: 'codex',
  cwd: '/tmp',
  status: 'running',
  createdAt: '2026-07-18T00:00:00Z',
  groupId,
})

test('buildDeckForest keeps direct sessions and nested groups on the correct branch', () => {
  const groups: GroupInfo[] = [
    { id: 'monkey', name: 'monkey' },
    { id: 'workers', name: 'workers', parentGroupId: 'monkey' },
  ]
  const forest = buildDeckForest(groups, [
    session('reviewer', 'monkey'),
    session('worker-a', 'workers'),
    session('loose'),
  ])

  assert.equal(forest.length, 1)
  assert.equal(forest[0].sessions[0].id, 'reviewer')
  assert.equal(forest[0].children[0].group.id, 'workers')
  assert.equal(forest[0].children[0].sessions[0].id, 'worker-a')
  assert.equal(countDeckDescendants(forest[0]), 3)
})

test('buildDeckForest promotes orphaned and cyclic groups to safe roots', () => {
  const groups: GroupInfo[] = [
    { id: 'orphan', name: 'orphan', parentGroupId: 'missing' },
    { id: 'a', name: 'a', parentGroupId: 'b' },
    { id: 'b', name: 'b', parentGroupId: 'a' },
  ]
  const rootIds = buildDeckForest(groups, []).map((node) => node.group.id)
  assert.deepEqual(rootIds, ['orphan', 'a', 'b'])
})

test('Deck axes alternate and vertical branches choose the side with room', () => {
  assert.equal(nextDeckAxis('vertical'), 'horizontal')
  assert.equal(nextDeckAxis('horizontal'), 'vertical')
  assert.equal(chooseVerticalDirection(300, 360, 180, 650), 'down')
  assert.equal(chooseVerticalDirection(500, 560, 180, 650), 'up')
})

test('clicking a Deck group opens every descendant group in its subtree', () => {
  const groups: GroupInfo[] = [
    { id: 'monkey', name: 'monkey' },
    { id: 'workers', name: 'workers', parentGroupId: 'monkey' },
    { id: 'qa', name: 'qa', parentGroupId: 'monkey' },
    { id: 'e2e', name: 'e2e', parentGroupId: 'qa' },
  ]
  const root = buildDeckForest(groups, [session('worker-a', 'workers'), session('tester', 'e2e')])[0]

  assert.deepEqual(collectDeckSubtreeGroupIds(root), ['monkey', 'workers', 'qa', 'e2e'])
  assert.deepEqual(toggleDeckSubtree([], root, true), ['monkey', 'workers', 'qa', 'e2e'])
  assert.deepEqual(toggleDeckSubtree(['monkey', 'qa'], root, true), ['monkey', 'workers', 'qa', 'e2e'])
  assert.deepEqual(toggleDeckSubtree(['monkey', 'workers', 'qa', 'e2e'], root, true), [])
})

test('nested Deck groups toggle their own subtree without closing siblings', () => {
  const groups: GroupInfo[] = [
    { id: 'monkey', name: 'monkey' },
    { id: 'workers', name: 'workers', parentGroupId: 'monkey' },
    { id: 'qa', name: 'qa', parentGroupId: 'monkey' },
    { id: 'e2e', name: 'e2e', parentGroupId: 'qa' },
  ]
  const root = buildDeckForest(groups, [])[0]
  const qa = root.children.find((child) => child.group.id === 'qa')!
  const allOpen = collectDeckSubtreeGroupIds(root)

  assert.deepEqual(toggleDeckSubtree(allOpen, qa), ['monkey', 'workers'])
  assert.deepEqual(toggleDeckSubtree(['monkey', 'workers'], qa), ['monkey', 'workers', 'qa', 'e2e'])
  assert.deepEqual(openDeckGroup(['monkey'], 'monkey'), ['monkey'])
  assert.deepEqual(openDeckGroup(['monkey'], 'workers'), ['monkey', 'workers'])
})

test('SessionDeck wires group clicks to recursive subtree expansion', async () => {
  const source = await readFile(new URL('../src/renderer/pet/SessionDeck.tsx', import.meta.url), 'utf8')

  assert.match(source, /toggleDeckSubtree\(openGroupIds, node, depth === 0\)/)
  assert.match(source, /const isOpen = openGroupIds\.includes\(groupId\)/)
})

test('child group creation uses the in-app name dialog instead of Electron window.prompt', async () => {
  const source = await readFile(new URL('../src/renderer/pet/SessionDeck.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /window\.prompt\(['"]子分组名称/)
  assert.match(source, /openChildGroupDialog\([\s\S]*?groupId,[\s\S]*?depth,[\s\S]*?event\.clientX,[\s\S]*?event\.clientY,/)
  assert.match(source, /<DeckNameDialog/)
})

test('Deck renames sessions and groups through the in-app name dialog', async () => {
  const source = await readFile(new URL('../src/renderer/pet/SessionDeck.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /window\.prompt/)
  assert.match(source, /interface RenameDialogState/)
  assert.match(source, /initialValue=\{renameDialog\.currentName\}/)
  assert.match(source, /await onRename\(renameDialog\.id, name\)/)
  assert.match(source, /await window\.api\.invoke\('group:rename', renameDialog\.id, name\)/)
})

test('session rename uses Hive dedicated rename command and reports sync failures', async () => {
  const handlers = await readFile(new URL('../src/main/ipc/session-handlers.ts', import.meta.url), 'utf8')
  const start = handlers.indexOf("ipcMain.handle('session:rename'")
  const end = handlers.indexOf("ipcMain.handle('session:set-roles'", start)
  const renameHandler = handlers.slice(start, end)

  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  assert.match(renameHandler, /await renameAgent\(session\.hiveAgentId, cleanTitle\)/)
  assert.doesNotMatch(renameHandler, /hiveCli\(\['agent', 'register'/)
  assert.match(renameHandler, /localRenamed: true/)
})

test('Deck keeps one shared rail and dismisses expanded branches away from it', async () => {
  const source = await readFile(new URL('../src/renderer/pet/SessionDeck.tsx', import.meta.url), 'utf8')
  const css = await readFile(new URL('../src/renderer/pet/SessionDeck.css', import.meta.url), 'utf8')
  const groupAddCss = css.match(/\.session-deck__group-add \{([^}]*)\}/)?.[1] || ''

  assert.match(source, /window\.api\.on\('window-blur', closeTransientSurfaces\)/)
  assert.match(source, /const collapseBranches = useCallback\(\(\) => \{[\s\S]*?setOpenGroupIds\(\[\]\)/)
  assert.match(css, /\.session-deck__rail \{[\s\S]*?background: linear-gradient/)
  assert.match(groupAddCss, /bottom: -6px;/)
  assert.doesNotMatch(groupAddCss, /top: -6px;/)
})

test('Deck keeps session creation in its footer and offers both start paths', async () => {
  const source = await readFile(new URL('../src/renderer/pet/SessionDeck.tsx', import.meta.url), 'utf8')
  const canvas = await readFile(new URL('../src/renderer/pet/PetCanvas.tsx', import.meta.url), 'utf8')
  const css = await readFile(new URL('../src/renderer/pet/SessionDeck.css', import.meta.url), 'utf8')

  assert.match(source, /className="session-deck__footer"/)
  assert.match(source, /📂 从目录开始/)
  assert.match(source, /💬 直接开始/)
  assert.match(source, /ref=\{createButtonRef\}/)
  assert.match(source, /anchorRef=\{createButtonRef\}/)
  assert.match(canvas, /onCreateDirect=\{\(\) => setShowInput\(true\)\}/)
  assert.match(canvas, /onCreateInDirectory=\{handleOpenInDir\}/)
  assert.match(css, /\.session-deck__footer \{[\s\S]*?z-index: 30;/)
})

test('Deck scrolls root sessions above its footer without clipping open branches', async () => {
  const source = await readFile(new URL('../src/renderer/pet/SessionDeck.tsx', import.meta.url), 'utf8')
  const css = await readFile(new URL('../src/renderer/pet/SessionDeck.css', import.meta.url), 'utf8')
  const deckCss = css.match(/\.session-deck \{([^}]*)\}/)?.[1] || ''
  const rootScrollCss = css.match(/\.session-deck__root-scroll \{([^}]*)\}/)?.[1] || ''

  assert.match(deckCss, /position: fixed;/)
  assert.match(deckCss, /inset: 0;/)
  assert.match(rootScrollCss, /overflow-y: auto;/)
  assert.match(source, /createPortal\(branch, branchPortalRef\.current\)/)
  assert.match(source, /onScroll=\{collapseBranches\}/)
  assert.match(css, /\.session-deck__branch\.is-portaled \{[\s\S]*?position: fixed;/)
})
