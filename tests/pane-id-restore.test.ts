import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const handlers = readFileSync(
  new URL('../src/main/ipc/session-handlers.ts', import.meta.url),
  'utf8',
)

test('restored tmux sessions persist their new pane id before returning', () => {
  const start = handlers.indexOf('function tryRestoreSession(')
  const end = handlers.indexOf('\n}\n\n/**', start)
  const block = handlers.slice(start, end)

  assert.match(block, /new-session/)
  assert.match(block, /list-panes[^]*#\{pane_id\}/)
  assert.match(block, /updateSessionPaneId\(row\.id, paneId\)/)
})
