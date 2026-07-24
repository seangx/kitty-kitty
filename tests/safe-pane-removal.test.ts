import test from 'node:test'
import assert from 'node:assert/strict'
import { planSharedPaneRemoval } from '../src/main/safe-pane-removal.ts'

test('shared pane removal accepts a live pane owned only by the target row', () => {
  const plan = planSharedPaneRemoval(
    { id: 'reviewer', cwd: '/repo', paneId: '%2' },
    [{ id: 'slave', cwd: '/repo', paneId: '%1' }],
    [
      { paneId: '%1', cwd: '/repo' },
      { paneId: '%2', cwd: '/repo' },
    ],
  )

  assert.deepEqual(plan, { kind: 'kill-pane', paneId: '%2' })
})

test('shared pane removal recovers one uniquely unclaimed pane by cwd', () => {
  const plan = planSharedPaneRemoval(
    { id: 'reviewer', cwd: '/review', paneId: '%stale' },
    [{ id: 'slave', cwd: '/work', paneId: '%1' }],
    [
      { paneId: '%1', cwd: '/work' },
      { paneId: '%2', cwd: '/review' },
    ],
  )

  assert.deepEqual(plan, { kind: 'kill-pane', paneId: '%2' })
})

test('shared pane removal never kills the only live pane while sibling rows remain', () => {
  const plan = planSharedPaneRemoval(
    { id: 'reviewer', cwd: '/repo', paneId: '%2' },
    [{ id: 'slave', cwd: '/repo', paneId: '%1' }],
    [{ paneId: '%2', cwd: '/repo' }],
  )

  assert.deepEqual(plan, { kind: 'preserve-host', reason: 'last-live-pane' })
})

test('shared pane removal refuses stale or ambiguous ownership instead of killing the host', () => {
  const plan = planSharedPaneRemoval(
    { id: 'reviewer', cwd: '/repo', paneId: '%stale-a' },
    [{ id: 'slave', cwd: '/repo', paneId: '%stale-b' }],
    [
      { paneId: '%1', cwd: '/repo' },
      { paneId: '%2', cwd: '/repo' },
    ],
  )

  assert.deepEqual(plan, { kind: 'preserve-host', reason: 'pane-not-proven' })
})

test('shared pane removal refuses when the target pane id is also claimed by a sibling', () => {
  const plan = planSharedPaneRemoval(
    { id: 'reviewer', cwd: '/review', paneId: '%1' },
    [{ id: 'slave', cwd: '/work', paneId: '%1' }],
    [
      { paneId: '%1', cwd: '/work' },
      { paneId: '%2', cwd: '/review' },
    ],
  )

  assert.deepEqual(plan, { kind: 'preserve-host', reason: 'pane-not-proven' })
})
