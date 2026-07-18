import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { ExternalSessionEntry, ExternalSessionProvider } from './external-session'

interface OpenCodeSessionJson {
  id?: unknown
  title?: unknown
  updated?: unknown
  created?: unknown
  directory?: unknown
}

function findOpenCode(): string {
  const candidates = [
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
    join(homedir(), '.local', 'bin', 'opencode'),
    join(homedir(), '.opencode', 'bin', 'opencode'),
  ]
  return candidates.find(existsSync) || 'opencode'
}

export function parseOpenCodeSessions(raw: string, projectDir: string): ExternalSessionEntry[] {
  let rows: OpenCodeSessionJson[] = []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) rows = parsed
  } catch { return [] }

  return rows
    .filter((row) => typeof row.id === 'string' && row.id && row.directory === projectDir)
    .map((row) => {
      const ts = typeof row.updated === 'number'
        ? row.updated
        : typeof row.created === 'number' ? row.created : 0
      return {
        id: row.id as string,
        summary: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : 'OpenCode session',
        date: ts > 0 ? new Date(ts).toISOString() : '',
        cwd: projectDir,
        cwdMatch: true,
      }
    })
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

function listSessions(projectDir: string): ExternalSessionEntry[] {
  try {
    const raw = execFileSync(
      findOpenCode(),
      ['session', 'list', '--format', 'json', '--max-count', '200'],
      {
        cwd: projectDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${join(homedir(), '.local', 'bin')}:${join(homedir(), '.opencode', 'bin')}:${process.env.PATH || ''}`,
        },
      },
    )
    return parseOpenCodeSessions(raw, projectDir)
  } catch { return [] }
}

export const opencodeProvider: ExternalSessionProvider = {
  tool: 'opencode',

  findSessions(projectDir) {
    return listSessions(projectDir).slice(0, 8)
  },

  findUnclaimedSessionId(cwd, claimed) {
    return listSessions(cwd).find((entry) => !claimed.has(entry.id))?.id || null
  },

  deleteSessionFile(sessionId, cwd) {
    execFileSync(findOpenCode(), ['session', 'delete', sessionId], {
      cwd,
      stdio: 'ignore',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${join(homedir(), '.local', 'bin')}:${join(homedir(), '.opencode', 'bin')}:${process.env.PATH || ''}`,
      },
    })
  },
}
