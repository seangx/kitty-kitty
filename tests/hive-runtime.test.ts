import assert from 'node:assert/strict'
import test from 'node:test'
import { daemonRespawn } from '../src/main/hive-runtime.ts'

test('force respawn preserves a Codex thread and returns fresh remote coordinates', async () => {
  let requestedUrl = ''
  let requestedBody = ''
  const result = await daemonRespawn('agent-codex', (async (url, init) => {
    requestedUrl = String(url)
    requestedBody = String(init?.body)
    return Response.json({
      ok: true,
      ready: true,
      status: 'ready',
      tool: 'codex',
      conversation: { id: 'thread-1', requested_id: 'thread-1', preserved: true },
      attach: { kind: 'codex-remote', ws_url: 'ws://127.0.0.1:44111', thread_id: 'thread-1' },
    })
  }) as typeof fetch)

  assert.equal(requestedUrl, 'http://127.0.0.1:4123/admin/daemon-respawn')
  assert.deepEqual(JSON.parse(requestedBody), { agent_id: 'agent-codex' })
  assert.deepEqual(result, {
    kind: 'ok',
    tool: 'codex',
    attach: { kind: 'codex-remote', ws_url: 'ws://127.0.0.1:44111', thread_id: 'thread-1' },
  })
})

test('force respawn accepts fresh OpenCode attach credentials', async () => {
  const result = await daemonRespawn('agent-opencode', (async () => Response.json({
    ok: true,
    ready: true,
    status: 'ready',
    tool: 'opencode',
    conversation: { id: 'ses_1', requested_id: 'ses_1', preserved: true },
    attach: {
      kind: 'opencode-attach',
      server_url: 'http://127.0.0.1:43123',
      session_id: 'ses_1',
      server_username: 'opencode',
      server_password: 'fresh-secret',
      version: '1.2.3',
    },
  })) as typeof fetch)

  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.attach.kind, 'opencode-attach')
    assert.equal(result.attach.kind === 'opencode-attach' && result.attach.server_password, 'fresh-secret')
  }
})

test('force respawn fails closed when Hive changes the conversation', async () => {
  const result = await daemonRespawn('agent-1', (async () => Response.json({
    ok: false,
    ready: true,
    status: 'conversation_changed',
    conversation: { id: 'thread-2', requested_id: 'thread-1', preserved: false },
    attach: { kind: 'codex-remote', ws_url: 'ws://new', thread_id: 'thread-2' },
  }, { status: 409 })) as typeof fetch)

  assert.equal(result.kind, 'conversation_changed')
})

test('force respawn does not reuse stale coordinates after a Hive timeout', async () => {
  const result = await daemonRespawn('agent-1', (async () => Response.json({
    ok: false,
    ready: false,
    status: 'timeout',
    attach: null,
  })) as typeof fetch)

  assert.equal(result.kind, 'timeout')
})
