/**
 * Wakeup server — receives lifecycle events from supported tools through a
 * unix-domain HTTP socket. It keeps external session ids synchronized and
 * also accepts pane-side UI actions.
 *
 * Layout:
 *   ~/.kitty-kitty/wakeup.sock     ← unix domain socket
 *
 * Hook command (installed into ~/.claude/settings.json):
 *   curl -s --max-time 2 --unix-socket "$HOME/.kitty-kitty/wakeup.sock" \
 *        -H 'X-Kitty-Session: '"${HIVE_AGENT_KEY:-}" \
 *        -X POST 'http://_/wakeup' --data-binary @-
 *
 * Payload coming in (claude Stop hook):
 *   {
 *     "session_id": "...claude jsonl uuid...",
 *     "transcript_path": "...",
 *     "hook_event_name": "Stop"
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
import { showCompletionNotification } from './windows/completion-notification-window'
import * as sessionRepo from './db/session-repo'
import { clearMark } from './session-clear-state'
import { CODEX_TURN_COMPLETED_EVENT } from '@shared/completion-notification'

const SOCK_DIR = join(homedir(), '.kitty-kitty')
const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects')

/**
 * Verify that `<session_id>.jsonl` for claude lives under the encoded cwd
 * directory — proves the running claude is in that project, not somewhere
 * else the user manually cd'd into. Tries both the legacy `/` → `-` and
 * the current `[/.]` → `-` encodings so older jsonl layouts still match.
 */
export function isJsonlInCwd(sessionId: string, cwd: string): boolean {
  return claudeJsonlPath(sessionId, cwd) !== null
}

/** 同 isJsonlInCwd,但返回 jsonl 的实际绝对路径(不存在返回 null)。 */
export function claudeJsonlPath(sessionId: string, cwd: string): string | null {
  if (!sessionId || !cwd) return null
  const candidates = [
    cwd.replace(/[/.]/g, '-'),
    cwd.replace(/\//g, '-'),
  ]
  for (const enc of candidates) {
    const p = join(CLAUDE_PROJECTS, enc, `${sessionId}.jsonl`)
    if (existsSync(p)) return p
  }
  return null
}
export const WAKEUP_SOCK_PATH = join(SOCK_DIR, 'wakeup.sock')

let server: Server | null = null

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

function resolveKittySessionId(kittyHeader: string | undefined, externalSessionId: string | undefined): string | null {
  // Header from HIVE_AGENT_KEY env wins — it's the kitty session id directly.
  if (kittyHeader && /^[a-f0-9]{6,}$/i.test(kittyHeader)) {
    const row = sessionRepo.listSessions().find((s) => s.id === kittyHeader)
    if (row) return row.id
  }
  // Fallback: match by externalSessionId (claude jsonl uuid).
  if (externalSessionId) {
    const row = sessionRepo.listSessions().find((s) => s.externalSessionId === externalSessionId)
    if (row) return row.id
  }
  return null
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'POST' && req.url === '/pane-action') {
    return handlePaneAction(req, res)
  }
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
  const externalSessionId = typeof payload?.session_id === 'string' ? payload.session_id : undefined
  const sourceTool = typeof payload?.tool === 'string' ? payload.tool : 'claude'
  const hookEvent: string =
    typeof payload?.hook_event_name === 'string' ? payload.hook_event_name
      : typeof payload?.event === 'string' ? payload.event
        : ''
  const notificationType: string =
    typeof payload?.notification_type === 'string' ? payload.notification_type : ''

  const kittyId = resolveKittySessionId(kittyHeader, externalSessionId)
  if (!kittyId) {
    log('wakeup', `no matching session (header=${kittyHeader || ''} externalId=${externalSessionId || ''} tool=${sourceTool} event=${hookEvent})`)
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
  if (externalSessionId) {
    try {
      const row = sessionRepo.listSessions().find((s) => s.id === kittyId)
      if (row && row.externalSessionId !== externalSessionId) {
        const validForTool = sourceTool === 'opencode'
          ? row.tool === 'opencode'
          : row.tool === 'claude' && isJsonlInCwd(externalSessionId, row.cwd)
        if (validForTool) {
          sessionRepo.updateSessionExternalId(kittyId, externalSessionId)
          // The genuinely-new jsonl has appeared (and is cwd-validated), so a
          // prior "新对话" clear is now resolved — lift the mark so normal
          // sync/restart behaviour resumes.
          clearMark(kittyId)
          log('wakeup', `${kittyId} externalSessionId synced: ${(row.externalSessionId || '(none)').slice(0, 8)} → ${externalSessionId.slice(0, 8)} (tool=${sourceTool} event=${hookEvent})`)
        } else {
          log('wakeup', `${kittyId} REJECT external sync: ${externalSessionId.slice(0, 8)} rowTool=${row.tool} sourceTool=${sourceTool} cwd=${row.cwd} (event=${hookEvent})`)
        }
      }
    } catch (err) { log('wakeup', 'updateSessionExternalId failed:', err) }
  }

  if (notificationType === CODEX_TURN_COMPLETED_EVENT) {
    const row = sessionRepo.listSessions().find((session) => session.id === kittyId)
    if (row?.tool === 'codex') {
      showCompletionNotification(row.id, row.title)
    } else {
      log('wakeup', `ignored ${CODEX_TURN_COMPLETED_EVENT} for non-codex session ${kittyId}`)
    }
  }

  res.statusCode = 200
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true, sessionId: kittyId, event: hookEvent }))
}

