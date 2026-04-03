import { writeFileSync, chmodSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'

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
  /** Flag to continue most recent session */
  continueFlag?: string
  /** Flag to resume a specific session, followed by session ID */
  resumeFlag?: string
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
  if (tool === 'shell') return true // shell is always available
  try {
    execSync(`which ${config.cmd}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
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

function buildContinueScript(config: ToolConfig): string {
  if (!config.continueFlag) return buildNewScript(config)

  return `#!/bin/bash
# Try to continue most recent session, fallback to new
${config.cmd} ${config.continueFlag} 2>/dev/null
EXIT=$?
if [ $EXIT -ne 0 ]; then
  echo "No session to continue, starting new..."
  ${config.cmd}
fi
# Keep shell alive if tool exits
exec $SHELL
`
}

function buildNewScript(config: ToolConfig): string {
  return `#!/bin/bash
${config.cmd}
# Keep shell alive if tool exits
exec $SHELL
`
}

function buildResumeScript(config: ToolConfig, resumeId: string): string {
  if (!config.resumeFlag) return buildNewScript(config)

  return `#!/bin/bash
# Resume specific session, fallback to continue, then new
${config.cmd} ${config.resumeFlag} "${resumeId}" 2>/dev/null
EXIT=$?
if [ $EXIT -ne 0 ]; then
  echo "Resume failed, trying continue..."
  ${config.cmd} ${config.continueFlag || ''} 2>/dev/null || ${config.cmd}
fi
# Keep shell alive if tool exits
exec $SHELL
`
}

function buildRestoreScript(config: ToolConfig): string {
  // Best-effort: try continue → new → shell
  if (!config.continueFlag) {
    return `#!/bin/bash
${config.cmd} 2>/dev/null || exec $SHELL
`
  }

  return `#!/bin/bash
# Restore: try continue, then new, then fallback to shell
${config.cmd} ${config.continueFlag} 2>/dev/null
EXIT=$?
if [ $EXIT -ne 0 ]; then
  ${config.cmd} 2>/dev/null || true
fi
# Keep shell alive if tool exits
exec $SHELL
`
}
