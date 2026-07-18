import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatPaneLabel,
  PANE_BORDER_FORMAT,
  PANE_BORDER_STATUS,
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
