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

/** Walk recent day folders, yielding headers for files matching `cwdFilter`, newest first. */
function findHeadersForCwd(cwd: string, dayLimit: number, capFiles: number): CodexHeader[] {
  const matches: CodexHeader[] = []
  let read = 0
  // Collect candidate files first (across day folders) then sort by mtime desc.
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
    if (h.cwd !== cwd) continue
    matches.push({ id: h.id, cwd: h.cwd, filePath: c.filePath, mtime: c.mtime })
  }
  return matches
}

export const codexProvider: ExternalSessionProvider = {
  tool: 'codex',

  findSessions(projectDir) {
    const headers = findHeadersForCwd(projectDir, SCAN_DAY_LIMIT, READ_FILE_CAP)
    return headers.slice(0, 5).map((h) => ({
      id: h.id,
      summary: h.id.slice(0, 8),
      date: new Date(h.mtime).toISOString().slice(0, 16).replace('T', ' '),
    }))
  },

  findUnclaimedSessionId(cwd, claimed) {
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
