import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ExternalSessionEntry, ExternalSessionProvider } from './external-session'

/**
 * Codex stores sessions at ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
 * The first JSON line is `session_meta` with `payload.id` (uuid) and `payload.cwd`.
 *
 * There's no per-cwd directory, so to match a session to a cwd we have to read the
 * first line of each candidate file. For perf we only walk recent day folders and
 * cap how many files we read.
 */

const CODEX_SESSIONS = join(homedir(), '.codex', 'sessions')
const SCAN_DAY_LIMIT = 30        // how many recent day folders to walk for `findSessions`
const SYNC_DAY_LIMIT = 3         // tighter window for backfill (only-just-launched sessions)
const READ_FILE_CAP = 80         // never read more than this many file headers per call

interface CodexHeader {
  id: string
  cwd: string
  filePath: string
  mtime: number
}

function* walkRecentDayFolders(dayLimit: number): Generator<string> {
  if (!existsSync(CODEX_SESSIONS)) return
  let years: string[] = []
  try { years = readdirSync(CODEX_SESSIONS).filter((y) => /^\d{4}$/.test(y)).sort().reverse() } catch { return }
  let yielded = 0
  for (const y of years) {
    const yPath = join(CODEX_SESSIONS, y)
    let months: string[] = []
    try { months = readdirSync(yPath).filter((m) => /^\d{2}$/.test(m)).sort().reverse() } catch { continue }
    for (const m of months) {
      const mPath = join(yPath, m)
      let days: string[] = []
      try { days = readdirSync(mPath).filter((d) => /^\d{2}$/.test(d)).sort().reverse() } catch { continue }
      for (const d of days) {
        yield join(mPath, d)
        if (++yielded >= dayLimit) return
      }
    }
  }
}

/** Read only the first line of a (potentially huge) jsonl by streaming chunks. */
function readFirstLine(filePath: string, maxBytes = 256 * 1024): string | null {
  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(16 * 1024)
    let acc = ''
    let totalRead = 0
    while (totalRead < maxBytes) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      acc += buf.slice(0, n).toString('utf-8')
      totalRead += n
      const nl = acc.indexOf('\n')
      if (nl >= 0) return acc.slice(0, nl)
    }
    // No newline found — return what we have if we already exhausted the file
    return acc || null
  } catch {
    return null
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* ignore */ } }
  }
}

/**
 * Read the first ~512KB of a rollout and pull out the first "real" user
 * message text — i.e. not the synthetic `<environment_context>` / permissions
 * / `<user_instructions>` blocks codex prepends to every thread. Used to give
 * the user a recognizable preview in pickers and drift dialogs.
 */
const PREVIEW_SCAN_BYTES = 512 * 1024

function readUserPreview(filePath: string): string {
  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(32 * 1024)
    let acc = ''
    let totalRead = 0
    while (totalRead < PREVIEW_SCAN_BYTES) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      acc += buf.slice(0, n).toString('utf-8')
      totalRead += n
    }
    for (const line of acc.split('\n')) {
      const t = line.trim()
      if (!t) continue
      let parsed: any
      try { parsed = JSON.parse(t) } catch { continue }
      const payload = parsed?.payload ?? parsed
      if (!payload || typeof payload !== 'object') continue
      if (payload.type !== 'message' || payload.role !== 'user') continue
      const content = payload.content
      if (!Array.isArray(content)) continue
      for (const item of content) {
        if (!item || typeof item !== 'object') continue
        const text: unknown = item.text ?? item.input_text ?? null
        if (typeof text !== 'string') continue
        if (
          text.startsWith('<environment_context>') ||
          text.startsWith('<permissions instructions>') ||
          text.startsWith('<user_instructions>') ||
          text.startsWith('# AGENTS.md')
        ) continue
        const oneLine = text.replace(/\s+/g, ' ').trim()
        if (oneLine.length === 0) continue
        return oneLine.slice(0, 80)
      }
    }
  } catch { /* ignore */ } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* ignore */ } }
  }
  return ''
}

