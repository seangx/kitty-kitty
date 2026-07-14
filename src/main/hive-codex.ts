/**
 * kitty-hive CLI helpers for codex path B integration.
 *
 * - registerCodexAgent: tells hive about a codex agent so its supervisor
 *   spawns a `codex app-server` daemon for it. Returns the hive agent_id.
 * - codexPaneWs: queries the daemon's ws_url + thread_id, blocking up to
 *   `timeoutMs` for status to flip from 'starting' → 'ready'.
 * - renameAgent: rename via the dedicated CLI (NOT `register` — hive's
 *   silent-rename defence refuses display_name changes on the key path).
 *
 * All helpers shell out to the `kitty-hive` binary. Stderr is captured into
 * the logger for diagnostics, stdout is parsed.
 */

import { spawn } from 'child_process'
import { log } from './logger'

const HIVE_BIN = 'kitty-hive'
const DEFAULT_TIMEOUT_MS = 10000

function runHive(args: string[], opts: { timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(HIVE_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString() })
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString() })
    const timer = opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, opts.timeoutMs)
      : null
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(err) })
    })
  })
}

export interface RegisterCodexAgentInput {
  key: string
  displayName: string
  projectDir?: string
  roles?: string
  /** 注册为哪个工具(默认 codex)。Alt+X 变回 claude 时传 'claude'。 */
  tool?: 'codex' | 'claude'
  /** 显式允许切换已有 agent 的 tool(hive ≥0.7.7 的防护闸开口)。 */
  switchTool?: boolean
}

export interface RegisterCodexAgentResult {
  success: boolean
  agentId?: string
  error?: string
}

/**
 * 能力探测:hive CLI 是否支持 --switch-tool。
 * 不按版本号挂钩——0.7.7 的 `--version` 未实现(实测 Unknown command),而旧版
 * 对未知 flag 静默忽略(试错也探不出);grep register --help 是可靠信号。
 * 缓存 10 分钟,升级 CLI 后最迟 10 分钟生效。
 */
let switchToolProbe: { at: number; ok: boolean } | null = null
export async function hiveSupportsSwitchTool(): Promise<boolean> {
  if (switchToolProbe && Date.now() - switchToolProbe.at < 600_000) return switchToolProbe.ok
  const r = await runHive(['agent', 'register', '--help'], { timeoutMs: 3000 })
  const ok = (r.stdout + r.stderr).includes('--switch-tool')
  switchToolProbe = { at: Date.now(), ok }
  return ok
}

export async function registerCodexAgent(input: RegisterCodexAgentInput): Promise<RegisterCodexAgentResult> {
  const tool = input.tool || 'codex'
  const args = [
    'agent', 'register',
    '--key', input.key,
    '--tool', tool,
    '--display-name', input.displayName,
  ]
  if (input.projectDir) args.push('--project-dir', input.projectDir)
  if (input.roles) args.push('--roles', input.roles)
  if (input.switchTool) args.push('--switch-tool')

  const r = await runHive(args, { timeoutMs: 5000 })
  if (r.code !== 0) {
    log('hive-codex', `register failed (code=${r.code}): ${r.stderr.trim()}`)
    return { success: false, error: r.stderr.trim() || `kitty-hive exited ${r.code}` }
  }
  // stdout: single line = agent_id
  const agentId = r.stdout.trim().split('\n').pop()?.trim() || ''
  if (!agentId) {
    log('hive-codex', `register: empty agent_id in stdout (stderr=${r.stderr.trim()})`)
    return { success: false, error: 'empty agent_id from kitty-hive' }
  }
  log('hive-codex', `registered ${tool} agent ${input.displayName} (${agentId.slice(0, 12)}…)${input.switchTool ? ' [switch-tool]' : ''}`)
  return { success: true, agentId }
}

export interface CodexPaneWsInput {
  key: string
  timeoutMs?: number
}

export type CodexPaneWsStatus = 'ready' | 'starting' | 'not_supervised' | 'timeout' | 'error'

export interface CodexPaneWsResult {
  status: CodexPaneWsStatus
  ws_url?: string
  thread_id?: string
  agent_id?: string
  display_name?: string
  error?: string
}

