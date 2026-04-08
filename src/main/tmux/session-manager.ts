import { execSync, exec } from 'child_process'
import { existsSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { v4 as uuid } from 'uuid'

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
  return TOOL_COMMANDS[tool] || tool // fallback to raw command string
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
  execSync(`${TMUX} new-session -d -s "${tmuxName}" -c "${cwd}" "${command}"`, {
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
  const escaped = text.replace(/"/g, '\\"')
  execSync(`${TMUX} send-keys -t "${tmuxName}" "${escaped}" Enter`, { stdio: 'ignore' })
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
    exec(`/Applications/Ghostty.app/Contents/MacOS/ghostty --window-save-state=never --confirm-close-surface=false --macos-option-as-alt=true --command="${TMUX} attach-session -t ${tmuxName}"`, {
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
        exec(`${term} -e "tmux attach-session -t ${tmuxName}"`)
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
    cwd = execSync(`${TMUX} display-message -t "${tmuxName}" -p "#{pane_current_path}"`,
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
      `tmux list-sessions -F "#{session_name}:#{session_attached}"`,
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
    execSync(`${TMUX} has-session -t "${tmuxName}"`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Kill a tmux session
 */
/**
 * Focus the Ghostty window that has this tmux session, and switch client to it
 */
export function focusSession(tmuxName: string): void {
  try {
    execSync(`${TMUX} switch-client -t "${tmuxName}"`, { stdio: 'ignore' })
  } catch { /* ignore */ }

  // Force immediate status bar refresh on all sessions
  try {
    execSync(`${TMUX} refresh-client -S`, { stdio: 'ignore' })
  } catch { /* ignore */ }

  if (process.platform === 'darwin') {
    exec(`osascript -e 'tell application "Ghostty" to activate'`)
  }
}

export function killSession(tmuxName: string): void {
  try {
    execSync(`${TMUX} kill-session -t "${tmuxName}"`, { stdio: 'ignore' })
  } catch { /* already dead */ }
  // Refresh other sessions' status bars
  refreshAllStatusBars()
}

/**
 * Get the last line of output from a tmux pane (for status detection)
 */
export function capturePane(tmuxName: string, lines = 3): string {
  try {
    return execSync(
      `${TMUX} capture-pane -t "${tmuxName}" -p -J | tail -${lines}`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
  } catch {
    return ''
  }
}

/**
 * Apply kitty-kitty status bar to a tmux session.
 * Shows all kitty sessions as clickable tabs with switch keybindings.
 */
export function applyKittyStatusBar(tmuxName: string): void {
  try {
    const tabsScript = ensureTabScript()
    const opts: string[] = [
      `set-option -t "${tmuxName}" status on`,
      `set-option -t "${tmuxName}" status-position bottom`,
      `set-option -t "${tmuxName}" status-style "bg=#2a2a45,fg=#aaa8c3"`,
      `set-option -t "${tmuxName}" status-left-length 200`,
      `set-option -t "${tmuxName}" status-right-length 12`,
      `set-option -t "${tmuxName}" status-left "#(${tabsScript})"`,
      `set-option -t "${tmuxName}" status-right " #[fg=#aaa8c3]%H:%M "`,
      // No window list — everything is in status-left
      `set-window-option -t "${tmuxName}" window-status-format ""`,
      `set-window-option -t "${tmuxName}" window-status-current-format ""`,
      `set-option -t "${tmuxName}" status-interval 5`,
      `set-option -t "${tmuxName}" mouse on`,
    ]

    for (const cmd of opts) {
      try { execSync(`${TMUX} ${cmd}`, { stdio: 'ignore' }) } catch { /* ignore */ }
    }

    // Global keybindings (idempotent)
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

    // Ctrl+1~9 to switch to kitty session by index
    bindNumberKeys()
  } catch { /* ignore */ }
}

/**
 * Bind Ctrl+1~9 to switch to the Nth kitty session
 */
function bindNumberKeys(): void {
  const sessions = listTmuxSessions().map(s => s.name)
  for (let i = 0; i < 9; i++) {
    const target = sessions[i]
    if (target) {
      // Alt+<number> (M- = Meta/Option key), works in Ghostty/iTerm/Terminal
      try {
        execSync(`${TMUX} bind-key -n M-${i + 1} switch-client -t "${target}"`, { stdio: 'ignore' })
      } catch { /* ignore */ }
    } else {
      try {
        execSync(`${TMUX} unbind-key -n M-${i + 1}`, { stdio: 'ignore' })
      } catch { /* ignore */ }
    }
  }
}

/**
 * Refresh the status bar of all kitty sessions (called after session changes)
 */
export function refreshAllStatusBars(): void {
  const tabsScript = ensureTabScript()
  const sessions = listTmuxSessions()
  for (const s of sessions) {
    try {
      execSync(`${TMUX} set-option -t "${s.name}" status-left "#(${tabsScript})"`, { stdio: 'ignore' })
    } catch { /* ignore */ }
  }
  // Force immediate visual refresh
  try {
    execSync(`${TMUX} refresh-client -S`, { stdio: 'ignore' })
  } catch { /* ignore */ }
  bindNumberKeys()
}

function ensureTabScript(): string {
  const { homedir } = require('os')
  const dbPath = join(homedir(), 'Library', 'Application Support', 'kitty-kitty', 'kitty-kitty.db')
  const scriptPath = join(tmpdir(), 'kitty_tabs.sh')
  writeFileSync(scriptPath, `#!/bin/bash
TMUX_BIN="${TMUX}"
CURRENT=$($TMUX_BIN display-message -p '#S')
DB="${dbPath}"
N=0
$TMUX_BIN list-sessions -F '#{session_name}' 2>/dev/null | grep '^${SESSION_PREFIX}' | while read -r S; do
  N=$((N+1))
  TITLE="$S"
  TOOL=""
  if [ -f "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
    T=$(sqlite3 "$DB" "SELECT title FROM sessions WHERE tmux_name='$S' LIMIT 1;" 2>/dev/null)
    [ -n "$T" ] && TITLE="$T"
    TOOL=$(sqlite3 "$DB" "SELECT tool FROM sessions WHERE tmux_name='$S' LIMIT 1;" 2>/dev/null)
  fi
  # Status dot: check if pane has a running foreground process
  PANE_CMD=$($TMUX_BIN list-panes -t "$S" -F '#{pane_current_command}' 2>/dev/null | head -1)
  case "$PANE_CMD" in
    bash|zsh|sh|fish|"") DOTCOLOR="#06d6a0" ;;   # cyan-green = idle
    *)                   DOTCOLOR="#ffb148" ;;     # amber = busy
  esac
  # Git branch with color: release=red, main/master=yellow, feature=green, other=purple
  BRANCH=""
  CWD=""
  if [ -f "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
    CWD=$(sqlite3 "$DB" "SELECT cwd FROM sessions WHERE tmux_name='$S' LIMIT 1;" 2>/dev/null)
  fi
  if [ -n "$CWD" ] && [ -d "$CWD" ]; then
    B=$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null)
    if [ -n "$B" ]; then
      case "$B" in
        release*) BCOLOR="#e11d48" ;;
        main|master) BCOLOR="#d97706" ;;
        feature*) BCOLOR="#10b981" ;;
        *) BCOLOR="#8b5cf6" ;;
      esac
      BRANCH="$BCOLOR|$B"
    fi
  fi
  BG="#2a2a45"
  if [ "$S" = "$CURRENT" ]; then
    FG="#06b6d4"
  else
    FG="#aaa8c3"
  fi
  if [ -n "$BRANCH" ]; then
    BCOLOR=$(echo "$BRANCH" | cut -d'|' -f1)
    BNAME=$(echo "$BRANCH" | cut -d'|' -f2)
    printf '#[fg=%s,bg=%s,bold] %d:%s #[fg=%s,bg=%s,nobold]%s #[fg=%s,bg=%s]● #[fg=#46465c,bg=%s,nobold] | ' \
      "$FG" "$BG" "$N" "$TITLE" "$BCOLOR" "$BG" "$BNAME" "$DOTCOLOR" "$BG" "$BG"
  else
    printf '#[fg=%s,bg=%s,bold] %d:%s #[fg=%s,bg=%s]● #[fg=#46465c,bg=%s,nobold] | ' \
      "$FG" "$BG" "$N" "$TITLE" "$DOTCOLOR" "$BG" "$BG"
  fi
done
`)
  chmodSync(scriptPath, '755')
  return scriptPath
}

