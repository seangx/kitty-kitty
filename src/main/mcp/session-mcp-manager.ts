import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { SESSION_MCP_SERVER_SCRIPT } from './session-server-script'
import { log } from '../logger'

const SCRIPT_FILENAME = 'kitty-session-server.js'

// Track which sessions have the session MCP injected
const injectedSessions = new Set<string>()

/**
 * Get the path where the session MCP script is stored on disk.
 */
function getScriptPath(): string {
  const { tmpdir } = require('os')
  return join(tmpdir(), SCRIPT_FILENAME)
}

/**
 * Ensure the MCP server script exists on disk.
 */
function ensureScript(): string {
  const scriptPath = getScriptPath()
  writeFileSync(scriptPath, SESSION_MCP_SERVER_SCRIPT)
  require('fs').chmodSync(scriptPath, '755')
  return scriptPath
}

/**
 * Check if a directory is a git repository.
 */
function isGitRepo(dir: string): boolean {
  try {
    execSync(`git -C "${dir}" rev-parse --git-dir`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the Node.js executable path.
 */
function resolveNodePath(): string {
  const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  try {
    return execSync('command -v node', { encoding: 'utf-8' }).trim()
  } catch {
    throw new Error('Cannot find Node.js')
  }
}

/**
 * Inject the kitty-session MCP server into a session's project.
 * All sessions with cwd get basic pane tools. Git repos also get worktree tools.
 */
export function injectSessionMcp(
  sessionId: string,
  cwd: string,
  tmuxName: string,
  sessionTitle: string,
  groupId?: string,
  groupName?: string,
  tool?: string
): void {
  if (!cwd) return
  if (injectedSessions.has(sessionId)) return

  try {
    const scriptPath = ensureScript()
    const nodePath = resolveNodePath()
    const configPath = join(cwd, '.mcp.json')

    let config: any = {}
    try { config = JSON.parse(readFileSync(configPath, 'utf-8')) } catch { /* new file */ }
    if (!config.mcpServers) config.mcpServers = {}

    config.mcpServers['kitty-session'] = {
      command: nodePath,
      args: [scriptPath],
      env: {
        KITTY_AGENT_ID: sessionId,
        KITTY_TMUX_NAME: tmuxName,
        KITTY_PROJECT_ROOT: cwd,
        KITTY_IS_GIT_REPO: isGitRepo(cwd) ? '1' : '0',
      }
    }

    // kitty-talk (communication)
    const { ensureRuntimeArtifacts } = require('./collab-manager')
    const { scriptPath: talkScriptPath, busDir } = ensureRuntimeArtifacts()
    config.mcpServers['kitty-talk'] = {
      command: nodePath,
      args: [talkScriptPath],
      env: {
        KITTY_AGENT_ID: sessionId,
        KITTY_AGENT_NAME: sessionTitle,
        KITTY_BUS_DIR: busDir,
        KITTY_GROUP_ID: groupId || '',
        KITTY_GROUP_NAME: groupName || '',
        KITTY_TOOL: tool || '',
        KITTY_CWD: cwd,
      }
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2))
    injectedSessions.add(sessionId)
    log('session-mcp', `injected session=${sessionId} cwd=${cwd}`)
  } catch (err) {
    log('session-mcp', `inject failed session=${sessionId}:`, err)
  }
}

/**
 * Update the group ID/name in kitty-talk config without restarting the agent.
 */
export function updateGroupId(sessionId: string, cwd: string, groupId: string, groupName: string): void {
  if (!cwd) return
  try {
    const configPath = join(cwd, '.mcp.json')
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    if (config?.mcpServers?.['kitty-talk']?.env) {
      config.mcpServers['kitty-talk'].env.KITTY_GROUP_ID = groupId || ''
      config.mcpServers['kitty-talk'].env.KITTY_GROUP_NAME = groupName || ''
      writeFileSync(configPath, JSON.stringify(config, null, 2))
      log('session-mcp', `updated groupId=${groupId} for session=${sessionId}`)
    }
  } catch (err) {
    log('session-mcp', `updateGroupId failed session=${sessionId}:`, err)
  }
}

/**
 * Remove the kitty-session and kitty-talk MCP servers from a session's project.
 */
export function removeSessionMcp(sessionId: string, cwd: string): void {
  if (!cwd) return

  try {
    const configPath = join(cwd, '.mcp.json')
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    delete config?.mcpServers?.['kitty-session']
    delete config?.mcpServers?.['kitty-talk']
    if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
      unlinkSync(configPath)
    } else {
      writeFileSync(configPath, JSON.stringify(config, null, 2))
    }
  } catch { /* ignore */ }

  injectedSessions.delete(sessionId)
}

/**
 * Check if a session already has session MCP injected.
 */
export function hasSessionMcp(sessionId: string): boolean {
  return injectedSessions.has(sessionId)
}

/**
 * Clean up: remove all injected session MCP configs.
 */
export function cleanupAll(): void {
  // Note: we don't remove .mcp.json entries here because sessions may still be alive
  // (kitty-kitty restores sessions on next launch). Cleanup happens via removeSessionMcp
  // when sessions are explicitly killed.
  injectedSessions.clear()
}
