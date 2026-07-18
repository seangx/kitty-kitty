import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatPaneLabel,
  PANE_BORDER_FORMAT,
  PANE_BORDER_STATUS,
  resolveSessionPaneId,
} from '../src/main/tmux/pane-label.ts'

test('places each pane label on its bottom-right border', () => {
  assert.equal(PANE_BORDER_STATUS, 'bottom')
  assert.match(PANE_BORDER_FORMAT, /align=right/)
  assert.doesNotMatch(PANE_BORDER_FORMAT, /pane_index/)
})

test('shows a Kitty custom session name with its directory', () => {
  assert.equal(formatPaneLabel('frontend agent', '/repo/monkeys'), 'frontend agent (monkeys)')
})

test('does not repeat the directory when it is also the session name', () => {
  assert.equal(formatPaneLabel('monkeys', '/repo/monkeys'), 'monkeys')
})

test('falls back to the directory and flattens custom-name line breaks', () => {
  assert.equal(formatPaneLabel('', '/repo/monkeys'), 'monkeys')
  assert.equal(formatPaneLabel('frontend\nagent', '/repo/monkeys'), 'frontend agent (monkeys)')
})

test('targets the recorded pane id when sibling sessions share a directory', () => {
  const panes = [
    { paneId: '%1', cwd: '/repo/monkeys' },
    { paneId: '%2', cwd: '/repo/monkeys' },
  ]
  assert.equal(resolveSessionPaneId({ paneId: '%2', cwd: '/repo/monkeys' }, panes), '%2')
})

test('falls back only when cwd or the sole pane identifies one target', () => {
  const panes = [
    { paneId: '%1', cwd: '/repo/a' },
    { paneId: '%2', cwd: '/repo/b' },
  ]
  assert.equal(resolveSessionPaneId({ paneId: '', cwd: '/repo/b' }, panes), '%2')
  assert.equal(resolveSessionPaneId({ paneId: '', cwd: '/repo/missing' }, panes), undefined)
  assert.equal(resolveSessionPaneId({ paneId: '', cwd: '/repo/missing' }, [panes[0]]), '%1')
})
