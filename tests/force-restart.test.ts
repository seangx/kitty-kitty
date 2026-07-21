import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const ROOT = new URL('../', import.meta.url)

async function source(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), 'utf8')
}

test('single Codex and OpenCode sessions expose force runtime restart', async () => {
  const [deck, canvas] = await Promise.all([
    source('src/renderer/pet/SessionDeck.tsx'),
    source('src/renderer/pet/PetCanvas.tsx'),
  ])

  assert.match(deck, /selectedSession\.tool === 'codex' \|\| selectedSession\.tool === 'opencode'/)
  assert.match(deck, /'强制重启 Runtime'/)
  assert.match(deck, /onForceRestart\(selectedSession\.id\)/)
  assert.match(canvas, /session:force-restart-agent/)
})

test('force runtime restart is a separate IPC path and group restart stays ordinary', async () => {
  const [handlers, deck] = await Promise.all([
    source('src/main/ipc/session-handlers.ts'),
    source('src/renderer/pet/SessionDeck.tsx'),
  ])

  assert.match(handlers, /ipcMain\.handle\('session:force-restart-agent'/)
  assert.match(handlers, /forceRestartSessionRuntime\(session\)/)
  assert.match(handlers, /if \(!session\.hiveAgentId\)/)
  assert.match(handlers, /const restarted = await daemonRespawn\(session\.hiveAgentId\)/)
  assert.match(handlers, /forceRestartSingleFlight\.run\(id/)
  assert.match(handlers, /const current = await codexPaneWs/)
  assert.match(handlers, /const current = await openCodePaneServer/)
  assert.match(handlers, /selectFreshDaemonAttach\(restarted\.attach, currentAttach\)/)
  assert.match(deck, /forceRestartingSessionIds\.has\(selectedSession\.id\)/)
  assert.match(deck, /disabled=\{selectedSessionForceRestarting\}/)
  const groupRestartStart = deck.indexOf('const restartGroup = useCallback')
  const groupRestartEnd = deck.indexOf('const attach = useCallback', groupRestartStart)
  const groupRestartBlock = deck.slice(groupRestartStart, groupRestartEnd)
  assert.match(groupRestartBlock, /window\.api\.invoke\('group:restart-sessions'/)
  assert.doesNotMatch(groupRestartBlock, /session:force-restart-agent/)
})
