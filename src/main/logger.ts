import { appendFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

let logPath = '/tmp/kitty-kitty.log'

export function initLogger(): void {
  try {
    logPath = join(app.getPath('userData'), 'kitty-kitty.log')
  } catch {
    // app not ready yet, use /tmp
  }
  // Clear log on startup
  try { writeFileSync(logPath, `[${ts()}] === Kitty Kitty started ===\n`) } catch {}
}

function ts(): string {
  return new Date().toISOString().slice(11, 23)
}

export function log(tag: string, ...args: unknown[]): void {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
  const line = `[${ts()}] [${tag}] ${msg}\n`
  try { appendFileSync(logPath, line) } catch {}
}

export function getLogPath(): string {
  return logPath
}
