import { writeFileSync, chmodSync, existsSync, readFileSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir, homedir } from 'os'

/** Common binary directories not in GUI app's PATH */
const EXTRA_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  join(require('os').homedir(), '.local', 'bin'),
  join(require('os').homedir(), '.npm-global', 'bin'),
]

function findBinary(name: string): string | null {
  for (const dir of EXTRA_BIN_DIRS) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  try {
    return execSync(`which ${name}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

/**
 * CLI wrapper layer: generates shell scripts that handle continue/new/restore
 * logic for each supported AI CLI tool.
 *
 * Modes:
 *  - 'continue'  → try to continue most recent session, fallback to new
 *  - 'new'       → start fresh session
 *  - 'resume'    → resume a specific session by ID
 *  - 'restore'   → best-effort restore (try continue, then new, then shell)
 */

export type LaunchMode = 'continue' | 'new' | 'resume' | 'restore'

interface ToolConfig {
  /** Base command */
  cmd: string
  /** Default arguments appended to every invocation */
  defaultArgs?: string
  /** Flag to continue most recent session */
  continueFlag?: string
  /** Flag to resume a specific session, followed by session ID */
  resumeFlag?: string
}

/**
 * User config file: ~/.kitty-kitty/config.json
 *
 * Example:
 * {
 *   "toolArgs": {
 *     "claude": "--dangerously-skip-permissions",
 *     "codex": "--some-flag"
 *   }
 * }
 */
const CONFIG_PATH = join(homedir(), '.kitty-kitty', 'config.json')

interface KittyConfig {
  toolArgs?: Record<string, string>
  ntfyTopic?: string
}

function loadConfig(): KittyConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    }
  } catch { /* ignore parse errors */ }
  // Create default config if missing
  const defaultConfig: KittyConfig = { toolArgs: { claude: '' } }
  try {
    mkdirSync(join(homedir(), '.kitty-kitty'), { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2))
  } catch { /* ignore */ }
  return defaultConfig
}

export function getUserToolArgs(tool: string): string {
  const config = loadConfig()
  return config.toolArgs?.[tool] ?? ''
}

export function getNtfyTopic(): string {
  const config = loadConfig()
  return config.ntfyTopic ?? ''
}

export function setNtfyTopic(topic: string): void {
  const config = loadConfig()
  config.ntfyTopic = topic
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

const TOOLS: Record<string, ToolConfig> = {
  claude: {
    cmd: 'claude',
    continueFlag: '-c',
    resumeFlag: '--resume',
  },
  codex: {
    cmd: 'codex',
    continueFlag: 'resume --last',
    resumeFlag: 'resume',
  },
  aichat: {
    cmd: 'aichat',
  },
  shell: {
    cmd: '$SHELL',
  },
}

/**
 * Check if a CLI tool is installed. Returns true if available.
 */
export function isToolInstalled(tool: string): boolean {
  const config = TOOLS[tool]
  if (!config) return false
  if (tool === 'shell') return true
  return findBinary(config.cmd) !== null
}

/**
 * Get human-readable install instructions for a tool.
 */
export function getInstallHint(tool: string): string {
  switch (tool) {
    case 'claude': return '安装方法: npm install -g @anthropic-ai/claude-code'
    case 'codex': return '安装方法: npm install -g @openai/codex'
    case 'aichat': return '安装方法: brew install aichat'
    default: return `请先安装 ${tool}`
  }
}

/**
 * Generate a wrapper shell script for launching a CLI tool.
 * Returns the path to the generated script.
 */
export function generateLaunchScript(
  tool: string,
  mode: LaunchMode,
  resumeId?: string
): string {
  const config = TOOLS[tool] || { cmd: tool }
  const scriptPath = join(tmpdir(), `kitty_launch_${Date.now()}.sh`)

  let script: string

  switch (mode) {
    case 'continue':
      script = buildContinueScript(config)
      break
    case 'new':
      script = buildNewScript(config)
      break
    case 'resume':
      script = buildResumeScript(config, resumeId!)
      break
    case 'restore':
      script = buildRestoreScript(config)
      break
  }

  writeFileSync(scriptPath, script)
  chmodSync(scriptPath, '755')
  return scriptPath
}

/**
 * Get the raw command string for a tool (for simple cases).
 */
export function getToolCommand(tool: string): string {
  return TOOLS[tool]?.cmd || tool
}

// --- Script builders ---

const PATH_PREAMBLE = 'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"'

/** Build the full base command: cmd + hardcoded defaultArgs + user config toolArgs */
function baseCmd(config: ToolConfig): string {
  const parts = [config.cmd]
  if (config.defaultArgs) parts.push(config.defaultArgs)
  const userArgs = getUserToolArgs(config.cmd)
  if (userArgs) parts.push(userArgs)
  return parts.join(' ')
}

/**
 * Check whether the current claude toolArgs includes the dev-channels flag.
 * Used by the main process to decide whether to start an auto-accept poller.
 */
export function needsDevChannelAutoAccept(tool: string): boolean {
  if (tool !== 'claude') return false
  const userArgs = getUserToolArgs(tool)
  return userArgs.includes('--dangerously-load-development-channels')
}

function buildContinueScript(config: ToolConfig): string {
  if (!config.continueFlag) return buildNewScript(config)
  const cmd = baseCmd(config)

  return `#!/bin/bash
${PATH_PREAMBLE}
# Try to continue most recent session, fallback to new
${cmd} ${config.continueFlag} 2>/dev/null
EXIT=$?
if [ $EXIT -ne 0 ]; then
  echo "No session to continue, starting new..."
  ${cmd}
fi
# Keep shell alive if tool exits
exec $SHELL
`
}

function buildNewScript(config: ToolConfig): string {
  const cmd = baseCmd(config)
  return `#!/bin/bash
${PATH_PREAMBLE}
${cmd}
# Keep shell alive if tool exits
exec $SHELL
`
}

function buildResumeScript(config: ToolConfig, resumeId: string): string {
  if (!config.resumeFlag) return buildNewScript(config)
  const cmd = baseCmd(config)

  return `#!/bin/bash
${PATH_PREAMBLE}
# Resume specific session, fallback to continue, then new
${cmd} ${config.resumeFlag} "${resumeId}" 2>/dev/null
EXIT=$?
if [ $EXIT -ne 0 ]; then
  echo "Resume failed, trying continue..."
  ${cmd} ${config.continueFlag || ''} 2>/dev/null || ${cmd}
fi
# Keep shell alive if tool exits
exec $SHELL
`
}

function buildRestoreScript(config: ToolConfig): string {
  const cmd = baseCmd(config)
  // Best-effort: try continue → new → shell
  if (!config.continueFlag) {
    return `#!/bin/bash
${PATH_PREAMBLE}
${cmd} 2>/dev/null || exec $SHELL
`
  }

  return `#!/bin/bash
${PATH_PREAMBLE}
# Restore: try continue, then new, then fallback to shell
${cmd} ${config.continueFlag} 2>/dev/null
EXIT=$?
if [ $EXIT -ne 0 ]; then
  ${cmd} 2>/dev/null || true
fi
# Keep shell alive if tool exits
exec $SHELL
`
}
