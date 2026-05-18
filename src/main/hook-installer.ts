/**
 * Claude Code hook installer.
 *
 * On startup we ensure ~/.claude/settings.json contains a Notification hook
 * that POSTs claude's hook payload (stdin JSON) to our wakeup unix socket.
 * The hook is idempotently keyed by `KITTY_KITTY_WAKEUP_HOOK` so we can
 * detect it across re-runs and refresh it if the command changes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log } from './logger'
import { WAKEUP_SOCK_PATH } from './wakeup'

const HOOK_TAG = 'KITTY_KITTY_WAKEUP_HOOK'

function buildHookCommand(): string {
  // Hook receives the Notification payload as JSON on stdin.
  // We forward it to the wakeup socket and tag the kitty session via a header
  // sourced from the HIVE_AGENT_KEY env we inject when creating the pane.
  // Tag the command itself with HOOK_TAG so we can recognize and refresh it.
  return [
    `# ${HOOK_TAG}`,
    `curl -s --max-time 2 --unix-socket "${WAKEUP_SOCK_PATH}"`,
    `  -H 'X-Kitty-Session: '"\${HIVE_AGENT_KEY:-}"`,
    `  -X POST 'http://_/wakeup' --data-binary @- || true`,
  ].join(' \\\n')
}

interface HookEntry { type: string; command: string }
interface NotificationGroup { matcher?: string; hooks: HookEntry[] }

export function ensureClaudeNotificationHook(): void {
  const settingsPath = join(homedir(), '.claude', 'settings.json')
  let settings: any = {}
  try {
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    } else {
      mkdirSync(join(homedir(), '.claude'), { recursive: true })
    }
  } catch (err) {
    log('hook-installer', 'failed to read settings.json:', err)
    return
  }

  if (!settings || typeof settings !== 'object') settings = {}
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}
  if (!Array.isArray(settings.hooks.Notification)) settings.hooks.Notification = []

  const desiredCommand = buildHookCommand()
  const groups: NotificationGroup[] = settings.hooks.Notification

  // Find an existing group containing our tagged hook.
  let foundGroup: NotificationGroup | undefined
  let foundHook: HookEntry | undefined
  for (const g of groups) {
    if (!Array.isArray(g.hooks)) continue
    for (const h of g.hooks) {
      if (typeof h?.command === 'string' && h.command.includes(HOOK_TAG)) {
        foundGroup = g
        foundHook = h
        break
      }
    }
    if (foundHook) break
  }

  if (foundHook && foundHook.command === desiredCommand) {
    return  // already up-to-date
  }

  if (foundHook) {
    foundHook.command = desiredCommand
    foundHook.type = 'command'
    log('hook-installer', 'refreshed kitty wakeup hook command')
  } else {
    groups.push({
      // No matcher → match all Notification events. We rely on message content
      // for type discrimination since the payload lacks notification_type
      // (claude-code issue #11964).
      hooks: [{ type: 'command', command: desiredCommand }],
    })
    log('hook-installer', 'installed kitty wakeup hook into ~/.claude/settings.json')
  }

  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  } catch (err) {
    log('hook-installer', 'failed to write settings.json:', err)
  }
}