function readHeader(filePath: string): { id: string; cwd: string } | null {
  // session_meta is the first line. Codex embeds `base_instructions.text`
  // (the full system prompt) in it, so the line can easily exceed 20KB.
  const firstLine = readFirstLine(filePath)
  if (!firstLine || !firstLine.trim()) return null
  try {
    const parsed = JSON.parse(firstLine)
    if (parsed?.type !== 'session_meta') return null
    const id = parsed.payload?.id
    const cwd = parsed.payload?.cwd
    if (typeof id !== 'string' || typeof cwd !== 'string') return null
    return { id, cwd }
  } catch { return null }
}

/**
 * Walk recent day folders and return headers.
 *
 * Returns two lists:
 *  - `matched`: rollouts whose header `cwd` equals `cwd` (strict match)
 *  - `recent`:  the most-recent rollouts across ALL cwds (sorted by mtime desc)
 *
 * Strict cwd matching catches the common case. The `recent` list exists
 * because codex rollouts record the cwd codex was launched with, NOT
 * necessarily the project directory the user thinks of as "this session".
 * A user may start codex from $HOME (or worktree root, or anywhere) then
 * work on a project — the rollout header still says $HOME. Without a
 * fallback the drift/restore path would never find the rollout.
 */
function findHeaders(cwd: string, dayLimit: number, capFiles: number): { matched: CodexHeader[]; recent: CodexHeader[] } {
  const matched: CodexHeader[] = []
  const recent: CodexHeader[] = []
  let read = 0
  const candidates: { filePath: string; mtime: number }[] = []
  for (const dayDir of walkRecentDayFolders(dayLimit)) {
    let files: string[] = []
    try { files = readdirSync(dayDir).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl')) } catch { continue }
    for (const f of files) {
      const filePath = join(dayDir, f)
      try { candidates.push({ filePath, mtime: statSync(filePath).mtimeMs }) } catch { /* ignore */ }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)

  for (const c of candidates) {
    if (read >= capFiles) break
    read++
    const h = readHeader(c.filePath)
    if (!h) continue
    const header: CodexHeader = { id: h.id, cwd: h.cwd, filePath: c.filePath, mtime: c.mtime }
    recent.push(header)
    if (h.cwd === cwd) matched.push(header)
  }
  return { matched, recent }
}

/** Backwards-compatible cwd-filtered view used by deleteSessionFile. */
function findHeadersForCwd(cwd: string, dayLimit: number, capFiles: number): CodexHeader[] {
  return findHeaders(cwd, dayLimit, capFiles).matched
}

export const codexProvider: ExternalSessionProvider = {
  tool: 'codex',

  findSessions(projectDir) {
    const { matched, recent } = findHeaders(projectDir, SCAN_DAY_LIMIT, READ_FILE_CAP)
    // Prefer cwd-matched results; if 0 matches, fall back to recent rollouts
    // across ALL cwds so drift detection / picker still surfaces the actual
    // active rollout when codex was launched from a different directory.
    const source = matched.length > 0 ? matched : recent
    return source.slice(0, 5).map((h) => {
      const preview = readUserPreview(h.filePath)
      return {
        id: h.id,
        summary: preview || h.id.slice(0, 8),
        date: new Date(h.mtime).toISOString().slice(0, 16).replace('T', ' '),
        cwd: h.cwd,
        cwdMatch: h.cwd === projectDir,
      }
    })
  },

  findUnclaimedSessionId(cwd, claimed) {
    // Keep strict-cwd matching here: backfill should NOT cross cwds, otherwise
    // two kitty sessions with different cwds could race for the same rollout.
    const headers = findHeadersForCwd(cwd, SYNC_DAY_LIMIT, READ_FILE_CAP)
    for (const h of headers) {
      if (!claimed.has(h.id)) return h.id
    }
    return null
  },

  deleteSessionFile(sessionId, cwd) {
    // The path isn't reconstructible from id alone — search for it.
    const headers = findHeadersForCwd(cwd, SCAN_DAY_LIMIT, READ_FILE_CAP)
    const target = headers.find((h) => h.id === sessionId)
    if (target) {
      try { unlinkSync(target.filePath) } catch { /* ignore */ }
    }
  },
}
