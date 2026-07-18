import assert from 'node:assert/strict'
import test from 'node:test'
import { openCodePromptAsync, openCodeSetSession } from '../src/main/hive-opencode.ts'

test('switches the supervised daemon to a fresh session and returns attach credentials', async () => {
  let requestedBody = ''
  const result = await openCodeSetSession('agent-123', null, (async (_url, init) => {
    requestedBody = String(init?.body)
    return Response.json({
      ok: true,
      ready: true,
      server_url: 'http://127.0.0.1:43123',
      session_id: 'ses_fresh_123',
      server_username: 'opencode',
      server_password: 'secret',
    })
  }) as typeof fetch)

  assert.deepEqual(JSON.parse(requestedBody), { agent_id: 'agent-123', session_id: null })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.pane.agent_id, 'agent-123')
    assert.equal(result.pane.session_id, 'ses_fresh_123')
    assert.equal(result.pane.server_password, 'secret')
  }
})

test('injects an initial prompt into the supervised OpenCode session', async () => {
  let requestedUrl = ''
  let requestedInit: RequestInit | undefined
  const result = await openCodePromptAsync({
    status: 'ready',
    server_url: 'http://127.0.0.1:43123',
    session_id: 'ses_hive_123',
    server_username: 'opencode',
    server_password: 'secret',
  }, '先读取项目规则', (async (url: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(url)
    requestedInit = init
    return new Response(null, { status: 204 })
  }) as typeof fetch)

  assert.deepEqual(result, { success: true })
  assert.equal(requestedUrl, 'http://127.0.0.1:43123/session/ses_hive_123/prompt_async')
  assert.equal(requestedInit?.method, 'POST')
  assert.equal((requestedInit?.headers as Record<string, string>).Authorization, 'Basic b3BlbmNvZGU6c2VjcmV0')
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
    parts: [{ type: 'text', text: '先读取项目规则' }],
  })
})

test('does not send a prompt without complete attach credentials', async () => {
  const result = await openCodePromptAsync({ status: 'ready' }, 'hello')
  assert.equal(result.success, false)
  assert.match(result.error || '', /credentials incomplete/)
})
