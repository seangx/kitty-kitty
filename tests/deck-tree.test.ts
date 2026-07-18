import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDeckForest,
  chooseVerticalDirection,
  countDeckDescendants,
  nextDeckAxis,
  openDeckPath,
  toggleDeckPath,
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

test('toggleDeckPath keeps one active group per hierarchy depth', () => {
  assert.deepEqual(toggleDeckPath(['monkey', 'workers'], 1, 'qa'), ['monkey', 'qa'])
  assert.deepEqual(toggleDeckPath(['monkey', 'workers'], 1, 'workers'), ['monkey'])
})

test('openDeckPath opens a parent after creating its child group', () => {
  assert.deepEqual(openDeckPath(['monkey', 'old-child'], 1, 'workers'), ['monkey', 'workers'])
})
