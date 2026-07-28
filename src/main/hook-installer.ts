/**
 * Claude Code hook installer.
 *
 * On startup we ensure ~/.claude/settings.json contains a Stop hook that POSTs
 * claude's payload (stdin JSON) to our wakeup unix socket. It keeps kitty's DB
 * externalSessionId in sync with claude's actual jsonl so `/clear` (which
 * silently rolls to a new session id) survives kitty restarts.
 *
 * Older Kitty versions also installed a Notification hook for the removed
 * "needs input" badge. Reconciliation removes only our tagged legacy hook and
 * preserves every user-owned Notification hook.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log } from './logger'
import { WAKEUP_SOCK_PATH } from './wakeup'

const HOOK_TAG = 'KITTY_KITTY_WAKEUP_HOOK'
const SESSION_SYNC_EVENT = 'Stop'

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

function removeTaggedHookForEvent(settings: any, event: string): boolean {
  if (!Array.isArray(settings?.hooks?.[event])) return false
  const groups: HookGroup[] = settings.hooks[event]
  let changed = false
  const nextGroups = groups.flatMap((group) => {
    if (!Array.isArray(group?.hooks)) return [group]
    const hooks = group.hooks.filter((hook) => {
      const tagged = typeof hook?.command === 'string' && hook.command.includes(HOOK_TAG)
      if (tagged) changed = true
      return !tagged
    })
    return hooks.length > 0 ? [{ ...group, hooks }] : []
  })
  if (!changed) return false
  if (nextGroups.length > 0) settings.hooks[event] = nextGroups
  else delete settings.hooks[event]
  log('hook-installer', `removed legacy kitty wakeup hook for ${event}`)
  return true
}

export function reconcileClaudeSessionSyncHooks(settings: any, desiredCommand = buildHookCommand()): boolean {
  if (!settings || typeof settings !== 'object') return false
  const installed = ensureHookForEvent(settings, SESSION_SYNC_EVENT, desiredCommand)
  const removedLegacyNotification = removeTaggedHookForEvent(settings, 'Notification')
  return installed || removedLegacyNotification
}

export function ensureClaudeSessionSyncHook(): void {
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

  if (!reconcileClaudeSessionSyncHooks(settings)) return

  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  } catch (err) {
    log('hook-installer', 'failed to write settings.json:', err)
  }
}
