import assert from 'node:assert/strict'
import test from 'node:test'
import { formatPaneLabel } from '../src/main/tmux/pane-label.ts'

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
