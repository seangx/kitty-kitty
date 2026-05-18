/**
 * Wakeup server — receives "needs your input" notifications from claude-code
 * (and other tools' equivalents) via a unix-domain HTTP socket and forwards
 * them to the pet window so the right session bubble lights up.
 *
 * Layout:
 *   ~/.kitty-kitty/wakeup.sock     ← unix domain socket
 *
 * Hook command (installed into ~/.claude/settings.json):
 *   curl -s --max-time 2 --unix-socket "$HOME/.kitty-kitty/wakeup.sock" \
 *        -H 'X-Kitty-Session: '"${HIVE_AGENT_KEY:-}" \
 *        -X POST 'http://_/wakeup' --data-binary @-
 *
 * Payload coming in (claude Notification hook):
 *   {
 *     "session_id": "...claude jsonl uuid...",
 *     "transcript_path": "...",
 *     "hook_event_name": "Notification",
 *     "message": "...human readable..."
 *   }
 *
 * We map to a kitty session row by:
 *   1) X-Kitty-Session header (HIVE_AGENT_KEY env injected on pane creation) — primary
 *   2) `session_id` matches sessions.claude_session_id — fallback
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import { existsSync, mkdirSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log } from './logger'
import { getPetWindow } from './windows/pet-window'
import * as sessionRepo from './db/session-repo'

const SOCK_DIR = join(homedir(), '.kitty-kitty')
const SOCK_PATH = join(SOCK_DIR, 'wakeup.sock')

let server: Server | null = null

/** Sessions currently in "needs input" state, addressed by kitty session id. */
const pending = new Map<string, { type: string; message: string; ts: string }>()

export function getPendingInput(): string[] {
  return [...pending.keys()]
}

export function clearNeedsInput(kittyId: string): void {
  if (pending.delete(kittyId)) {
    const win = getPetWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('session:needs-input-clear', { sessionId: kittyId })
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (c: Buffer) => {
      chunks.push(c)
      total += c.length
      if (total > 64 * 1024) { reject(new Error('payload too large')); req.destroy() }
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function resolveKittySessionId(kittyHeader: string | undefined, claudeSessionId: string | undefined): string | null {
  // Header from HIVE_AGENT_KEY env wins — it's the kitty session id directly.
  if (kittyHeader && /^[a-f0-9]{6,}$/i.test(kittyHeader)) {
    const row = sessionRepo.listSessions().find((s) => s.id === kittyHeader)
    if (row) return row.id
  }
  // Fallback: match by externalSessionId (claude jsonl uuid).
  if (claudeSessionId) {
    const row = sessionRepo.listSessions().find((s) => s.externalSessionId === claudeSessionId)
    if (row) return row.id
  }
  return null
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/wakeup') {
    res.statusCode = 404
    res.end('not found')
    return
  }
  let body = ''
  try { body = await readBody(req) } catch (err) {
    res.statusCode = 400
    res.end(String(err))
    return
  }

  let payload: any = {}
  try { payload = body ? JSON.parse(body) : {} } catch { /* may be empty */ }

  const kittyHeader = (req.headers['x-kitty-session'] as string | undefined)?.trim()
  const claudeSessionId = typeof payload?.session_id === 'string' ? payload.session_id : undefined
  const message: string = typeof payload?.message === 'string' ? payload.message : ''
  // claude-code Notification payload doesn't include `notification_type` (issue #11964),
  // so we keep this as a best-effort tag derived from the message.
  const type: string =
    /permission/i.test(message) ? 'permission_prompt' :
    /elicit|choose|question/i.test(message) ? 'elicitation_dialog' :
    'notification'

  const kittyId = resolveKittySessionId(kittyHeader, claudeSessionId)
  if (!kittyId) {
    log('wakeup', `no matching session (header=${kittyHeader || ''} claudeId=${claudeSessionId || ''})`)
    res.statusCode = 200
    res.end(JSON.stringify({ ok: false, reason: 'no-match' }))
    return
  }

  pending.set(kittyId, { type, message, ts: new Date().toISOString() })
  log('wakeup', `${kittyId} needs input (${type}): ${message.slice(0, 80)}`)

  const win = getPetWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('session:needs-input', { sessionId: kittyId, type, message })
  }

  res.statusCode = 200
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true, sessionId: kittyId }))
}

export function startWakeupServer(): void {
  if (server) return
  try { mkdirSync(SOCK_DIR, { recursive: true }) } catch { /* ignore */ }
  // Best-effort cleanup of stale socket from a prior crashed process.
  if (existsSync(SOCK_PATH)) {
    try { unlinkSync(SOCK_PATH) } catch { /* ignore */ }
  }
  server = createServer((req, res) => { void handleRequest(req, res) })
  server.on('error', (err) => log('wakeup', 'server error:', err))
  server.listen(SOCK_PATH, () => log('wakeup', `listening on ${SOCK_PATH}`))
}

export function stopWakeupServer(): void {
  if (!server) return
  try { server.close() } catch { /* ignore */ }
  server = null
  try { if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH) } catch { /* ignore */ }
}

export const WAKEUP_SOCK_PATH = SOCK_PATH
