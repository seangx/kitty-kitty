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
}

export interface RegisterCodexAgentResult {
  success: boolean
  agentId?: string
  error?: string
}

export async function registerCodexAgent(input: RegisterCodexAgentInput): Promise<RegisterCodexAgentResult> {
  const args = [
    'agent', 'register',
    '--key', input.key,
    '--tool', 'codex',
    '--display-name', input.displayName,
  ]
  if (input.projectDir) args.push('--project-dir', input.projectDir)
  if (input.roles) args.push('--roles', input.roles)

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
  log('hive-codex', `registered codex agent ${input.displayName} (${agentId.slice(0, 12)}…)`)
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

export async function renameAgent(agentId: string, newDisplayName: string): Promise<{ success: boolean; error?: string }> {
  if (!agentId || !newDisplayName) return { success: false, error: 'missing agentId or name' }
  const r = await runHive(['agent', 'rename', agentId, newDisplayName], { timeoutMs: 5000 })
  if (r.code !== 0) {
    log('hive-codex', `rename failed: ${r.stderr.trim()}`)
    return { success: false, error: r.stderr.trim() || `kitty-hive exited ${r.code}` }
  }
  return { success: true }
}
