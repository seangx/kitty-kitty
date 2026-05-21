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
const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects')

/**
 * Verify that `<session_id>.jsonl` for claude lives under the encoded cwd
 * directory — proves the running claude is in that project, not somewhere
 * else the user manually cd'd into. Tries both the legacy `/` → `-` and
 * the current `[/.]` → `-` encodings so older jsonl layouts still match.
 */
export function isJsonlInCwd(sessionId: string, cwd: string): boolean {
  if (!sessionId || !cwd) return false
  const candidates = [
    cwd.replace(/[/.]/g, '-'),
    cwd.replace(/\//g, '-'),
  ]
  for (const enc of candidates) {
    if (existsSync(join(CLAUDE_PROJECTS, enc, `${sessionId}.jsonl`))) return true
  }
  return false
}
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
  const hookEvent: string = typeof payload?.hook_event_name === 'string' ? payload.hook_event_name : ''
  // claude-code Notification payload doesn't include `notification_type` (issue #11964),
  // so we keep this as a best-effort tag derived from the message.
  const type: string =
    /permission/i.test(message) ? 'permission_prompt' :
    /elicit|choose|question/i.test(message) ? 'elicitation_dialog' :
    'notification'

  const kittyId = resolveKittySessionId(kittyHeader, claudeSessionId)
  if (!kittyId) {
    log('wakeup', `no matching session (header=${kittyHeader || ''} claudeId=${claudeSessionId || ''} event=${hookEvent})`)
    res.statusCode = 200
    res.end(JSON.stringify({ ok: false, reason: 'no-match' }))
    return
  }

  // Opportunistically keep DB's externalSessionId in sync with claude's
  // actual active jsonl. /clear silently rolls to a new session_id; without
  // this sync, kitty's first-launch restore on next startup would resume the
  // stale id and the post-/clear conversation would appear "gone".
  //
  // SAFETY: only sync when the jsonl file for `session_id` actually lives in
  // the row's claimed cwd. claude stores jsonls under
  //   ~/.claude/projects/<encoded(cwd)>/<session_id>.jsonl
  // so a present file at that exact path proves the running claude is in this
  // row's project — not a different project the user manually cd'd into.
  // Without this check, a user (or stray script) running claude from a
  // different cwd while carrying our HIVE_AGENT_KEY would silently rebind the
  // row to the wrong jsonl (see kitty issue: 两个 pane 都变成 kitty-hive).
  if (claudeSessionId) {
    try {
      const row = sessionRepo.listSessions().find((s) => s.id === kittyId)
      if (row && row.externalSessionId !== claudeSessionId) {
        if (isJsonlInCwd(claudeSessionId, row.cwd)) {
          sessionRepo.updateSessionExternalId(kittyId, claudeSessionId)
          log('wakeup', `${kittyId} externalSessionId synced: ${(row.externalSessionId || '(none)').slice(0, 8)} → ${claudeSessionId.slice(0, 8)} (event=${hookEvent})`)
        } else {
          log('wakeup', `${kittyId} REJECT cross-cwd sync: jsonl ${claudeSessionId.slice(0, 8)} not in ${row.cwd} (event=${hookEvent})`)
        }
      }
    } catch (err) { log('wakeup', 'updateSessionExternalId failed:', err) }
  }

  // Only Notification events surface the "needs your input" badge. Stop
  // events are purely for the externalSessionId sync above.
  if (hookEvent === 'Notification' || (!hookEvent && message)) {
    pending.set(kittyId, { type, message, ts: new Date().toISOString() })
    log('wakeup', `${kittyId} needs input (${type}): ${message.slice(0, 80)}`)
    const win = getPetWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('session:needs-input', { sessionId: kittyId, type, message })
    }
  }

  res.statusCode = 200
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true, sessionId: kittyId, event: hookEvent }))
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
