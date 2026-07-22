import { execFileSync, execSync, exec } from 'child_process'
import { existsSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { v4 as uuid } from 'uuid'
import { getDB } from '../db/database'
import { getToolCommand as getConfiguredToolCommand, injectHiveIdentity } from './cli-wrapper'
import {
  childGroupTmuxNamesForTmuxSql,
  groupDepthForTmuxSql,
  groupSubtreeCte,
  ROOT_GROUPS_SQL,
  rootGroupForTmuxSql,
} from './group-tree-sql'
import {
  formatPaneLabel,
  PANE_BORDER_FORMAT,
  PANE_BORDER_STATUS,
  resolveSessionPaneId,
} from './pane-label'
import type { PaneLocation } from './pane-label'
import {
  buildStatusNavigateScript,
  buildStatusRowScript,
  statusLineCountForDepth,
  statusOptionValueForLineCount,
} from './status-scripts'

/** Resolve tmux binary — GUI apps don't inherit homebrew PATH */
function findTmux(): string {
  const candidates = [
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/usr/bin/tmux',
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  // fallback: hope PATH has it
  try {
    return execSync('which tmux', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'tmux'
  }
}

export const TMUX = findTmux()

/**
 * Build the env we pass to `child_process.execSync` when spawning tmux.
 * Critical: scrub HIVE_AGENT_* off `process.env`. If kitty itself was
 * launched (e.g. via `open Kitty Kitty.app`) from a shell that already had
 * HIVE_AGENT_ID / KEY / NAME, those values would otherwise leak into the
 * tmux SERVER's env (tmux server inherits its parent's env at first spawn),
 * making every pane subsequently inherit the wrong identity regardless of
 * the per-row `-e HIVE_AGENT_KEY=...` overrides — the hive plugin's
 * priority is `id > key > name`, so a polluted ID wins. Only inject identity
 * via the explicit `-e` flags on `tmux new-session` / `split-window` /
 * `respawn-pane`.
 */
export function tmuxSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color' }
  delete env.HIVE_AGENT_ID
  delete env.HIVE_AGENT_KEY
  delete env.HIVE_AGENT_NAME
  delete env.KITTY_SESSION_ID
  delete env.KITTY_SESSION_NAME
  return env
}

/** Shell-safe quoting: wraps in single quotes, escapes embedded single quotes */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

export interface TmuxSession {
  id: string
  tmuxName: string
  title: string
  tool: string
  cwd: string
  status: 'running' | 'detached' | 'dead'
  createdAt: string
}

const SESSION_PREFIX = 'kitty_'

export function getToolCommand(tool: string): string {
  // Only used as fallback when no launch script is provided.
  // Keep it on the same executable mapping as generated launch scripts.
  return getConfiguredToolCommand(tool)
}

/**
 * Check if tmux is available
 */
export function hasTmux(): boolean {
  try {
    execSync(`${TMUX} -V`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Create a new tmux session running the specified tool
 */
export function createTmuxSession(
  tool: string,
  firstMessage?: string,
  cwd?: string,
  launchScript?: string,
  presetId?: string,
  presetTitle?: string,
): TmuxSession {
  // Callers can pass a pre-allocated id (e.g. when registering with hive
  // BEFORE the pane spawns, to use the same key end-to-end). Otherwise
  // generate fresh.
  const id = presetId || uuid().slice(0, 8)
  const tmuxName = `${SESSION_PREFIX}${id}`

  // Default cwd: ~/.kitty-kitty/sessions/<id>/, auto-created
  if (!cwd) {
    const { mkdirSync } = require('fs')
    const { homedir } = require('os')
    cwd = join(homedir(), '.kitty-kitty', 'sessions', id)
    mkdirSync(cwd, { recursive: true })
  }

  const dirName = require('path').basename(cwd)
  const title = presetTitle || firstMessage?.slice(0, 40) || dirName

  // Use launch script if provided, otherwise raw tool command
  const command = launchScript || getToolCommand(tool)
  //焊死 hive 身份进脚本本体(根治:不再只靠下面 ephemeral 的 tmux `-e`)
  if (launchScript) injectHiveIdentity(launchScript, id, title)
  // Inject hive identity env so kitty-hive MCP (if installed) auto-registers this agent
  const sessionEnv =
    ` -e ${shellQuote(`KITTY_SESSION_ID=${id}`)}` +
    ` -e ${shellQuote(`KITTY_SESSION_NAME=${title}`)}` +
    ` -e ${shellQuote(`HIVE_AGENT_KEY=${id}`)}` +
    ` -e ${shellQuote(`HIVE_AGENT_NAME=${title}`)}`
  execSync(`${TMUX} new-session -d -s ${shellQuote(tmuxName)} -c ${shellQuote(cwd)}${sessionEnv} ${shellQuote(command)}`, {
    stdio: 'ignore',
    env: tmuxSpawnEnv()
  })

  // If there's a first message, wait a moment then send it
  if (firstMessage && tool !== 'opencode') {
    // Small delay for the CLI to initialize
    setTimeout(() => {
      try {
        sendKeys(tmuxName, firstMessage)
      } catch (e) {
        console.error('[tmux] failed to send first message:', e)
      }
    }, 2000)
  }

  // Configure the kitty status bar for this session
  applyKittyStatusBar(tmuxName)

  return {
    id,
    tmuxName,
    title,
    tool,
    cwd: cwd!,
    status: 'running',
    createdAt: new Date().toISOString()
  }
}

/**
 * Send keystrokes to a tmux session
 */
export function sendKeys(tmuxName: string, text: string): void {
  // Escape special characters for tmux
  // Use load-buffer + paste-buffer to avoid shell expansion of user text
  execSync(`${TMUX} load-buffer -`, { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
  execSync(`${TMUX} paste-buffer -t ${shellQuote(tmuxName)}`, { stdio: 'ignore' })
  execSync(`${TMUX} send-keys -t ${shellQuote(tmuxName)} Enter`, { stdio: 'ignore' })
}

/**
 * Attach to a tmux session by opening the default terminal
 */
export function attachSession(tmuxName: string): void {
  // Ensure status bar is applied (for imported sessions too)
  applyKittyStatusBar(tmuxName)
  refreshAllStatusBars()

  const platform = process.platform

  if (platform === 'darwin') {
    // Check if there's already a Ghostty window running tmux — reuse it via switch-client
    if (hasAnyAttachedClient()) {
      focusSession(tmuxName)
      return
    }
    // No existing terminal window — open one
    exec(`/Applications/Ghostty.app/Contents/MacOS/ghostty --window-save-state=never --confirm-close-surface=false --macos-option-as-alt=true --command=${shellQuote(TMUX + ' attach-session -t ' + shellQuote(tmuxName))}`, {
      env: tmuxSpawnEnv()
    })
  } else if (platform === 'linux') {
    if (hasAnyAttachedClient()) {
      focusSession(tmuxName)
      return
    }
    const terminals = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']
    for (const term of terminals) {
      try {
        execSync(`which ${term}`, { stdio: 'ignore' })
        exec(`${term} -e ${shellQuote('tmux attach-session -t ' + shellQuote(tmuxName))}`)
        return
      } catch { /* try next */ }
    }
  }
}

/**
 * Focus any currently attached session's terminal window.
 * Used for Dock click behavior.
 */
export function focusAnyAttachedSession(): void {
  if (!hasAnyAttachedClient()) return
  if (process.platform === 'darwin') {
    exec(`osascript -e 'tell application "Ghostty" to activate'`)
  }
}

/**
 * List all kitty-kitty tmux sessions and their status
 */
export function listTmuxSessions(): Array<{ name: string; attached: boolean }> {
  try {
    const output = execSync(
      `${TMUX} list-sessions -F "#{session_name}:#{session_attached}"`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return output
      .trim()
      .split('\n')
      .filter((line) => line.startsWith(SESSION_PREFIX))
      .map((line) => {
        const [name, attached] = line.split(':')
        return { name, attached: attached === '1' }
      })
  } catch {
    return []
  }
}

/**
 * List ALL tmux sessions (including non-kitty ones) for import
 */
export function listAllTmuxSessions(): Array<{ name: string; attached: boolean }> {
  try {
    const output = execSync(
      `${TMUX} list-sessions -F "#{session_name}:#{session_attached}"`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return output
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, attached] = line.split(':')
        return { name, attached: attached === '1' }
      })
  } catch {
    return []
  }
}

/**
 * Check if a tmux session has a client attached
 */
export function isSessionAttached(tmuxName: string): boolean {
  try {
    const output = execSync(
      `${TMUX} list-sessions -F "#{session_name}:#{session_attached}"`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const line = output.trim().split('\n').find((l) => l.startsWith(tmuxName + ':'))
    return line ? line.endsWith(':1') : false
  } catch {
    return false
  }
}

/**
 * Check if any kitty tmux session has a client attached (i.e. a terminal window is open)
 */
export function hasAnyAttachedClient(): boolean {
  try {
    const output = execSync(
      `${TMUX} list-sessions -F "#{session_name}:#{session_attached}"`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return output.trim().split('\n')
      .filter((l) => l.startsWith(SESSION_PREFIX))
      .some((l) => l.endsWith(':1'))
  } catch {
    return false
  }
}

/**
 * Check if a tmux session exists and is alive
 */
export function isSessionAlive(tmuxName: string): boolean {
  try {
    execSync(`${TMUX} has-session -t ${shellQuote(tmuxName)}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Focus the Ghostty window that has this tmux session, and switch client to it
 */
export function focusSession(tmuxName: string): void {
  try {
    execSync(`${TMUX} switch-client -t ${shellQuote(tmuxName)}`, { stdio: 'ignore' })
  } catch { /* ignore */ }

  // Sync active group to match the session we just switched to
  syncActiveGroupForSession(tmuxName)

  // Force immediate status bar refresh on all sessions
  refreshAllStatusBars()

  if (process.platform === 'darwin') {
    exec(`osascript -e 'tell application "Ghostty" to activate'`)
  }
}

/**
 * Set KITTY_ACTIVE_GROUP to match the group of a given session.
 * Called when switching sessions via UI click or other non-keybinding paths.
 */
function syncActiveGroupForSession(tmuxName: string): void {
  try {
    const db = getDB()
    const row = db.prepare(rootGroupForTmuxSql('?')).get(tmuxName) as { group_id: string } | undefined
    const groupId = row?.group_id || '__ungrouped__'
    execSync(`${TMUX} set-environment -g KITTY_ACTIVE_GROUP ${shellQuote(groupId)}`, { stdio: 'ignore' })
  } catch { /* ignore */ }
}

export function killSession(tmuxName: string): void {
  try {
    execSync(`${TMUX} kill-session -t ${shellQuote(tmuxName)}`, { stdio: 'ignore' })
  } catch { /* already dead */ }
  // Refresh other sessions' status bars
  refreshAllStatusBars()
}

/**
 * Create a new pane in an existing tmux session by splitting.
 * First split: horizontal (right side, 65% width).
 * Subsequent splits: vertical within the right side.
 * Returns the new pane's tmux pane ID (e.g., %5).
 */
export function createPaneInSession(
  tmuxName: string,
  command: string,
  isFirstSplit: boolean,
  cwd?: string,
  hiveEnv?: { key: string; name: string }
): string {
  const cwdFlag = cwd ? `-c ${shellQuote(cwd)}` : ''
  // Inject hive identity env into the new pane so any in-pane channel client
  // (e.g. claude's hive-channel plugin) can reuse the kitty agent row by key
  // instead of registering a sibling.
  const hiveFlags = hiveEnv
    ? ` -e ${shellQuote(`KITTY_SESSION_ID=${hiveEnv.key}`)}` +
      ` -e ${shellQuote(`KITTY_SESSION_NAME=${hiveEnv.name}`)}` +
      ` -e ${shellQuote(`HIVE_AGENT_KEY=${hiveEnv.key}`)}` +
      ` -e ${shellQuote(`HIVE_AGENT_NAME=${hiveEnv.name}`)}`
    : ''
  //焊死 hive 身份进脚本本体(根治:不再只靠 ephemeral 的 tmux `-e`)
  if (hiveEnv) injectHiveIdentity(command, hiveEnv.key, hiveEnv.name)
  let paneId: string
  if (isFirstSplit) {
    paneId = execSync(
      `${TMUX} split-window -t ${shellQuote(tmuxName)} -h -p 65 ${cwdFlag}${hiveFlags} -P -F '#{pane_id}' ${shellQuote(command)}`,
      { encoding: 'utf-8', env: tmuxSpawnEnv() }
    ).trim()
  } else {
    const panes = execSync(
      `${TMUX} list-panes -t ${shellQuote(tmuxName)} -F '#{pane_id}'`,
      { encoding: 'utf-8' }
    ).trim().split('\n')
    const lastPane = panes[panes.length - 1]
    paneId = execSync(
      `${TMUX} split-window -t ${lastPane} -v ${cwdFlag}${hiveFlags} -P -F '#{pane_id}' ${shellQuote(command)}`,
      { encoding: 'utf-8', env: tmuxSpawnEnv() }
    ).trim()
  }
  return paneId
}

export function getPaneCount(tmuxName: string): number {
  try {
    const output = execSync(
      `${TMUX} list-panes -t ${shellQuote(tmuxName)} -F '#{pane_id}'`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    return output ? output.split('\n').length : 0
  } catch {
    return 0
  }
}

export function swapMainPane(tmuxName: string, targetPaneId: string): void {
  try {
    const firstPane = execSync(
      `${TMUX} list-panes -t ${shellQuote(tmuxName)} -F '#{pane_id}'`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim().split('\n')[0]
    if (firstPane && firstPane !== targetPaneId) {
      execSync(`${TMUX} swap-pane -s ${targetPaneId} -t ${firstPane}`, { stdio: 'ignore' })
    }
  } catch { /* ignore */ }
}

export function joinSessionAsPane(sourceSession: string, targetSession: string): void {
  // Join to the last pane in target (right side), then reapply layout
  const panes = execSync(
    `${TMUX} list-panes -t ${shellQuote(targetSession)} -F '#{pane_id}'`,
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
  ).trim().split('\n')
  const lastPane = panes[panes.length - 1]
  execSync(
    `${TMUX} join-pane -s ${shellQuote(sourceSession + ':0.0')} -t ${lastPane} -v`,
    { stdio: 'ignore' }
  )
  applyMainVerticalLayout(targetSession)
}

/**
 * Apply main-vertical layout: first pane left 35%, rest stacked right.
 */
export function applyMainVerticalLayout(tmuxName: string): void {
  try {
    execSync(`${TMUX} select-layout -t ${shellQuote(tmuxName)} main-vertical`, { stdio: 'ignore' })
    const width = parseInt(execSync(
      `${TMUX} display-message -t ${shellQuote(tmuxName)} -p '#{window_width}'`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim(), 10)
    if (width > 0) {
      execSync(`${TMUX} resize-pane -t ${shellQuote(tmuxName + ':0.0')} -x ${Math.floor(width * 0.35)}`, { stdio: 'ignore' })
    }
  } catch { /* ignore */ }
}

function statusLineCountForTmux(tmuxName: string): number {
  try {
    const db = getDB()
    const row = db.prepare(groupDepthForTmuxSql('?')).get(tmuxName) as { depth: number } | undefined
    const childTmuxNames = db.prepare(childGroupTmuxNamesForTmuxSql('?')).all(tmuxName) as Array<{ tmux_name: string }>
    const hasAliveChildGroup = childTmuxNames.some(({ tmux_name: childTmuxName }) => isSessionAlive(childTmuxName))
    return statusLineCountForDepth(Number(row?.depth || 0), hasAliveChildGroup)
  } catch {
    return 1
  }
}

function applyStatusLineOptions(tmuxName: string): void {
  const rowScript = ensureStatusRowScript()
  const lineCount = statusLineCountForTmux(tmuxName)
  const statusValue = statusOptionValueForLineCount(lineCount)
  const sq = shellQuote(tmuxName)

  let paneId = ''
  let clientWidth = 200
  try {
    const geometry = execFileSync(
      TMUX,
      ['display-message', '-t', tmuxName, '-p', '#{pane_id}\t#{client_width}\t#{window_width}'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim().split('\t')
    paneId = geometry[0] || ''
    const measured = Number(geometry[1]) || Number(geometry[2])
    if (Number.isFinite(measured) && measured > 0) clientWidth = measured
  } catch { /* use safe defaults for a detached session */ }

  // Render each row synchronously into a tmux option. `#(script ...)` status
  // commands are asynchronous and tmux reuses their previous output while a
  // newly selected session is loading. When the target has an extra child-row,
  // that cache briefly shows the old root row twice with two active groups.
  // Literal, per-session rows make the session switch atomic and preserve the
  // user click ranges without waiting for a background shell result.
  const renderedRows: string[] = []
  for (let line = 0; line < lineCount; line++) {
    let row = ''
    try {
      row = execFileSync(
        rowScript,
        [String(line), tmuxName, paneId, String(clientWidth)],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      )
    } catch { /* an empty row is safer than a stale row from another session */ }
    renderedRows.push(row)
  }

  // Update formats before exposing a larger row count. This avoids one frame
  // where tmux reveals an old status-format slot from a previous layout.
  for (let line = 0; line < lineCount; line++) {
    const clock = line === lineCount - 1
      ? '#[fill=#1b1e2a,align=right]#[fg=#8f96b0] %H:%M '
      : '#[fill=#1b1e2a]'
    const format = `#[bg=#1b1e2a]${renderedRows[line]}${clock}`
    execSync(`${TMUX} set-option -t ${sq} status-format[${line}] ${shellQuote(format)}`, { stdio: 'ignore' })
  }
  execSync(`${TMUX} set-option -t ${sq} status ${statusValue}`, { stdio: 'ignore' })
}

/**
 * Apply kitty-kitty status bar to a tmux session.
 * Shows group-level destinations; individual panes stay inside tmux.
 */
export function applyKittyStatusBar(tmuxName: string): void {
  try {
    const sq = shellQuote(tmuxName)

    // Initialize KITTY_ACTIVE_GROUP if not set
    try {
      const cur = execSync(`${TMUX} show-environment -g KITTY_ACTIVE_GROUP`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (!cur || cur.startsWith('-')) {
        execSync(`${TMUX} set-environment -g KITTY_ACTIVE_GROUP __ungrouped__`, { stdio: 'ignore' })
      }
    } catch {
      execSync(`${TMUX} set-environment -g KITTY_ACTIVE_GROUP __ungrouped__`, { stdio: 'ignore' })
    }

    const opts: string[] = [
      `set-option -t ${sq} status on`,
      `set-option -t ${sq} status-position bottom`,
      `set-option -t ${sq} status-style "bg=#1b1e2a,fg=#8f96b0"`,
      `set-option -t ${sq} @kitty_active_fg "#06b6d4"`,
      `set-option -t ${sq} @kitty_active_bg "#3a3a5c"`,
      // No window list — everything is in status-format
      `set-window-option -t ${sq} window-status-format ""`,
      `set-window-option -t ${sq} window-status-current-format ""`,
      `set-option -t ${sq} status-interval 5`,
      `set-option -t ${sq} mouse on`,
      // Highlight active pane with border + top status label
      `set-option -t ${sq} pane-active-border-style "fg=#5b93f0"`,
      `set-option -t ${sq} pane-border-style "fg=#2e3446"`,
      `set-option -t ${sq} pane-border-lines single`,
      `set-option -t ${sq} pane-border-status ${PANE_BORDER_STATUS}`,
      `set-option -t ${sq} pane-border-format "${PANE_BORDER_FORMAT}"`,
    ]

    for (const cmd of opts) {
      try { execSync(`${TMUX} ${cmd}`, { stdio: 'ignore' }) } catch { /* ignore */ }
    }
    applyStatusLineOptions(tmuxName)
    syncPaneLabels(tmuxName)

    const binds = [
      'bind-key n switch-client -n',
      'bind-key p switch-client -p',
      `bind-key k choose-tree -sZ -F "#{session_name}"`,
      // Alt+Right: split horizontally (right)
      'bind-key -n M-Right split-window -h',
      // Alt+Down: split vertically (down)
      'bind-key -n M-Down split-window -v',
      // Alt+Left: close current pane
      'bind-key -n M-Left kill-pane',
    ]
    for (const cmd of binds) {
      try { execSync(`${TMUX} ${cmd}`, { stdio: 'ignore' }) } catch { /* ignore */ }
    }

    // Prefix+1~9 switches root groups; Alt+1~9 switches group-level items.
    // Key bindings are global (not per-session), only bind once via refreshAllStatusBars
    // to avoid race conditions between multiple applyKittyStatusBar calls
  } catch { /* ignore */ }
}

/**
 * Copy Kitty's per-session title into a pane-local tmux option. The pane
 * border can then show a stable custom name without relying on pane_title,
 * which Claude/Codex/OpenCode may overwrite via terminal title escapes.
 */
function syncPaneLabels(tmuxName: string): void {
  try {
    const rows = getDB().prepare(`
      SELECT title, cwd, COALESCE(pane_id, '') AS paneId
      FROM sessions
      WHERE tmux_name = ? AND COALESCE(hidden, 0) = 0
    `).all(tmuxName) as Array<{ title: string; cwd: string; paneId: string }>

    const panes = listPaneLocations(tmuxName)
    if (panes.length === 0) return

    for (const { paneId, cwd: paneCwd } of panes) {
      let row = rows.find((candidate) => candidate.paneId === paneId)
      if (!row) {
        const cwdMatches = rows.filter((candidate) => candidate.cwd === paneCwd)
        if (cwdMatches.length === 1) row = cwdMatches[0]
      }
      if (!row && rows.length === 1) row = rows[0]

      if (row) {
        const label = formatPaneLabel(row.title, row.cwd)
        execSync(`${TMUX} set-option -p -t ${shellQuote(paneId)} @kitty_label ${shellQuote(label)}`, { stdio: 'ignore' })
      } else {
        try { execSync(`${TMUX} set-option -pu -t ${shellQuote(paneId)} @kitty_label`, { stdio: 'ignore' }) } catch { /* unset */ }
      }
    }
  } catch { /* optional decoration must never block a session */ }
}

function listPaneLocations(tmuxName: string): PaneLocation[] {
  const output = execSync(
    `${TMUX} list-panes -t ${shellQuote(tmuxName)} -F '#{pane_id}\t#{pane_current_path}'`,
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim()
  if (!output) return []
  return output.split('\n').map((line) => {
    const separator = line.indexOf('\t')
    return {
      paneId: separator >= 0 ? line.slice(0, separator) : line,
      cwd: separator >= 0 ? line.slice(separator + 1) : '',
    }
  })
}

/** Immediately update one known session's pane label after a Kitty rename. */
export function refreshPaneLabelForSession(session: {
  tmuxName: string
  paneId: string
  cwd: string
  title: string
}): boolean {
  try {
    const paneId = resolveSessionPaneId(session, listPaneLocations(session.tmuxName))
    if (!paneId) return false
    const label = formatPaneLabel(session.title, session.cwd)
    execSync(`${TMUX} set-option -p -t ${shellQuote(paneId)} @kitty_label ${shellQuote(label)}`, { stdio: 'ignore' })
    try { execSync(`${TMUX} refresh-client -S`, { stdio: 'ignore' }) } catch { /* no attached client */ }
    return true
  } catch {
    return false
  }
}

/**
 * Bind prefix+1~9 to switch between groups.
 * (Ctrl+number doesn't work in most terminals including Ghostty)
 */
function bindGroupKeys(): void {
  const switchScript = ensureSwitchGroupScript()
  for (let i = 1; i <= 9; i++) {
    try {
      execSync(`${TMUX} bind-key ${i} run-shell -b '${switchScript} ${i} "#{client_name}"'`, { stdio: 'ignore' })
    } catch { /* ignore */ }
  }
}

/**
 * Pane-action helper: a tiny POSIX shell script that tmux's M-c binding calls.
 * Reads the current pane_id from tmux env via `display-message`, then POSTs
 * to kitty's wakeup unix socket (/pane-action). kitty looks the pane up in
 * its DB, sends the renderer a synthetic 'pane:action' event, and the same
 * code path that powers the right-click "clear-conversation" runs.
 *
 * Kept dependency-free (curl + tmux only) so it works in every shell.
 */
function ensurePaneActionScript(): string {
  const sockPath = join(homedir(), '.kitty-kitty', 'wakeup.sock')
  const scriptPath = join(tmpdir(), 'kitty_pane_action.sh')
  writeFileSync(scriptPath, `#!/bin/bash
# usage: kitty_pane_action.sh <action>
ACTION="\$1"
[ -z "\$ACTION" ] && exit 0
PANE_ID="\$(${TMUX} display-message -p '#{pane_id}' 2>/dev/null)"
[ -z "\$PANE_ID" ] && exit 0
curl -s --max-time 2 --unix-socket "${sockPath}" \\
  -H 'content-type: application/json' \\
  -X POST 'http://_/pane-action' \\
  --data-binary "{\\"pane_id\\":\\"\$PANE_ID\\",\\"action\\":\\"\$ACTION\\"}" \\
  >/dev/null 2>&1 || true
`)
  chmodSync(scriptPath, '755')
  return scriptPath
}

/**
 * Bind Alt+C globally in tmux to trigger the kitty "clear-conversation"
 * action against the focused pane. Mirrors the right-click context menu so
 * users with both UIs end up in the same place.
 */
function bindPaneActionKeys(): void {
  const script = ensurePaneActionScript()
  try {
    execSync(`${TMUX} bind-key -n M-c run-shell -b '${script} clear-conversation'`, { stdio: 'ignore' })
    // Alt+T: set the focused pane's session as its group's main window.
    execSync(`${TMUX} bind-key -n M-t run-shell -b '${script} set-main-session'`, { stdio: 'ignore' })
    // Alt+X: transfer the focused claude session to codex (or toggle back).
    execSync(`${TMUX} bind-key -n M-x run-shell -b '${script} transfer-codex'`, { stdio: 'ignore' })
    // Alt+R: restart the focused pane's session (same path as context menu).
    execSync(`${TMUX} bind-key -n M-r run-shell -b '${script} restart'`, { stdio: 'ignore' })
  } catch { /* ignore */ }
}

/**
 * Click-dispatcher for tmux status bar `range=user|kitty:*` regions. Tmux
 * forwards `#{mouse_status_range}` (e.g. "user|kg:abc") when the
 * MouseDown1Status binding fires. We parse it here and delegate to the right
 * follow-up script. Lives in /tmp like the rest of the helpers.
 */
function ensureStatusClickScript(): string {
  const switchScript = ensureSwitchGroupScript()
  const navigateScript = ensureStatusNavigateScript()
  const scriptPath = join(tmpdir(), 'kitty_status_click.sh')
  writeFileSync(scriptPath, `#!/bin/bash
# tmux's mouse_status_range variable returns ONLY the user-range argument
# (e.g. "kg:abc"), not the full "user|...". Match on the
# arg form, not the type-prefixed form.
RANGE="\$1"
CLIENT="\$2"
RENDER_SESSION="\$3"
[ -z "\$RANGE" ] && exit 0
case "\$RANGE" in
  kr:*)
    IDX="\${RANGE##*:}"
    exec "${switchScript}" "\$IDX" "\$CLIENT"
    ;;
  kg:*)
    ID="\${RANGE##*:}"
    exec "${navigateScript}" group "\$ID" "\$RENDER_SESSION" "\$CLIENT"
    ;;
  kd:*)
    ID="\${RANGE##*:}"
    exec "${navigateScript}" direct "\$ID" "\$RENDER_SESSION" "\$CLIENT"
    ;;
esac
`)
  chmodSync(scriptPath, '755')
  return scriptPath
}

function bindStatusClickKeys(): void {
  const script = ensureStatusClickScript()
  try {
    // Use root keytable so click fires without tmux prefix. -F template expands
    // mouse_status_range to the user range string we tagged in status-format.
    // Default MouseDown1Status (select window) is irrelevant here since our
    // window-status-format is empty.
    execSync(`${TMUX} bind-key -T root MouseDown1Status run-shell '${script} "#{mouse_status_range}" "#{client_name}" "#{session_name}"'`, { stdio: 'ignore' })
  } catch { /* ignore */ }
}

/**
 * Bind Alt+1~9 to the visible items in the current group's row.
 */
function bindAltGroupKeys(): void {
  const navigateScript = ensureStatusNavigateScript()
  for (let i = 1; i <= 9; i++) {
    try {
      execSync(`${TMUX} bind-key -n M-${i} run-shell -b '${navigateScript} level-index ${i} "#{session_name}" "#{client_name}"'`, { stdio: 'ignore' })
    } catch { /* ignore */ }
  }
}

/**
 * Refresh the status bar of all kitty sessions (called after session changes)
 */
export function refreshAllStatusBars(): void {
  const sessions = listTmuxSessions()
  for (const s of sessions) {
    try {
      // Refresh the complete contract, not only status-format. Imported or
      // long-lived standalone sessions may still carry an older window list,
      // mouse setting, or row count until the app explicitly normalizes them.
      applyKittyStatusBar(s.name)
    } catch { /* ignore */ }
  }
  try {
    execSync(`${TMUX} refresh-client -S`, { stdio: 'ignore' })
  } catch { /* ignore */ }
  bindGroupKeys()
  bindAltGroupKeys()
  bindPaneActionKeys()
  bindStatusClickKeys()
}

function statusScriptOptions(): Parameters<typeof buildStatusRowScript>[0] {
  return {
    tmuxBin: TMUX,
    dbPath: join(homedir(), 'Library', 'Application Support', 'kitty-kitty', 'kitty-kitty.db'),
    sessionPrefix: SESSION_PREFIX,
  }
}

function ensureStatusRowScript(): string {
  const scriptPath = join(tmpdir(), 'kitty_status_row.sh')
  writeFileSync(scriptPath, buildStatusRowScript(statusScriptOptions()))
  chmodSync(scriptPath, '755')
  return scriptPath
}

function ensureStatusNavigateScript(): string {
  const scriptPath = join(tmpdir(), 'kitty_status_navigate.sh')
  writeFileSync(scriptPath, buildStatusNavigateScript(statusScriptOptions()))
  chmodSync(scriptPath, '755')
  return scriptPath
}

/**
 * Legacy single-level root switcher used by prefix+1~9 and root-row clicks.
 */
function ensureSwitchGroupScript(): string {
  const dbPath = join(homedir(), 'Library', 'Application Support', 'kitty-kitty', 'kitty-kitty.db')
  const scriptPath = join(tmpdir(), 'kitty_switch_group.sh')
  writeFileSync(scriptPath, `#!/bin/bash
IDX="\$1"
CLIENT="\$2"
[ -z "\$IDX" ] && exit 0

TMUX_BIN="${TMUX}"
DB="${dbPath}"

if ! [ -f "\$DB" ] || ! command -v sqlite3 >/dev/null 2>&1; then
  exit 0
fi

# Collect alive tmux sessions
ALIVE=""
while read -r S; do
  ALIVE="\$ALIVE|\$S|"
done < <(\$TMUX_BIN list-sessions -F '#{session_name}' 2>/dev/null | grep '^${SESSION_PREFIX}')

# Build ordered group list (same order as group bar)
declare -a GROUP_IDS
declare -a GROUP_NAMES
N=0

while IFS='|' read -r GID GNAME; do
  [ -z "\$GID" ] && continue
  SUBTREE_SQL="${groupSubtreeCte("'\$GID'")}"
  COUNT=0
  while read -r TNAME; do
    [ -z "\$TNAME" ] && continue
    case "\$ALIVE" in *"|\$TNAME|"*) COUNT=\$((COUNT+1)) ;; esac
  done < <(sqlite3 "\$DB" "\$SUBTREE_SQL SELECT DISTINCT tmux_name FROM sessions WHERE group_id IN (SELECT id FROM subtree) AND COALESCE(hidden,0)=0;" 2>/dev/null)
  [ "\$COUNT" -eq 0 ] && continue
  N=\$((N+1))
  GROUP_IDS[\$N]="\$GID"
  GROUP_NAMES[\$N]="\$GNAME"
done < <(sqlite3 "\$DB" "${ROOT_GROUPS_SQL}" 2>/dev/null)

# Top-level standalone sessions stay individually addressable.
while IFS='|' read -r TNAME TITLE; do
  [ -z "\$TNAME" ] && continue
  case "\$ALIVE" in *"|\$TNAME|"*) ;; *) continue ;; esac
  N=\$((N+1))
  GROUP_IDS[\$N]="__ungrouped__:\$TNAME"
  GROUP_NAMES[\$N]="\${TITLE:-\$TNAME}"
done < <(sqlite3 "\$DB" "SELECT tmux_name, title FROM sessions WHERE (group_id IS NULL OR group_id='') AND COALESCE(hidden,0)=0 ORDER BY updated_at DESC;" 2>/dev/null)

# Validate index
if [ "\$IDX" -gt "\$N" ] || [ "\$IDX" -lt 1 ]; then
  exit 0
fi

TARGET_GID="\${GROUP_IDS[\$IDX]}"
[ -z "\$TARGET_GID" ] && exit 0

BEST=""
ENV_GID="\$TARGET_GID"
case "\$TARGET_GID" in
  __ungrouped__:*)
    ENV_GID="__ungrouped__"
    BEST="\${TARGET_GID#__ungrouped__:}"
    ;;
  *)
    QUERY_BEST="SELECT tmux_name FROM sessions WHERE group_id='\$TARGET_GID' AND COALESCE(hidden,0)=0 ORDER BY updated_at DESC;"
    while read -r CANDIDATE; do
      [ -z "\$CANDIDATE" ] && continue
      case "\$ALIVE" in *"|\$CANDIDATE|"*) BEST="\$CANDIDATE"; break ;; esac
    done < <(sqlite3 "\$DB" "\$QUERY_BEST" 2>/dev/null)
    if [ -z "\$BEST" ]; then
      QUERY_BEST="${groupSubtreeCte("'\$TARGET_GID'")} SELECT tmux_name FROM sessions WHERE group_id IN (SELECT id FROM subtree) AND COALESCE(hidden,0)=0 ORDER BY updated_at DESC;"
      while read -r CANDIDATE; do
        [ -z "\$CANDIDATE" ] && continue
        case "\$ALIVE" in *"|\$CANDIDATE|"*) BEST="\$CANDIDATE"; break ;; esac
      done < <(sqlite3 "\$DB" "\$QUERY_BEST" 2>/dev/null)
    fi
    ;;
esac

if [ -n "\$BEST" ]; then
  if [ -n "\$CLIENT" ]; then
    \$TMUX_BIN list-clients -F '#{client_name}' 2>/dev/null | grep -Fxq "\$CLIENT" || CLIENT=""
  fi
  [ -z "\$CLIENT" ] && CLIENT=\$(\$TMUX_BIN list-clients -F '#{client_name}' 2>/dev/null | head -1)
  if [ -n "\$CLIENT" ]; then
    \$TMUX_BIN set-option -t "\$BEST" @kitty_active_fg '#cffafe' 2>/dev/null || true
    \$TMUX_BIN set-option -t "\$BEST" @kitty_active_bg '#155e75' 2>/dev/null || true
    if \$TMUX_BIN switch-client -c "\$CLIENT" -t "\$BEST" 2>/dev/null; then
      # Only update env after successful switch
      \$TMUX_BIN set-environment -g KITTY_ACTIVE_GROUP "\$ENV_GID" 2>/dev/null
      \$TMUX_BIN refresh-client -S 2>/dev/null || true
      sleep 0.045
      \$TMUX_BIN set-option -t "\$BEST" @kitty_active_fg '#67e8f9' 2>/dev/null || true
      \$TMUX_BIN set-option -t "\$BEST" @kitty_active_bg '#334155' 2>/dev/null || true
      \$TMUX_BIN refresh-client -S 2>/dev/null || true
      sleep 0.045
    fi
    # Also restores the normal palette when switch-client failed.
    \$TMUX_BIN set-option -t "\$BEST" @kitty_active_fg '#06b6d4' 2>/dev/null || true
    \$TMUX_BIN set-option -t "\$BEST" @kitty_active_bg '#3a3a5c' 2>/dev/null || true
  fi
fi

\$TMUX_BIN refresh-client -S 2>/dev/null
`)
  chmodSync(scriptPath, '755')
  return scriptPath
}
