import { execFileSync } from 'child_process'

const DEFAULT_HIVE_PORT = 4123

export interface OpenCodeHiveInitResult {
  success: boolean
  error?: string
}

interface HiveInitOptions {
  port?: number
  run?: typeof execFileSync
}

/** Ensure OpenCode can see the local Hive MCP without making Hive mandatory. */
export function ensureOpenCodeHiveMcp(options: HiveInitOptions = {}): OpenCodeHiveInitResult {
  const run = options.run || execFileSync
  const port = options.port || DEFAULT_HIVE_PORT
  try {
    run('kitty-hive', ['init', 'opencode', '--port', String(port)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
      },
    })
    return { success: true }
  } catch (err: any) {
    const detail = String(err?.stderr || err?.message || err).trim()
    return { success: false, error: detail || 'kitty-hive init opencode failed' }
  }
}