/**
 * `/pane-action` — tmux-side trigger for kitty UI actions (Alt+C "clear",
 * future Alt+R "restart", etc.). The shell helper invoked by tmux's
 * `bind-key -n M-c` POSTs:
 *   { pane_id: "%42", action: "clear-conversation" }
 * We reverse-lookup the kitty session row whose `pane_id` matches, then
 * dispatch the same IPC handler the right-click context menu uses, so both
 * entry points produce identical effects.
 */
async function handlePaneAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body = ''
  try { body = await readBody(req) } catch (err) {
    res.statusCode = 400
    res.end(String(err))
    return
  }
  let payload: any = {}
  try { payload = JSON.parse(body) } catch { /* ignore */ }
  const paneId: string = typeof payload?.pane_id === 'string' ? payload.pane_id : ''
  const action: string = typeof payload?.action === 'string' ? payload.action : ''
  if (!paneId || !action) {
    res.statusCode = 400
    res.end(JSON.stringify({ ok: false, reason: 'pane_id+action required' }))
    return
  }
  const row = sessionRepo.listSessions().find((s) => s.paneId === paneId)
  if (!row) {
    log('pane-action', `no row for pane_id=${paneId} action=${action}`)
    res.statusCode = 200
    res.end(JSON.stringify({ ok: false, reason: 'no matching session' }))
    return
  }
  const win = getPetWindow()
  if (!win || win.isDestroyed()) {
    res.statusCode = 500
    res.end(JSON.stringify({ ok: false, reason: 'pet window gone' }))
    return
  }
  // Fan out to renderer via a synthetic event the same way wakeup does.
  // The renderer subscribes once at startup and dispatches to the right handler.
  win.webContents.send('pane:action', { sessionId: row.id, action })
  log('pane-action', `${row.title} ← ${action} (pane ${paneId})`)
  res.statusCode = 200
  res.end(JSON.stringify({ ok: true, sessionId: row.id, action }))
}

export function startWakeupServer(): void {
  if (server) return
  try { mkdirSync(SOCK_DIR, { recursive: true }) } catch { /* ignore */ }
  // Best-effort cleanup of stale socket from a prior crashed process.
  if (existsSync(WAKEUP_SOCK_PATH)) {
    try { unlinkSync(WAKEUP_SOCK_PATH) } catch { /* ignore */ }
  }
  server = createServer((req, res) => { void handleRequest(req, res) })
  server.on('error', (err) => log('wakeup', 'server error:', err))
  server.listen(WAKEUP_SOCK_PATH, () => log('wakeup', `listening on ${WAKEUP_SOCK_PATH}`))
}

export function stopWakeupServer(): void {
  if (!server) return
  try { server.close() } catch { /* ignore */ }
  server = null
  try { if (existsSync(WAKEUP_SOCK_PATH)) unlinkSync(WAKEUP_SOCK_PATH) } catch { /* ignore */ }
}
