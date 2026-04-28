import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ExternalSessionEntry, ExternalSessionProvider } from './external-session'

/**
 * Claude stores sessions at ~/.claude/projects/<encoded-path>/<uuid>.jsonl
 * The encoding replaces both `/` and `.` with `-` (e.g. /Users/foo.bar → -Users-foo-bar).
 *
 * The legacy `findSessions` view used `/` → `-` only — keep that for the project-picker
 * compatibility, but `findUnclaimedSessionId` uses the `[/.]` form to match real layout.
 */

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects')

export const claudeProvider: ExternalSessionProvider = {
  tool: 'claude',

  findSessions(projectDir) {
    const out: ExternalSessionEntry[] = []
    if (!existsSync(CLAUDE_PROJECTS)) return out

    const encodedPath = projectDir.replace(/\//g, '-')
    const projectDirs = readdirSync(CLAUDE_PROJECTS).filter((d) => d === encodedPath)
    if (projectDirs.length === 0) return out

    for (const dir of projectDirs) {
      const projPath = join(CLAUDE_PROJECTS, dir)
      let files: { name: string; mtime: number }[] = []
      try {
        files = readdirSync(projPath)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => ({ name: f, mtime: statSync(join(projPath, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 5)
      } catch { continue }

      for (const file of files) {
        const id = file.name.replace('.jsonl', '')
        let summary = ''
        let customTitle = ''
        try {
          const content = readFileSync(join(projPath, file.name), 'utf-8')
          for (const line of content.split('\n')) {
            if (!line.trim()) continue
            try {
              const parsed = JSON.parse(line)
              if (parsed.type === 'custom-title' && parsed.customTitle) customTitle = parsed.customTitle
              if (!summary && parsed.type === 'user') {
                let text = parsed.message?.content
                if (Array.isArray(text)) text = text.find((c: any) => c.type === 'text')?.text || ''
                if (typeof text === 'string' && text) summary = text.slice(0, 60)
              }
              if (customTitle && summary) break
            } catch { /* skip bad line */ }
          }
        } catch { /* ignore */ }

        const displaySummary = customTitle || summary || id.slice(0, 8)
        const date = new Date(file.mtime).toISOString().slice(0, 16).replace('T', ' ')
        out.push({ id, summary: displaySummary, date })
      }
    }
    return out
  },

  findUnclaimedSessionId(cwd, claimed) {
    const encoded = cwd.replace(/[/.]/g, '-')
    const dir = join(CLAUDE_PROJECTS, encoded)
    if (!existsSync(dir)) return null

    let files: { name: string; mtime: number }[] = []
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
    } catch { return null }

    for (const f of files) {
      const id = f.name.replace('.jsonl', '')
      if (!claimed.has(id)) return id
    }
    return null
  },

  deleteSessionFile(sessionId, cwd) {
    if (!cwd) return
    const encoded = cwd.replace(/[/.]/g, '-')
    const projPath = join(CLAUDE_PROJECTS, encoded)
    const filePath = join(projPath, `${sessionId}.jsonl`)
    try { if (existsSync(filePath)) unlinkSync(filePath) } catch { /* ignore */ }

    // SessionPicker also passes a `/`-encoded variant; cover that too.
    const slashEncoded = cwd.replace(/\//g, '-')
    if (slashEncoded !== encoded) {
      const altFile = join(CLAUDE_PROJECTS, slashEncoded, `${sessionId}.jsonl`)
      try { if (existsSync(altFile)) unlinkSync(altFile) } catch { /* ignore */ }
      const altDir = join(CLAUDE_PROJECTS, slashEncoded, sessionId)
      try { if (existsSync(altDir)) rmSync(altDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  },
}
