import { execSync, exec } from 'child_process'
import { existsSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { v4 as uuid } from 'uuid'
import { getDB } from '../db/database'
import { getPaneMode } from './cli-wrapper'

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

/**
 * Supported CLI tools and their commands
 */
const TOOL_COMMANDS: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  aichat: 'aichat',
  shell: '$SHELL'
}

export function getToolCommand(tool: string): string {
  // Only used as fallback when no launch script is provided.
  // Launch scripts from cli-wrapper.ts handle user config (toolArgs).
  return TOOL_COMMANDS[tool] || tool
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
export function createTmuxSession(tool: string, firstMessage?: string, cwd?: string, launchScript?: string): TmuxSession {
  const id = uuid().slice(0, 8)
  const tmuxName = `${SESSION_PREFIX}${id}`

  // Default cwd: ~/.kitty-kitty/sessions/<id>/, auto-created
  if (!cwd) {
    const { mkdirSync } = require('fs')
    const { homedir } = require('os')
    cwd = join(homedir(), '.kitty-kitty', 'sessions', id)
    mkdirSync(cwd, { recursive: true })
  }

  const dirName = require('path').basename(cwd)
  const title = firstMessage?.slice(0, 40) || dirName

  // Use launch script if provided, otherwise raw tool command
  const command = launchScript || getToolCommand(tool)
  execSync(`${TMUX} new-session -d -s ${shellQuote(tmuxName)} -c ${shellQuote(cwd)} ${shellQuote(command)}`, {
    stdio: 'ignore',
    env: { ...process.env, TERM: 'xterm-256color' }
  })

  // If there's a first message, wait a moment then send it
  if (firstMessage) {
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
      env: { ...process.env, TERM: 'xterm-256color' }
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
 * Import an existing tmux session into kitty management
 */
export function importTmuxSession(tmuxName: string): TmuxSession {
  const id = uuid().slice(0, 8)
  // Try to get the cwd from the tmux session
  let cwd = ''
  try {
    cwd = execSync(`${TMUX} display-message -t ${shellQuote(tmuxName)} -p "#{pane_current_path}"`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { /* ignore */ }
  return {
    id,
    tmuxName,
    title: tmuxName,
    tool: 'shell',
    cwd,
    status: 'detached',
    createdAt: new Date().toISOString()
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
    const row = db.prepare("SELECT COALESCE(group_id, '') as group_id FROM sessions WHERE tmux_name = ?").get(tmuxName) as { group_id: string } | undefined
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
export function createPaneInSession(tmuxName: string, command: string, isFirstSplit: boolean, cwd?: string): string {
  const cwdFlag = cwd ? `-c ${shellQuote(cwd)}` : ''
  let paneId: string
  if (isFirstSplit) {
    paneId = execSync(
      `${TMUX} split-window -t ${shellQuote(tmuxName)} -h -p 65 ${cwdFlag} -P -F '#{pane_id}' ${shellQuote(command)}`,
      { encoding: 'utf-8', env: { ...process.env, TERM: 'xterm-256color' } }
    ).trim()
  } else {
    const panes = execSync(
      `${TMUX} list-panes -t ${shellQuote(tmuxName)} -F '#{pane_id}'`,
      { encoding: 'utf-8' }
    ).trim().split('\n')
    const lastPane = panes[panes.length - 1]
    paneId = execSync(
      `${TMUX} split-window -t ${lastPane} -v ${cwdFlag} -P -F '#{pane_id}' ${shellQuote(command)}`,
      { encoding: 'utf-8', env: { ...process.env, TERM: 'xterm-256color' } }
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

/**
 * Apply kitty-kitty status bar to a tmux session.
 * Shows all kitty sessions as clickable tabs with switch keybindings.
 */
export function applyKittyStatusBar(tmuxName: string): void {
  try {
    const isPaneMode = getPaneMode()
    const groupBarScript = ensureGroupBarScript()
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
      `set-option -t ${sq} status-style "bg=#2a2a45,fg=#aaa8c3"`,
      // No window list — everything is in status-format
      `set-window-option -t ${sq} window-status-format ""`,
      `set-window-option -t ${sq} window-status-current-format ""`,
      `set-option -t ${sq} status-interval 5`,
      `set-option -t ${sq} mouse on`,
    ]

    if (isPaneMode) {
      opts.push(
        `set-option -t ${sq} status 1`,
        `set-option -t ${sq} status-format[0] "#[bg=#1e1e36]#(${groupBarScript} #{session_name})#[fill=#1e1e36,align=right]#[fg=#aaa8c3] %H:%M "`,
        // Highlight active pane with border + top status label
        `set-option -t ${sq} pane-active-border-style "fg=#645efb"`,
        `set-option -t ${sq} pane-border-style "fg=#2a2a45"`,
        `set-option -t ${sq} pane-border-lines single`,
        `set-option -t ${sq} pane-border-status top`,
        `set-option -t ${sq} pane-border-format "#[fg=#{?pane_active,#645efb,#46465c},bg=#1e1e36] #{pane_index} #{b:pane_current_path} "`,
      )
    } else {
      const sessionBarScript = ensureSessionBarScript()
      opts.push(
        `set-option -t ${sq} status 2`,
        `set-option -t ${sq} status-format[0] "#[bg=#1e1e36]#(${groupBarScript} #{session_name})#[fill=#1e1e36]"`,
        `set-option -t ${sq} status-format[1] "#[bg=#2a2a45]#(${sessionBarScript} #{session_name})#[fill=#2a2a45,align=right]#[fg=#aaa8c3] %H:%M "`,
      )
    }

    for (const cmd of opts) {
      try { execSync(`${TMUX} ${cmd}`, { stdio: 'ignore' }) } catch { /* ignore */ }
    }

    // Alt+F: fork session into worktree
    const forkScript = ensureForkScript()
    const closeScript = ensureCloseScript()
    const binds = [
      'bind-key n switch-client -n',
      'bind-key p switch-client -p',
      `bind-key k choose-tree -sZ -F "#{session_name}"`,
      // Alt+Right: split horizontally (right)
      'bind-key -n M-Right split-window -h',
      // Alt+Down: split vertically (down)
      'bind-key -n M-Down split-window -v',
      // Alt+Left: close current pane (with worktree cleanup if applicable).
      `bind-key -n M-Left run-shell -b "${closeScript} '#{pane_id}'"`,
      // Alt+F: fork session — prompt for branch name, create worktree + split pane.
      `bind-key -n M-f command-prompt -p "Fork branch:" "run-shell -b '${forkScript} \\\"%%\\\"'"`,
    ]
    for (const cmd of binds) {
      try { execSync(`${TMUX} ${cmd}`, { stdio: 'ignore' }) } catch { /* ignore */ }
    }

    // Ctrl+1~9 to switch groups, Alt+1~9 to switch sessions within group
    // Key bindings are global (not per-session), only bind once via refreshAllStatusBars
    // to avoid race conditions between multiple applyKittyStatusBar calls
  } catch { /* ignore */ }
}

/**
 * Bind Alt+1~9 to switch to the Nth visible session in the active group
 */
function bindSessionKeys(): void {
  let activeGroup = '__ungrouped__'
  try {
    const raw = execSync(`${TMUX} show-environment -g KITTY_ACTIVE_GROUP`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    // format: KITTY_ACTIVE_GROUP=value
    const eq = raw.indexOf('=')
    if (eq >= 0) activeGroup = raw.slice(eq + 1)
  } catch { /* default */ }

  let sessions: string[] = []
  try {
    const db = getDB()
    let rows: Array<{ tmux_name: string }>
    if (activeGroup === '__ungrouped__') {
      rows = db.prepare("SELECT tmux_name FROM sessions WHERE COALESCE(hidden,0)=0 AND (group_id IS NULL OR group_id='') ORDER BY updated_at DESC").all() as Array<{ tmux_name: string }>
    } else {
      rows = db.prepare("SELECT tmux_name FROM sessions WHERE COALESCE(hidden,0)=0 AND group_id=? ORDER BY updated_at DESC").all(activeGroup) as Array<{ tmux_name: string }>
    }
    // Filter to only alive tmux sessions
    const alive = new Set(listTmuxSessions().map(s => s.name))
    sessions = rows.map(r => r.tmux_name).filter(n => alive.has(n))
  } catch { /* DB may not be ready */ }

  for (let i = 0; i < 9; i++) {
    const target = sessions[i]
    if (target) {
      try {
        execSync(`${TMUX} bind-key -n M-${i + 1} switch-client -t ${shellQuote(target)}`, { stdio: 'ignore' })
      } catch { /* ignore */ }
    } else {
      try {
        execSync(`${TMUX} unbind-key -n M-${i + 1}`, { stdio: 'ignore' })
      } catch { /* ignore */ }
    }
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
      execSync(`${TMUX} bind-key ${i} run-shell -b '${switchScript} ${i}'`, { stdio: 'ignore' })
    } catch { /* ignore */ }
  }
}

/**
 * Bind Alt+1~9 to switch between groups (used in pane mode).
 * In pane mode, panes handle session navigation, so Alt+number switches groups instead.
 */
function bindAltGroupKeys(): void {
  const switchScript = ensureSwitchGroupScript()
  for (let i = 1; i <= 9; i++) {
    try {
      execSync(`${TMUX} bind-key -n M-${i} run-shell -b '${switchScript} ${i}'`, { stdio: 'ignore' })
    } catch { /* ignore */ }
  }
}

/**
 * Refresh the status bar of all kitty sessions (called after session changes)
 */
export function refreshAllStatusBars(): void {
  const isPaneMode = getPaneMode()
  const groupBarScript = ensureGroupBarScript()
  const sessions = listTmuxSessions()
  for (const s of sessions) {
    try {
      if (isPaneMode) {
        execSync(`${TMUX} set-option -t ${shellQuote(s.name)} status 1`, { stdio: 'ignore' })
        execSync(`${TMUX} set-option -t ${shellQuote(s.name)} status-format[0] "#[bg=#1e1e36]#(${groupBarScript} #{session_name})#[fill=#1e1e36,align=right]#[fg=#aaa8c3] %H:%M "`, { stdio: 'ignore' })
      } else {
        const sessionBarScript = ensureSessionBarScript()
        execSync(`${TMUX} set-option -t ${shellQuote(s.name)} status 2`, { stdio: 'ignore' })
        execSync(`${TMUX} set-option -t ${shellQuote(s.name)} status-format[0] "#[bg=#1e1e36]#(${groupBarScript} #{session_name})#[fill=#1e1e36]"`, { stdio: 'ignore' })
        execSync(`${TMUX} set-option -t ${shellQuote(s.name)} status-format[1] "#[bg=#2a2a45]#(${sessionBarScript} #{session_name})#[fill=#2a2a45,align=right]#[fg=#aaa8c3] %H:%M "`, { stdio: 'ignore' })
      }
    } catch { /* ignore */ }
  }
  try {
    execSync(`${TMUX} refresh-client -S`, { stdio: 'ignore' })
  } catch { /* ignore */ }
  bindGroupKeys()
  if (isPaneMode) {
    bindAltGroupKeys()
  } else {
    bindSessionKeys()
  }
}

/**
 * Upper status bar: group tabs — shows all groups with active session counts
 */
function ensureGroupBarScript(): string {
  const dbPath = join(homedir(), 'Library', 'Application Support', 'kitty-kitty', 'kitty-kitty.db')
  const scriptPath = join(tmpdir(), 'kitty_group_bar.sh')
  writeFileSync(scriptPath, `#!/bin/bash
# Argument \$1: the tmux session name being rendered (passed via #{session_name})
TMUX_BIN="${TMUX}"
DB="${dbPath}"
GBG="#1e1e36"
RENDER_SESSION="\$1"

if ! [ -f "\$DB" ] || ! command -v sqlite3 >/dev/null 2>&1; then
  printf '#[fg=#aaa8c3,bg=%s]  (no db)  ' "\$GBG"
  exit 0
fi

# Derive active group from the session being rendered — this is the truth for this status bar
if [ -n "\$RENDER_SESSION" ]; then
  ACTIVE_GROUP=\$(sqlite3 "\$DB" "SELECT COALESCE(group_id, '__ungrouped__') FROM sessions WHERE tmux_name='\$RENDER_SESSION' LIMIT 1;" 2>/dev/null)
fi
[ -z "\$ACTIVE_GROUP" ] && ACTIVE_GROUP="__ungrouped__"

# Collect alive tmux sessions
ALIVE=""
while read -r S; do
  ALIVE="\$ALIVE|\$S|"
done < <(\$TMUX_BIN list-sessions -F '#{session_name}' 2>/dev/null | grep '^${SESSION_PREFIX}')

N=0

# Named groups with active sessions
while IFS='|' read -r GID GNAME; do
  [ -z "\$GID" ] && continue
  # Count visible sessions in this group
  # In pane mode, multiple DB sessions share one tmux session, so count from DB directly
  COUNT=\$(sqlite3 "\$DB" "SELECT COUNT(*) FROM sessions WHERE group_id='\$GID' AND COALESCE(hidden,0)=0;" 2>/dev/null)
  # But still need at least one alive tmux session in the group
  HAS_ALIVE=0
  while read -r TNAME; do
    [ -z "\$TNAME" ] && continue
    case "\$ALIVE" in *"|\$TNAME|"*) HAS_ALIVE=1; break ;; esac
  done < <(sqlite3 "\$DB" "SELECT DISTINCT tmux_name FROM sessions WHERE group_id='\$GID' AND COALESCE(hidden,0)=0;" 2>/dev/null)
  [ "\$HAS_ALIVE" -eq 0 ] && continue
  [ "\${COUNT:-0}" -eq 0 ] && continue
  N=\$((N+1))
  if [ "\$GID" = "\$ACTIVE_GROUP" ]; then
    printf '#[fg=#06b6d4,bg=#3a3a5c,bold]  %d  %s (%d)  #[bg=%s]' "\$N" "\$GNAME" "\$COUNT" "\$GBG"
  else
    [ "\$N" -gt 1 ] && printf '#[fg=#3a3a5c,bg=%s] ' "\$GBG"
    printf '#[fg=#706f8a,bg=%s]  %d  %s (%d)  ' "\$GBG" "\$N" "\$GNAME" "\$COUNT"
  fi
done < <(sqlite3 "\$DB" "SELECT id, name FROM groups ORDER BY created_at;" 2>/dev/null)

# Ungrouped count
UCOUNT=0
while read -r TNAME; do
  [ -z "\$TNAME" ] && continue
  case "\$ALIVE" in *"|\$TNAME|"*) UCOUNT=\$((UCOUNT+1)) ;; esac
done < <(sqlite3 "\$DB" "SELECT tmux_name FROM sessions WHERE (group_id IS NULL OR group_id='') AND COALESCE(hidden,0)=0;" 2>/dev/null)

if [ "\$UCOUNT" -gt 0 ]; then
  N=\$((N+1))
  if [ "\$ACTIVE_GROUP" = "__ungrouped__" ]; then
    [ "\$N" -gt 1 ] && printf '#[fg=#3a3a5c,bg=%s] ' "\$GBG"
    printf '#[fg=#06b6d4,bg=#3a3a5c,bold]  %d  未分组 (%d)  #[bg=%s]' "\$N" "\$UCOUNT" "\$GBG"
  else
    [ "\$N" -gt 1 ] && printf '#[fg=#3a3a5c,bg=%s] ' "\$GBG"
    printf '#[fg=#706f8a,bg=%s]  %d  未分组 (%d)  ' "\$GBG" "\$N" "\$UCOUNT"
  fi
fi
`)
  chmodSync(scriptPath, '755')
  return scriptPath
}

/**
 * Lower status bar: session tabs filtered by current group
 */
function ensureSessionBarScript(): string {
  const dbPath = join(homedir(), 'Library', 'Application Support', 'kitty-kitty', 'kitty-kitty.db')
  const scriptPath = join(tmpdir(), 'kitty_session_bar.sh')
  writeFileSync(scriptPath, `#!/bin/bash
# Argument \$1: the tmux session name being rendered (passed via #{session_name})
TMUX_BIN="${TMUX}"
DB="${dbPath}"
RENDER_SESSION="\$1"
CURRENT="\${RENDER_SESSION:-\$(\$TMUX_BIN display-message -p '#S')}"

# Derive active group from the session being rendered
if [ -n "\$RENDER_SESSION" ] && [ -f "\$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
  ACTIVE_GROUP=\$(sqlite3 "\$DB" "SELECT COALESCE(group_id, '__ungrouped__') FROM sessions WHERE tmux_name='\$RENDER_SESSION' LIMIT 1;" 2>/dev/null)
fi
[ -z "\$ACTIVE_GROUP" ] && ACTIVE_GROUP="__ungrouped__"

# Collect alive tmux sessions for cross-check
ALIVE=""
while read -r S; do
  ALIVE="\$ALIVE|\$S|"
done < <(\$TMUX_BIN list-sessions -F '#{session_name}' 2>/dev/null | grep '^${SESSION_PREFIX}')

if ! [ -f "\$DB" ] || ! command -v sqlite3 >/dev/null 2>&1; then
  exit 0
fi

# Query sessions from DB, filtered by group, ordered by updated_at DESC
# This order matches bindSessionKeys() so Alt+N is consistent
if [ "\$ACTIVE_GROUP" = "__ungrouped__" ]; then
  QUERY="SELECT tmux_name, title, cwd FROM sessions WHERE COALESCE(hidden,0)=0 AND (group_id IS NULL OR group_id='') ORDER BY updated_at DESC;"
else
  QUERY="SELECT tmux_name, title, cwd FROM sessions WHERE COALESCE(hidden,0)=0 AND group_id='\$ACTIVE_GROUP' ORDER BY updated_at DESC;"
fi

N=0
while IFS='|' read -r S TITLE CWD; do
  [ -z "\$S" ] && continue
  # Only show alive sessions
  case "\$ALIVE" in *"|\$S|"*) ;; *) continue ;; esac

  N=\$((N+1))
  # Status dot: check if pane has a running foreground process
  PANE_CMD=\$(\$TMUX_BIN list-panes -t "\$S" -F '#{pane_current_command}' 2>/dev/null | head -1)
  case "\$PANE_CMD" in
    bash|zsh|sh|fish|"") DOTCOLOR="#06d6a0" ;;   # cyan-green = idle
    *)                   DOTCOLOR="#ffb148" ;;     # amber = busy
  esac
  # Git branch with color
  BRANCH=""
  if [ -n "\$CWD" ] && [ -d "\$CWD" ]; then
    B=\$(git -C "\$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null)
    if [ -n "\$B" ]; then
      case "\$B" in
        release*) BCOLOR="#e11d48" ;;
        main|master) BCOLOR="#d97706" ;;
        feature*) BCOLOR="#10b981" ;;
        *) BCOLOR="#8b5cf6" ;;
      esac
      BRANCH="\$BCOLOR|\$B"
    fi
  fi
  BG="#2a2a45"
  if [ "\$S" = "\$CURRENT" ]; then
    FG="#06b6d4"
  else
    FG="#aaa8c3"
  fi
  if [ -n "\$BRANCH" ]; then
    BCOLOR=\$(echo "\$BRANCH" | cut -d'|' -f1)
    BNAME=\$(echo "\$BRANCH" | cut -d'|' -f2)
    printf '#[fg=%s,bg=%s,bold] %d:%s #[fg=%s,bg=%s,nobold]%s #[fg=%s,bg=%s]● #[fg=#46465c,bg=%s,nobold] | ' \\
      "\$FG" "\$BG" "\$N" "\$TITLE" "\$BCOLOR" "\$BG" "\$BNAME" "\$DOTCOLOR" "\$BG" "\$BG"
  else
    printf '#[fg=%s,bg=%s,bold] %d:%s #[fg=%s,bg=%s]● #[fg=#46465c,bg=%s,nobold] | ' \\
      "\$FG" "\$BG" "\$N" "\$TITLE" "\$DOTCOLOR" "\$BG" "\$BG"
  fi
done < <(sqlite3 "\$DB" "\$QUERY" 2>/dev/null)
`)
  chmodSync(scriptPath, '755')
  return scriptPath
}

/**
 * Script called by Ctrl+N to switch to a group by index
 */
function ensureSwitchGroupScript(): string {
  const dbPath = join(homedir(), 'Library', 'Application Support', 'kitty-kitty', 'kitty-kitty.db')
  const scriptPath = join(tmpdir(), 'kitty_switch_group.sh')
  writeFileSync(scriptPath, `#!/bin/bash
IDX="\$1"
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
  COUNT=0
  while read -r TNAME; do
    [ -z "\$TNAME" ] && continue
    case "\$ALIVE" in *"|\$TNAME|"*) COUNT=\$((COUNT+1)) ;; esac
  done < <(sqlite3 "\$DB" "SELECT tmux_name FROM sessions WHERE group_id='\$GID' AND COALESCE(hidden,0)=0;" 2>/dev/null)
  [ "\$COUNT" -eq 0 ] && continue
  N=\$((N+1))
  GROUP_IDS[\$N]="\$GID"
  GROUP_NAMES[\$N]="\$GNAME"
done < <(sqlite3 "\$DB" "SELECT id, name FROM groups ORDER BY created_at;" 2>/dev/null)

# Check ungrouped
UCOUNT=0
while read -r TNAME; do
  [ -z "\$TNAME" ] && continue
  case "\$ALIVE" in *"|\$TNAME|"*) UCOUNT=\$((UCOUNT+1)) ;; esac
done < <(sqlite3 "\$DB" "SELECT tmux_name FROM sessions WHERE (group_id IS NULL OR group_id='') AND COALESCE(hidden,0)=0;" 2>/dev/null)

if [ "\$UCOUNT" -gt 0 ]; then
  N=\$((N+1))
  GROUP_IDS[\$N]="__ungrouped__"
  GROUP_NAMES[\$N]="未分组"
fi

# Validate index
if [ "\$IDX" -gt "\$N" ] || [ "\$IDX" -lt 1 ]; then
  exit 0
fi

TARGET_GID="\${GROUP_IDS[\$IDX]}"
[ -z "\$TARGET_GID" ] && exit 0

# Find most recently updated ALIVE session in that group and switch to it
if [ "\$TARGET_GID" = "__ungrouped__" ]; then
  QUERY_BEST="SELECT tmux_name FROM sessions WHERE (group_id IS NULL OR group_id='') AND COALESCE(hidden,0)=0 ORDER BY updated_at DESC;"
else
  QUERY_BEST="SELECT tmux_name FROM sessions WHERE group_id='\$TARGET_GID' AND COALESCE(hidden,0)=0 ORDER BY updated_at DESC;"
fi
BEST=""
while read -r CANDIDATE; do
  [ -z "\$CANDIDATE" ] && continue
  case "\$ALIVE" in *"|\$CANDIDATE|"*) BEST="\$CANDIDATE"; break ;; esac
done < <(sqlite3 "\$DB" "\$QUERY_BEST" 2>/dev/null)

if [ -n "\$BEST" ]; then
  CLIENT=\$(\$TMUX_BIN list-clients -F '#{client_name}' 2>/dev/null | head -1)
  if [ -n "\$CLIENT" ]; then
    if \$TMUX_BIN switch-client -c "\$CLIENT" -t "\$BEST" 2>/dev/null; then
      # Only update env after successful switch
      \$TMUX_BIN set-environment -g KITTY_ACTIVE_GROUP "\$TARGET_GID" 2>/dev/null
    fi
  fi
fi

# In session mode, rebind Alt+1~9 to sessions in the new group.
# In pane mode, Alt+numbers stay bound to group switching — skip rebind.
PANE_MODE=0
if [ -f "${join(homedir(), '.kitty-kitty', 'config.json')}" ]; then
  PM=\$(grep -o '"paneMode"[[:space:]]*:[[:space:]]*true' "${join(homedir(), '.kitty-kitty', 'config.json')}" 2>/dev/null)
  [ -n "\$PM" ] && PANE_MODE=1
fi

if [ "\$PANE_MODE" -eq 0 ]; then
  SIDX=0
  if [ "\$TARGET_GID" = "__ungrouped__" ]; then
    QUERY="SELECT tmux_name FROM sessions WHERE (group_id IS NULL OR group_id='') AND COALESCE(hidden,0)=0 ORDER BY updated_at DESC;"
  else
    QUERY="SELECT tmux_name FROM sessions WHERE group_id='\$TARGET_GID' AND COALESCE(hidden,0)=0 ORDER BY updated_at DESC;"
  fi
  while read -r SNAME; do
    [ -z "\$SNAME" ] && continue
    case "\$ALIVE" in *"|\$SNAME|"*) ;; *) continue ;; esac
    SIDX=\$((SIDX+1))
    [ "\$SIDX" -gt 9 ] && break
    \$TMUX_BIN bind-key -n M-\$SIDX switch-client -t "\$SNAME" 2>/dev/null
  done < <(sqlite3 "\$DB" "\$QUERY" 2>/dev/null)

  # Unbind remaining Alt keys
  for I in \$(seq \$((SIDX+1)) 9); do
    \$TMUX_BIN unbind-key -n M-\$I 2>/dev/null
  done
fi

\$TMUX_BIN refresh-client -S 2>/dev/null
`)
  chmodSync(scriptPath, '755')
  return scriptPath
}

function ensureForkScript(): string {
  const scriptPath = join(tmpdir(), 'kitty_fork.sh')
  writeFileSync(scriptPath, `#!/bin/bash
# Kitty Fork Session — create a git worktree, hardlink the parent session file
# with correct Claude project-key encoding, then launch claude -c --fork-session.

LOG=/tmp/kitty_fork.log
log() { echo "[\$(date '+%F %T')] \$*" >> "\$LOG" 2>/dev/null || true; }

BRANCH="\$1"
if [ -z "\$BRANCH" ]; then
  exit 0
fi

log "=== fork start: branch=\$BRANCH ==="

TMUX_BIN="${TMUX}"
SESSION=$($TMUX_BIN display-message -p '#S')
PANE_CWD=$($TMUX_BIN display-message -p '#{pane_current_path}')

# Find project root (git toplevel)
PROJECT_ROOT=$(git -C "$PANE_CWD" rev-parse --show-toplevel 2>>"\$LOG" || echo "")
if [ -z "\$PROJECT_ROOT" ]; then
  log "FAIL: not a git repo (cwd=\$PANE_CWD)"
  $TMUX_BIN display-message "Fork failed: not a git repo"
  exit 1
fi

BRANCH_SAFE=$(echo "\$BRANCH" | sed 's/[^a-zA-Z0-9/_.-]/-/g')
BRANCH_DIR=$(echo "\$BRANCH_SAFE" | sed 's|/|-|g')
WT_DIR="\$PROJECT_ROOT/.worktrees/\$BRANCH_DIR"
log "project=\$PROJECT_ROOT branch_safe=\$BRANCH_SAFE wt=\$WT_DIR"

# Create worktree if it doesn't exist
if [ ! -d "\$WT_DIR" ]; then
  mkdir -p "\$PROJECT_ROOT/.worktrees"
  BASE=""
  if git -C "\$PROJECT_ROOT" rev-parse --verify main >/dev/null 2>&1; then
    BASE="main"
  elif git -C "\$PROJECT_ROOT" rev-parse --verify master >/dev/null 2>&1; then
    BASE="master"
  fi
  if git -C "\$PROJECT_ROOT" rev-parse --verify "\$BRANCH_SAFE" >/dev/null 2>&1; then
    log "reusing existing branch \$BRANCH_SAFE"
    git -C "\$PROJECT_ROOT" worktree add "\$WT_DIR" "\$BRANCH_SAFE" >>"\$LOG" 2>&1
  elif [ -n "\$BASE" ]; then
    log "creating new branch \$BRANCH_SAFE from \$BASE"
    git -C "\$PROJECT_ROOT" worktree add -b "\$BRANCH_SAFE" "\$WT_DIR" "\$BASE" >>"\$LOG" 2>&1
  else
    log "creating new branch \$BRANCH_SAFE from HEAD"
    git -C "\$PROJECT_ROOT" worktree add -b "\$BRANCH_SAFE" "\$WT_DIR" >>"\$LOG" 2>&1
  fi
fi

# Ensure .worktrees in .gitignore
if [ -f "\$PROJECT_ROOT/.gitignore" ]; then
  grep -qxF '.worktrees/' "\$PROJECT_ROOT/.gitignore" 2>/dev/null || echo '.worktrees/' >> "\$PROJECT_ROOT/.gitignore"
else
  echo '.worktrees/' > "\$PROJECT_ROOT/.gitignore"
fi

# Copy .mcp.json to worktree
if [ -f "\$PROJECT_ROOT/.mcp.json" ]; then
  cp "\$PROJECT_ROOT/.mcp.json" "\$WT_DIR/.mcp.json" 2>/dev/null || true
fi

# Hardlink parent session to worktree project dir.
# Claude encoding: /[^a-zA-Z0-9]/g → '-'  (all non-alphanum become dash)
MAIN_PROJ_KEY=\$(echo "\$PROJECT_ROOT" | sed 's/[^a-zA-Z0-9]/-/g')
WT_PROJ_KEY=\$(echo "\$WT_DIR" | sed 's/[^a-zA-Z0-9]/-/g')
CLAUDE_PROJECTS="\$HOME/.claude/projects"
MAIN_PROJ_DIR="\$CLAUDE_PROJECTS/\$MAIN_PROJ_KEY"
WT_PROJ_DIR="\$CLAUDE_PROJECTS/\$WT_PROJ_KEY"

LATEST_SESSION=""
if [ -d "\$MAIN_PROJ_DIR" ]; then
  LATEST_SESSION=\$(ls -t "\$MAIN_PROJ_DIR"/*.jsonl 2>/dev/null | head -1 | xargs basename 2>/dev/null | sed 's/\\.jsonl\$//')
fi

if [ -n "\$LATEST_SESSION" ]; then
  mkdir -p "\$WT_PROJ_DIR"
  if [ ! -e "\$WT_PROJ_DIR/\$LATEST_SESSION.jsonl" ]; then
    ln "\$MAIN_PROJ_DIR/\$LATEST_SESSION.jsonl" "\$WT_PROJ_DIR/\$LATEST_SESSION.jsonl" 2>/dev/null || \
      cp "\$MAIN_PROJ_DIR/\$LATEST_SESSION.jsonl" "\$WT_PROJ_DIR/\$LATEST_SESSION.jsonl" 2>/dev/null || true
  fi
  # Symlink session metadata + memory dirs
  if [ -d "\$MAIN_PROJ_DIR/\$LATEST_SESSION" ] && [ ! -e "\$WT_PROJ_DIR/\$LATEST_SESSION" ]; then
    ln -s "\$MAIN_PROJ_DIR/\$LATEST_SESSION" "\$WT_PROJ_DIR/\$LATEST_SESSION" 2>/dev/null || true
  fi
  if [ -d "\$MAIN_PROJ_DIR/memory" ] && [ ! -e "\$WT_PROJ_DIR/memory" ]; then
    ln -s "\$MAIN_PROJ_DIR/memory" "\$WT_PROJ_DIR/memory" 2>/dev/null || true
  fi
  log "hardlinked session \$LATEST_SESSION to \$WT_PROJ_DIR"
fi

# Layout
PANE_COUNT=$($TMUX_BIN list-panes -t "\$SESSION" -F '#{pane_id}' 2>/dev/null | wc -l | tr -d ' ')
if [ "\$PANE_COUNT" -le 1 ]; then
  SPLIT_FLAG="-h -p 65"
  SPLIT_TARGET="\$SESSION"
else
  SPLIT_FLAG="-v"
  SPLIT_TARGET=$($TMUX_BIN list-panes -t "\$SESSION" -F '#{pane_id}' | tail -1)
fi

# Split pane and launch claude -c --fork-session in the worktree
$TMUX_BIN split-window -t "\$SPLIT_TARGET" \$SPLIT_FLAG -c "\$WT_DIR" "claude -c --fork-session || exec \\\$SHELL"

log "fork done: \$BRANCH_SAFE (wt=\$WT_DIR)"
$TMUX_BIN display-message "Forked to \$BRANCH_SAFE"
`)
  chmodSync(scriptPath, '755')
  return scriptPath
}

function ensureCloseScript(): string {
  const scriptPath = join(tmpdir(), 'kitty_close.sh')
  writeFileSync(scriptPath, `#!/bin/bash
# Kitty Close Pane — if the pane is inside a .worktrees/<branch> directory and
# no other pane is still using that worktree, clean up the worktree (git remove,
# ~/.claude/projects/<wt-key>, .mcp.json) before killing the pane.

PANE_ID="\$1"
if [ -z "\$PANE_ID" ]; then
  exit 0
fi

TMUX_BIN="${TMUX}"
LOG=/tmp/kitty_close.log

PANE_CWD=\$(\$TMUX_BIN display-message -p -t "\$PANE_ID" '#{pane_current_path}' 2>/dev/null || echo "")

# Walk up from PANE_CWD to find a worktree ancestor.
# Matches both legacy .worktrees/<name> and Claude-native .claude/worktrees/<name>.
WT_DIR=""
if [ -n "\$PANE_CWD" ]; then
  CUR="\$PANE_CWD"
  while [ -n "\$CUR" ] && [ "\$CUR" != "/" ]; do
    PARENT=\$(dirname "\$CUR")
    PNAME=\$(basename "\$PARENT")
    if [ "\$PNAME" = ".worktrees" ] || [ "\$PNAME" = "worktrees" ]; then
      # For .claude/worktrees/<name>, the grandparent must be .claude
      if [ "\$PNAME" = "worktrees" ]; then
        GPARENT=\$(basename "\$(dirname "\$PARENT")")
        if [ "\$GPARENT" = ".claude" ]; then
          WT_DIR="\$CUR"
          break
        fi
      else
        WT_DIR="\$CUR"
        break
      fi
    fi
    CUR="\$PARENT"
  done
fi

if [ -n "\$WT_DIR" ] && [ -d "\$WT_DIR" ]; then
  # Count other panes (any session) whose cwd is inside this worktree
  OTHER_COUNT=0
  while IFS='|' read -r OPID OCWD; do
    [ "\$OPID" = "\$PANE_ID" ] && continue
    case "\$OCWD" in
      "\$WT_DIR"|"\$WT_DIR"/*) OTHER_COUNT=\$((OTHER_COUNT + 1));;
    esac
  done < <(\$TMUX_BIN list-panes -a -F '#{pane_id}|#{pane_current_path}' 2>/dev/null || true)

  if [ "\$OTHER_COUNT" -eq 0 ]; then
    # Find main project root via git --git-common-dir
    PROJ_ROOT=""
    GCD=\$(git -C "\$WT_DIR" rev-parse --git-common-dir 2>/dev/null || echo "")
    if [ -n "\$GCD" ]; then
      case "\$GCD" in
        /*) PROJ_ROOT=\$(dirname "\$GCD") ;;
        *)  PROJ_ROOT=\$(cd "\$WT_DIR" 2>/dev/null && cd "\$(dirname "\$GCD")" 2>/dev/null && pwd) ;;
      esac
    fi
    if [ -z "\$PROJ_ROOT" ]; then
      PROJ_ROOT=\$(dirname "\$(dirname "\$WT_DIR")")
    fi

    # Clean up Claude project dir. Claude encodes: /[^a-zA-Z0-9]/g → '-'
    # Try both the correct encoding and legacy slash-only variant.
    WT_KEY_CORRECT=\$(echo "\$WT_DIR" | sed 's/[^a-zA-Z0-9]/-/g')
    WT_KEY_LEGACY=\$(echo "\$WT_DIR" | sed 's|/|-|g')
    for KEY in "\$WT_KEY_CORRECT" "\$WT_KEY_LEGACY"; do
      [ -z "\$KEY" ] && continue
      WT_PROJ_DIR="\$HOME/.claude/projects/\$KEY"
      if [ -d "\$WT_PROJ_DIR" ]; then
        rm -rf "\$WT_PROJ_DIR" 2>/dev/null || true
      fi
    done

    rm -f "\$WT_DIR/.mcp.json" 2>/dev/null || true

    # git worktree remove, then prune
    if [ -n "\$PROJ_ROOT" ] && { [ -d "\$PROJ_ROOT/.git" ] || [ -f "\$PROJ_ROOT/.git" ]; }; then
      git -C "\$PROJ_ROOT" worktree remove "\$WT_DIR" --force 2>>"\$LOG" || rm -rf "\$WT_DIR" 2>/dev/null || true
      git -C "\$PROJ_ROOT" worktree prune 2>/dev/null || true
    else
      rm -rf "\$WT_DIR" 2>/dev/null || true
    fi

    \$TMUX_BIN display-message "Worktree cleaned: \$(basename "\$WT_DIR")" 2>/dev/null || true
    echo "[\$(date '+%F %T')] closed pane \$PANE_ID, cleaned \$WT_DIR" >> "\$LOG" 2>/dev/null || true
  else
    echo "[\$(date '+%F %T')] closed pane \$PANE_ID, skipped cleanup of \$WT_DIR (\$OTHER_COUNT other panes)" >> "\$LOG" 2>/dev/null || true
  fi
fi

# Finally kill the pane
\$TMUX_BIN kill-pane -t "\$PANE_ID" 2>/dev/null || true
`)
  chmodSync(scriptPath, '755')
  return scriptPath
}

