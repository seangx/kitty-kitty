/**
 * Claude Code hook installer.
 *
 * On startup we ensure ~/.claude/settings.json contains hooks that POST
 * claude's payload (stdin JSON) to our wakeup unix socket. Two events:
 *   - Notification → "needs your input" badge.
 *   - Stop         → after every assistant turn, used to keep kitty's DB
 *                    externalSessionId in sync with claude's actual jsonl
 *                    so `/clear` (which silently rolls to a new session id)
 *                    survives kitty restarts.
 *
 * Both hooks are idempotently keyed by `KITTY_KITTY_WAKEUP_HOOK` so we can
 * detect and refresh them across re-runs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log } from './logger'
import { WAKEUP_SOCK_PATH } from './wakeup'

const HOOK_TAG = 'KITTY_KITTY_WAKEUP_HOOK'
const HOOK_EVENTS = ['Notification', 'Stop'] as const

function buildHookCommand(): string {
  // Hook receives the event payload as JSON on stdin.
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
interface HookGroup { matcher?: string; hooks: HookEntry[] }

function ensureHookForEvent(settings: any, event: string, desiredCommand: string): boolean {
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = []

  const groups: HookGroup[] = settings.hooks[event]

  let foundHook: HookEntry | undefined
  for (const g of groups) {
    if (!Array.isArray(g.hooks)) continue
    for (const h of g.hooks) {
      if (typeof h?.command === 'string' && h.command.includes(HOOK_TAG)) {
        foundHook = h
        break
      }
    }
    if (foundHook) break
  }

  if (foundHook && foundHook.command === desiredCommand) return false

  if (foundHook) {
    foundHook.command = desiredCommand
    foundHook.type = 'command'
    log('hook-installer', `refreshed kitty wakeup hook for ${event}`)
  } else {
    groups.push({ hooks: [{ type: 'command', command: desiredCommand }] })
    log('hook-installer', `installed kitty wakeup hook for ${event}`)
  }
  return true
}

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

  const desiredCommand = buildHookCommand()
  let dirty = false
  for (const event of HOOK_EVENTS) {
    if (ensureHookForEvent(settings, event, desiredCommand)) dirty = true
  }
  if (!dirty) return

  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  } catch (err) {
    log('hook-installer', 'failed to write settings.json:', err)
  }
}
