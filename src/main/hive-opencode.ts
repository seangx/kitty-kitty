import { runHive } from './hive-cli.ts'

export interface OpenCodePaneServerResult {
  status: 'ready' | 'starting' | 'not_supervised' | 'timeout' | 'error'
  agent_id?: string
  display_name?: string
  server_url?: string
  session_id?: string
  server_username?: string
  server_password?: string
  error?: string
}

export async function openCodePaneServer(input: {
  key: string
  timeoutMs?: number
}): Promise<OpenCodePaneServerResult> {
  const timeoutMs = input.timeoutMs ?? 10_000
  const result = await runHive(
    ['opencode-pane', 'server', '--key', input.key, '--timeout-ms', String(timeoutMs)],
    { timeoutMs: timeoutMs + 2000 },
  )
  const raw = result.stdout.trim()
  if (!raw) {
    return { status: 'error', error: result.stderr.trim() || `kitty-hive exited ${result.code}` }
  }
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed?.status === 'string') return parsed as OpenCodePaneServerResult
    return { status: 'error', error: 'malformed kitty-hive response' }
  } catch {
    return { status: 'error', error: result.stderr.trim() || 'invalid kitty-hive JSON response' }
  }
}

export type OpenCodeSetSessionResult =
  | { kind: 'ok'; pane: OpenCodePaneServerResult }
  | { kind: 'timeout'; message: string }
  | { kind: 'error'; message: string }

export async function openCodeSetSession(
  agentId: string,
  sessionId: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenCodeSetSessionResult> {
  try {
    const response = await fetchImpl('http://127.0.0.1:4123/admin/opencode-set-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId, session_id: sessionId }),
      signal: AbortSignal.timeout(47_000),
    })
    const body = await response.json().catch(() => null) as Record<string, any> | null
    if (!response.ok || !body?.ok || !body?.ready) {
      return { kind: 'error', message: String(body?.error || `hive ${response.status}`) }
    }
    return {
      kind: 'ok',
      pane: {
        status: 'ready',
        agent_id: agentId,
        server_url: String(body.server_url || ''),
        session_id: String(body.session_id || ''),
        server_username: String(body.server_username || ''),
        server_password: String(body.server_password || ''),
      },
    }
  } catch (err: any) {
    if (err?.name === 'TimeoutError') return { kind: 'timeout', message: 'OpenCode daemon switch timed out' }
    return { kind: 'error', message: String(err?.message || err) }
  }
}

export async function openCodePromptAsync(
  pane: OpenCodePaneServerResult,
  prompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ success: boolean; error?: string }> {
  if (!prompt.trim()) return { success: true }
  if (!pane.server_url || !pane.session_id || !pane.server_username || !pane.server_password) {
    return { success: false, error: 'OpenCode attach credentials incomplete' }
  }
  const auth = Buffer.from(`${pane.server_username}:${pane.server_password}`).toString('base64')
  try {
    const response = await fetchImpl(
      `${pane.server_url.replace(/\/$/, '')}/session/${encodeURIComponent(pane.session_id)}/prompt_async`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ parts: [{ type: 'text', text: prompt }] }),
        signal: AbortSignal.timeout(30_000),
      },
    )
    if (response.ok) return { success: true }
    const detail = await response.text().catch(() => '')
    return { success: false, error: `OpenCode HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` }
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) }
  }
}
