import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  assertCodexThreadAvailable,
  CodexThreadCollisionError,
  findCodexThreadCollision,
  type CodexThreadSession,
} from '../src/main/codex-thread-ownership.ts'

const sessions: CodexThreadSession[] = [
  {
    id: 'slave',
    title: 'monkeys-slave',
    tool: 'codex',
    externalSessionId: 'thread-shared',
  },
  {
    id: 'reviewer',
    title: 'monkeys-reviewer',
    tool: 'codex',
    externalSessionId: 'thread-reviewer',
  },
  {
    id: 'claude-peer',
    title: 'claude-peer',
    tool: 'claude',
    externalSessionId: 'thread-claude',
  },
]

test('Codex thread ownership rejects a sibling rollout but allows the current owner', () => {
  const collision = findCodexThreadCollision(sessions, 'reviewer', 'thread-shared')
  assert.equal(collision?.owner.id, 'slave')
  assert.equal(collision?.threadId, 'thread-shared')

  assert.equal(findCodexThreadCollision(sessions, 'slave', 'thread-shared'), null)
  assert.equal(findCodexThreadCollision(sessions, 'reviewer', ''), null)
  assert.equal(findCodexThreadCollision(sessions, 'reviewer', 'thread-claude'), null)
})

test('Codex thread ownership error identifies both sessions without changing state', () => {
  assert.throws(
    () => assertCodexThreadAvailable(sessions, 'reviewer', 'thread-shared'),
    (error: unknown) => {
      assert.ok(error instanceof CodexThreadCollisionError)
      assert.equal(error.sessionId, 'reviewer')
      assert.equal(error.owner.id, 'slave')
      return true
    },
  )
  assert.equal(sessions[1].externalSessionId, 'thread-reviewer')
})

test('session runtime checks ownership before drift healing and daemon attach', () => {
  const handlers = readFileSync(
    new URL('../src/main/ipc/session-handlers.ts', import.meta.url),
    'utf8',
  )
  const repo = readFileSync(
    new URL('../src/main/db/session-repo.ts', import.meta.url),
    'utf8',
  )

  assert.match(handlers, /codexThreadIsAvailable\(session\.id, live, 'pane drift heal'\)/)
  assert.match(handlers, /codexThreadIsAvailable\(session\.id, ws\.thread_id, 'restart daemon attach'\)/)
  assert.match(handlers, /startExclusiveCodexThread\(reg\.agentId, args\.kittyId, 'fresh bridge collision recovery'\)/)
  assert.match(handlers, /assertCodexThreadIsAvailable\(session\.id, externalSessionId, 'force restart daemon attach'\)/)
  assert.match(repo, /assertCodexThreadAvailable\(rows, id, externalSessionId\)/)
})
