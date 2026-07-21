const HIVE_ADMIN_URL = 'http://127.0.0.1:4123'

export type DaemonRespawnAttach =
  | { kind: 'codex-remote'; ws_url: string; thread_id: string }
  | {
      kind: 'opencode-attach'
      server_url: string
      session_id: string
      server_username: string
      server_password: string
      version?: string
    }

export type DaemonRespawnResult =
  | { kind: 'ok'; tool: 'codex' | 'opencode'; attach: DaemonRespawnAttach }
  | { kind: 'timeout'; message: string }
  | { kind: 'conversation_changed'; message: string }
  | { kind: 'error'; message: string }

/**
 * Ask Hive to replace an agent's supervised runtime while preserving its
 * current conversation. Kitty never kills or identifies the concrete server
 * process; Hive owns the lifecycle and returns fresh attach coordinates.
 */
export async function daemonRespawn(
  agentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DaemonRespawnResult> {
  try {
    const response = await fetchImpl(`${HIVE_ADMIN_URL}/admin/daemon-respawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId }),
      signal: AbortSignal.timeout(50_000),
    })
    const body = await response.json().catch(() => null) as Record<string, any> | null

    if (response.status === 409 || body?.status === 'conversation_changed') {
      return {
        kind: 'conversation_changed',
        message: 'Hive 重启后会话 ID 发生变化，已停止重连以避免接错会话',
      }
    }
    if (body?.status === 'timeout') {
      return { kind: 'timeout', message: 'Hive runtime 重启超时，未使用旧连接地址' }
    }
    if (!response.ok || body?.ok !== true || body?.ready !== true || body?.status !== 'ready') {
      return {
        kind: 'error',
        message: String(body?.error || `Hive daemon respawn failed (${response.status})`),
      }
    }

    const tool = body.tool
    const attach = body.attach
    if (tool !== 'codex' && tool !== 'opencode') {
      return { kind: 'error', message: `Hive 返回了不支持的 runtime 工具: ${String(tool || 'unknown')}` }
    }
    if (attach?.kind === 'codex-remote'
      && typeof attach.ws_url === 'string' && attach.ws_url
      && typeof attach.thread_id === 'string' && attach.thread_id) {
      return { kind: 'ok', tool, attach: attach as DaemonRespawnAttach }
    }
    if (attach?.kind === 'opencode-attach'
      && typeof attach.server_url === 'string' && attach.server_url
      && typeof attach.session_id === 'string' && attach.session_id
      && typeof attach.server_username === 'string'
      && typeof attach.server_password === 'string') {
      return { kind: 'ok', tool, attach: attach as DaemonRespawnAttach }
    }
    return { kind: 'error', message: 'Hive runtime 已重启，但返回的 attach 凭据不完整' }
  } catch (err: any) {
    if (err?.name === 'TimeoutError') {
      return { kind: 'timeout', message: 'Hive runtime 重启等待超过 50 秒，未使用旧连接地址' }
    }
    return { kind: 'error', message: String(err?.message || err) }
  }
}
