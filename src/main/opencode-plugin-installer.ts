import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { log } from './logger'
import { WAKEUP_SOCK_PATH } from './wakeup'
import { buildOpenCodePlugin } from './opencode-plugin-template'

export { buildOpenCodePlugin } from './opencode-plugin-template'

export function ensureOpenCodePlugin(): void {
  const file = join(homedir(), '.config', 'opencode', 'plugins', 'kitty-kitty.js')
  const desired = buildOpenCodePlugin(WAKEUP_SOCK_PATH)
  try {
    if (existsSync(file) && readFileSync(file, 'utf8') === desired) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, desired)
    log('opencode-plugin', `installed ${file}`)
  } catch (err) {
    log('opencode-plugin', 'install failed:', err)
  }
}