export async function codexPaneWs(input: CodexPaneWsInput): Promise<CodexPaneWsResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // We give the CLI a generous wall-clock cushion (timeoutMs + 2s) so its own
  // internal poll has a chance to finish before we kill it.
  const r = await runHive(
    ['codex-pane', 'ws', '--key', input.key, '--timeout-ms', String(timeoutMs)],
    { timeoutMs: timeoutMs + 2000 },
  )
  // Even error statuses come on stdout as JSON.
  const raw = r.stdout.trim()
  if (!raw) {
    return { status: 'error', error: r.stderr.trim() || `kitty-hive exited ${r.code}` }
  }
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed?.status === 'string') return parsed as CodexPaneWsResult
    // Lenient: intermediate response without `status` (hive 0.7.0-pre quirk)
    // — infer from `ready` boolean. Used when callers pass a tiny timeoutMs
    // and probe before the daemon's first ready flip.
    if (typeof parsed?.ready === 'boolean') {
      return parsed.ready
        ? { status: 'ready', ws_url: parsed.ws_url, thread_id: parsed.thread_id, agent_id: parsed.agent_id, display_name: parsed.display_name }
        : { status: 'starting', agent_id: parsed.agent_id, display_name: parsed.display_name }
    }
    return { status: 'error', error: 'malformed kitty-hive response' }
  } catch (err) {
    return { status: 'error', error: String(err) }
  }
}

/**
 * POST /admin/codex-set-thread — switch (or reset) a codex agent's daemon
 * thread. Hive's supervisor SIGTERMs the daemon and respawns it bound to the
 * requested thread (or a fresh one when `threadId` is null).
 *
 * Maps to four outcomes the caller must distinguish:
 *   - 'ok'              normal success; { threadId, wsUrl } reflect the new bound thread
 *   - 'resumed_as_new'  resume failed (jsonl corrupted etc.); daemon fell back to a fresh
 *                       thread. UI should surface "session couldn't be restored, new one started"
 *   - 'timeout'         30s elapsed, daemon not yet ready; UI should poll codexPaneWs
 *   - 'error'           validation failure / network / unreachable
 */
export type SetThreadResult =
  | { kind: 'ok'; threadId: string; wsUrl: string }
  | { kind: 'resumed_as_new'; threadId: string; wsUrl: string; originalRequest: string }
  | { kind: 'timeout'; requested: string | null }
  | { kind: 'error'; message: string }

const HIVE_ADMIN_URL = 'http://127.0.0.1:4123'

export async function codexSetThread(agentId: string, threadId: string | null): Promise<SetThreadResult> {
  let res: Response
  try {
    res = await fetch(`${HIVE_ADMIN_URL}/admin/codex-set-thread`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId, thread_id: threadId }),
    })
  } catch (err: any) {
    return { kind: 'error', message: `hive unreachable: ${err?.message || err}` }
  }
  let body: any
  try { body = await res.json() } catch { body = {} }
  if (!res.ok) {
    return { kind: 'error', message: body?.error || `hive ${res.status}` }
  }
  if (!body.ok) {
    return { kind: 'timeout', requested: threadId }
  }
  if (typeof body.thread_id !== 'string' || typeof body.ws_url !== 'string') {
    return { kind: 'error', message: 'hive returned malformed response' }
  }
  if (threadId && body.thread_id !== threadId) {
    return {
      kind: 'resumed_as_new',
      threadId: body.thread_id,
      wsUrl: body.ws_url,
      originalRequest: threadId,
    }
  }
  return { kind: 'ok', threadId: body.thread_id, wsUrl: body.ws_url }
}

export async function renameAgent(agentId: string, newDisplayName: string): Promise<{ success: boolean; error?: string }> {
  if (!agentId || !newDisplayName) return { success: false, error: 'missing agentId or name' }
  const r = await runHive(['agent', 'rename', agentId, newDisplayName], { timeoutMs: 5000 })
  if (r.code !== 0) {
    log('hive-codex', `rename failed: ${r.stderr.trim()}`)
    return { success: false, error: r.stderr.trim() || `kitty-hive exited ${r.code}` }
  }
  return { success: true }
}
