/**
 * Collaboration Manager
 *
 * Manages the MCP server lifecycle for inter-agent communication:
 * 1. Writes the MCP server script to disk
 * 2. Injects MCP config into agent's settings
 * 3. Restarts agent to pick up MCP
 * 4. Cleans up when collaboration ends
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, rmSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir, homedir } from 'os'
import { execSync, spawnSync, spawn, type ChildProcess } from 'child_process'
import { BrowserWindow } from 'electron'
import { IPC } from '@shared/types/ipc'
import { MCP_SERVER_SCRIPT } from './server-script'
import { InboxWatcher } from './inbox-watcher'
import { log } from '../logger'
import { TMUX } from '../tmux/session-manager'

const BUS_DIR = join(tmpdir(), 'kitty-bus')
const SCRIPT_PATH = join(tmpdir(), 'kitty-mcp-server.js')
const CODEX_PROXY_PATH = join(tmpdir(), 'kitty-mcp-codex-proxy.js')
const CODEX_SERVER_NAME = 'kitty-mcp'

// Track which sessions have MCP injected
const activeSessions = new Set<string>()
let appMcpService: ChildProcess | null = null
let inboxWatcher: InboxWatcher | null = null

function getInboxWatcher(): InboxWatcher {
  if (!inboxWatcher) {
    inboxWatcher = new InboxWatcher(BUS_DIR)
    inboxWatcher.onMessage((msg) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC.COLLAB_MESSAGE, msg)
      }
    })
  }
  return inboxWatcher
}

/**
 * Ensure the MCP server script exists on disk
 */
function ensureScript(): string {
  writeFileSync(SCRIPT_PATH, MCP_SERVER_SCRIPT)
  require('fs').chmodSync(SCRIPT_PATH, '755')
  return SCRIPT_PATH
}

/**
 * Keep runtime MCP artifacts in sync with current source code.
 * This prevents stale /tmp scripts after app upgrades or debug rebuilds.
 */
export function ensureRuntimeArtifacts(): { scriptPath: string; busDir: string; proxyPath: string | null } {
  const scriptPath = ensureScript()
  const busDir = ensureBusDir()
  cleanupCodexGlobalLegacyTables()
  cleanupCodexLegacySessionProjectConfigs()
  let proxyPath: string | null = null
  try {
    proxyPath = ensureCodexProxy(resolveNodePath())
  } catch (err) {
    log('collab', 'ensure codex proxy failed (will retry on injection):', err)
  }
  return { scriptPath, busDir, proxyPath }
}

/**
 * Start a lightweight app-scoped MCP process that follows kitty app lifecycle.
 * Collaboration sessions still use injected project MCP config on demand.
 */
export function startAppMcpService(): void {
  if (appMcpService && appMcpService.exitCode == null && !appMcpService.killed) return
  try {
    const { scriptPath, busDir } = ensureRuntimeArtifacts()
    const nodePath = resolveNodePath()
    appMcpService = spawn(nodePath, [scriptPath], {
      env: {
        ...process.env,
        KITTY_AGENT_ID: 'kitty-app',
        KITTY_AGENT_NAME: 'kitty-app',
        KITTY_GROUP_ID: '__kitty_app__',
        KITTY_BUS_DIR: busDir,
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    appMcpService.stderr?.on('data', (chunk) => {
      const text = String(chunk || '').trim()
      if (text) log('collab', `app mcp stderr: ${text}`)
    })
    appMcpService.on('exit', (code, signal) => {
      log('collab', `app mcp exited code=${String(code)} signal=${String(signal)}`)
      appMcpService = null
    })
    log('collab', `app mcp started pid=${appMcpService.pid}`)
  } catch (err) {
    appMcpService = null
    log('collab', 'app mcp start failed:', err)
  }
}

export function stopAppMcpService(): void {
  if (!appMcpService) return
  try {
    appMcpService.kill('SIGTERM')
  } catch { /* ignore */ }
  appMcpService = null
}

function ensureCodexProxy(nodePath: string): string {
  const proxy = `#!/usr/bin/env node
const fs = require('fs');
const { spawn } = require('child_process');
const logPath = '/tmp/kitty-mcp-codex.log';
const targetScript = process.argv[2];
if (!targetScript) {
  fs.appendFileSync(logPath, '[proxy] missing target script\\\\n');
  process.exit(2);
}
function log(msg) {
  try { fs.appendFileSync(logPath, '[' + new Date().toISOString() + '] ' + msg + '\\\\n'); } catch {}
}
log('start pid=' + process.pid + ' target=' + targetScript + ' agent=' + (process.env.KITTY_AGENT_ID || ''));
const child = spawn(${JSON.stringify(nodePath)}, [targetScript], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
process.stdin.on('data', (chunk) => {
  log('stdin bytes=' + chunk.length);
  if (!global.__kittyLoggedHeader) {
    global.__kittyLoggedHeader = true;
    const preview = chunk.toString('utf8').slice(0, 220).replace(/\\r/g, '\\\\r').replace(/\\n/g, '\\\\n');
    log('stdin preview=' + preview);
    const tailHex = chunk.slice(Math.max(0, chunk.length - 12)).toString('hex');
    log('stdin tail_hex=' + tailHex);
  }
  child.stdin.write(chunk);
});
process.stdin.on('end', () => child.stdin.end());
child.stdout.on('data', (chunk) => {
  log('stdout bytes=' + chunk.length);
  if (!global.__kittyLoggedStdoutPreview) {
    global.__kittyLoggedStdoutPreview = true;
    const preview = chunk.toString('utf8').slice(0, 260).replace(/\\r/g, '\\\\r').replace(/\\n/g, '\\\\n');
    log('stdout preview=' + preview);
  }
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  log('stderr ' + chunk.toString('utf8').trim());
  process.stderr.write(chunk);
});
child.on('exit', (code, signal) => {
  log('child exit code=' + String(code) + ' signal=' + String(signal));
  process.exit(code ?? 0);
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
`
  writeFileSync(CODEX_PROXY_PATH, proxy)
  require('fs').chmodSync(CODEX_PROXY_PATH, '755')
  return CODEX_PROXY_PATH
}

/**
 * Ensure the message bus directory exists
 */
function ensureBusDir(): string {
  if (!existsSync(BUS_DIR)) mkdirSync(BUS_DIR, { recursive: true })
  return BUS_DIR
}

/**
 * @deprecated Use session-mcp-manager.injectSessionMcp + collab.watchInbox instead.
 * Start collaboration for a session: inject MCP config and restart agent
 */
export function startCollaboration(
  sessionId: string,
  agentName: string,
  groupId: string | null,
  cwd: string,
  tmuxName: string,
  tool: string
): void {
  try {
    const { scriptPath, busDir } = ensureRuntimeArtifacts()
    const sessionEnv = buildSessionEnv(sessionId, agentName, groupId, busDir)

    if (tool === 'claude') {
      injectClaudeMcp(cwd, sessionId, agentName, groupId, scriptPath, busDir)
    } else if (tool === 'codex') {
      injectCodexMcp(cwd, tmuxName, sessionId, agentName, groupId, scriptPath, busDir)
    }
    // Future: add aichat support here

    activeSessions.add(sessionId)
    getInboxWatcher().watch(sessionId, tmuxName, tool)

    // Restart the agent in the tmux pane to pick up MCP config
    restartAgent(tmuxName, tool, tool === 'codex' ? sessionEnv : undefined)
    log('collab', `started session=${sessionId} tool=${tool} tmux=${tmuxName}`)
  } catch (err) {
    log('collab', `start failed session=${sessionId}:`, err)
    throw err
  }
}

/**
 * @deprecated Use session-mcp-manager.removeSessionMcp + collab.unwatchInbox instead.
 * Stop collaboration for a session: remove MCP config and restart
 */
export function stopCollaboration(
  sessionId: string,
  cwd: string,
  tmuxName: string,
  tool: string
): void {
  try {
    if (tool === 'claude') {
      removeClaudeMcp(cwd, sessionId)
    } else if (tool === 'codex') {
      removeCodexMcp(cwd, tmuxName)
    }

    // Clean up inbox
    const inboxFile = join(BUS_DIR, `${sessionId}.inbox.jsonl`)
    try { unlinkSync(inboxFile) } catch { /* ignore */ }

    // Unregister from agents list
    const agentsFile = join(BUS_DIR, 'agents.json')
    try {
      const agents = JSON.parse(readFileSync(agentsFile, 'utf-8'))
      delete agents[sessionId]
      writeFileSync(agentsFile, JSON.stringify(agents, null, 2))
    } catch { /* ignore */ }

    activeSessions.delete(sessionId)
    getInboxWatcher().unwatch(sessionId)

    restartAgent(tmuxName, tool)
    log('collab', `stopped session=${sessionId} tool=${tool} tmux=${tmuxName}`)
  } catch (err) {
    log('collab', `stop failed session=${sessionId}:`, err)
    throw err
  }
}

/**
 * Restart one session agent from UI bubble action.
 * If group collaboration is enabled, rehydrate collab launch path
 * so env/config are injected before restart.
 */
export function restartSessionAgent(
  sessionId: string,
  agentName: string,
  groupId: string | null,
  cwd: string,
  tmuxName: string,
  tool: string,
  collabEnabled: boolean
): void {
  if (collabEnabled) {
    startCollaboration(sessionId, agentName, groupId, cwd, tmuxName, tool)
    return
  }
  restartAgent(tmuxName, tool)
}

/**
 * Check if a session has MCP active
 */
export function isCollaborating(sessionId: string, cwd?: string, tool?: string, tmuxName?: string): boolean {
  // Opportunistic self-healing: refresh runtime scripts even when collaboration
  // was enabled in a previous app run.
  ensureRuntimeArtifacts()
  if (activeSessions.has(sessionId)) return true
  if (tool === 'claude') return hasClaudeMcp(sessionId, cwd)
  if (tool === 'codex') return hasCodexMcp(cwd, tmuxName)
  return hasClaudeMcp(sessionId) || hasCodexMcp(cwd, tmuxName)
}

/**
 * Remove agents.json entries for sessions NOT in the given active set.
 * Called after startup re-hydration to purge stale entries from crashed/killed runs.
 */
export function cleanupStaleAgents(activeIds: Set<string>): void {
  const agentsFile = join(BUS_DIR, 'agents.json')
  try {
    ensureBusDir()
    const agents = JSON.parse(readFileSync(agentsFile, 'utf-8'))
    let changed = false
    for (const id of Object.keys(agents)) {
      if (!activeIds.has(id)) {
        delete agents[id]
        changed = true
      }
    }
    if (changed) {
      writeFileSync(agentsFile, JSON.stringify(agents, null, 2))
      log('collab', `cleanupStaleAgents: removed ${Object.keys(agents).length === 0 ? 'all' : 'some'} stale entries`)
    }
  } catch { /* ignore: file may not exist yet */ }
}

/**
 * Start watching an agent's inbox for incoming messages.
 */
export function watchInbox(sessionId: string, tmuxName: string, tool: string): void {
  getInboxWatcher().watch(sessionId, tmuxName, tool)
}

/**
 * Stop watching an agent's inbox.
 */
export function unwatchInbox(sessionId: string): void {
  getInboxWatcher().unwatch(sessionId)
}

/**
 * Clean up all collaboration state
 */
export function cleanupAll(): void {
  if (inboxWatcher) {
    inboxWatcher.unwatchAll()
    inboxWatcher = null
  }
  try { rmSync(BUS_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
  try { unlinkSync(SCRIPT_PATH) } catch { /* ignore */ }
  activeSessions.clear()
}

// --- Claude Code specific ---

function getClaudeJsonPath(): string {
  return join(homedir(), '.claude.json')
}

function getCodexProjectConfigPath(cwd: string): string {
  return join(cwd, '.codex', 'config.toml')
}

function resolveCodexProjectCwd(cwd: string, tmuxName?: string): string {
  const fromTmux = tmuxName ? getTmuxPanePath(tmuxName) : ''
  if (fromTmux) {
    const gitRoot = getGitTopLevel(fromTmux)
    if (gitRoot) return gitRoot
    if (!isKittySessionPath(fromTmux)) return fromTmux
  }
  const gitRoot = getGitTopLevel(cwd)
  if (gitRoot) return gitRoot
  return cwd
}

function getTmuxPanePath(tmuxName: string): string {
  try {
    const target = `${tmuxName}:0.0`
    return execSync(
      `${TMUX} display-message -p -t "${target}" "#{pane_current_path}"`,
      { encoding: 'utf-8' }
    ).trim()
  } catch {
    return ''
  }
}

function getGitTopLevel(cwd: string): string {
  try {
    return execSync(`git -C ${shellEscape(cwd)} rev-parse --show-toplevel`, { encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

function isKittySessionPath(cwd: string): boolean {
  const sessionRoot = join(homedir(), '.kitty-kitty', 'sessions')
  return cwd === sessionRoot || cwd.startsWith(`${sessionRoot}/`)
}

function injectClaudeMcp(
  cwd: string,
  agentId: string,
  agentName: string,
  groupId: string | null,
  scriptPath: string,
  busDir: string
): void {
  // Claude Code reads project-level MCP from .mcp.json in project root
  const configPath = join(cwd, '.mcp.json')
  let config: any = {}
  try { config = JSON.parse(readFileSync(configPath, 'utf-8')) } catch { /* new file */ }

  if (!config.mcpServers) config.mcpServers = {}

  const nodePath = resolveNodePath()
  config.mcpServers['kitty-talk'] = {
    command: nodePath,
    args: [scriptPath],
    env: {
      KITTY_AGENT_ID: agentId,
      KITTY_AGENT_NAME: agentName,
      KITTY_BUS_DIR: busDir,
      KITTY_GROUP_ID: groupId || '',
    }
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2))
}

function removeClaudeMcp(cwd: string, _agentId?: string): void {
  const configPath = join(cwd, '.mcp.json')
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    if (config.mcpServers) {
      delete config.mcpServers['kitty-talk']
      if (Object.keys(config.mcpServers).length === 0) {
        unlinkSync(configPath)
      } else {
        writeFileSync(configPath, JSON.stringify(config, null, 2))
      }
    }
  } catch { /* ignore */ }
}

function injectCodexMcp(
  cwd: string,
  tmuxName: string,
  agentId: string,
  agentName: string,
  groupId: string | null,
  scriptPath: string,
  busDir: string
): void {
  const projectCwd = resolveCodexProjectCwd(cwd, tmuxName)
  const configPath = getCodexProjectConfigPath(projectCwd)
  let content = ''
  try { content = readFileSync(configPath, 'utf-8') } catch { /* new file */ }

  const serverName = CODEX_SERVER_NAME
  const tablePath = getCodexServerTablePath(serverName)
  const envTablePath = `${tablePath}.env`
  const nodePath = resolveNodePath()

  const cleaned = removeTomlTable(
    removeTomlTable(
      removeCodexLegacySessionTables(content),
      tablePath
    ),
    envTablePath
  ).trimEnd()
  const lines = [
    `[${tablePath}]`,
    `command = ${tomlString(nodePath)}`,
    `args = [${tomlString(scriptPath)}]`,
    '',
    `[${envTablePath}]`,
    `KITTY_AGENT_ID = ${tomlString(agentId)}`,
    `KITTY_AGENT_NAME = ${tomlString(agentName)}`,
    `KITTY_GROUP_ID = ${tomlString(groupId || '')}`,
    `KITTY_BUS_DIR = ${tomlString(busDir)}`,
  ]
  const next = `${cleaned}${cleaned ? '\n\n' : ''}${lines.join('\n')}\n`
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, next)
  cleanupCodexGlobalLegacyTables()
}

function removeCodexMcp(cwd: string, tmuxName: string): void {
  const projectCwd = resolveCodexProjectCwd(cwd, tmuxName)
  const configPath = getCodexProjectConfigPath(projectCwd)
  try {
    const content = readFileSync(configPath, 'utf-8')
    const serverName = CODEX_SERVER_NAME
    const tablePath = getCodexServerTablePath(serverName)
    const envTablePath = `${tablePath}.env`
    const next = removeTomlTable(
      removeTomlTable(removeCodexLegacySessionTables(content), tablePath),
      envTablePath
    )
    writeFileSync(configPath, `${next.trimEnd()}\n`)
  } catch { /* ignore */ }
}

function restartAgent(tmuxName: string, tool: string, sessionEnv?: Record<string, string>): void {
  const target = `${tmuxName}:0.0`
  try {
    if (tool === 'claude') {
      // Graceful quit keeps transcript cleanup logic in Claude itself.
      execSync(`${TMUX} send-keys -t "${target}" "/exit" Enter`, { stdio: 'ignore' })
    } else {
      execSync(`${TMUX} send-keys -t "${target}" C-c`, { stdio: 'ignore' })
    }

    // Wait until pane returns to a shell prompt before starting again.
    waitForPaneShell(target, 12000)
  } catch {
    // Fallback: foreground process may ignore graceful exit. Force-stop pane child process.
    forceStopPaneForegroundProcess(target)
    waitForPaneShell(target, 5000)
  }

  const cmd = buildRestartCommand(tool, sessionEnv)
  execSync(`${TMUX} send-keys -t "${target}" "${cmd}" Enter`, { stdio: 'ignore' })
}

function buildRestartCommand(tool: string, sessionEnv?: Record<string, string>): string {
  if (tool === 'codex') {
    // Do not use "--last" because it is global and can fork/resume unrelated
    // sessions from other terminals. Always launch a fresh Codex runtime.
    return buildAgentCommand('codex --yolo', sessionEnv)
  }
  if (tool === 'claude') {
    return buildAgentCommand('claude -c', sessionEnv)
  }
  return buildAgentCommand(tool, sessionEnv)
}

function waitForPaneShell(tmuxTarget: string, timeoutMs: number): void {
  const shellCommands = new Set(['zsh', 'bash', 'fish', 'sh', 'login'])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const current = execSync(
        `${TMUX} display-message -p -t "${tmuxTarget}" "#{pane_current_command}"`,
        { encoding: 'utf-8' }
      ).trim()
      if (shellCommands.has(current)) return
    } catch {
      // Keep polling: pane can be mid-transition while command exits.
    }
    spawnSync('sleep', ['0.2'])
  }
  throw new Error(`Timed out waiting for tmux pane "${tmuxTarget}" to return to shell`)
}

function forceStopPaneForegroundProcess(tmuxTarget: string): void {
  try {
    execSync(`${TMUX} send-keys -t "${tmuxTarget}" C-c`, { stdio: 'ignore' })
  } catch { /* ignore */ }
  let panePid = ''
  try {
    panePid = execSync(`${TMUX} display-message -p -t "${tmuxTarget}" "#{pane_pid}"`, { encoding: 'utf-8' }).trim()
  } catch { /* ignore */ }
  if (!panePid) return

  let childPids: string[] = []
  try {
    childPids = execSync(`pgrep -P "${panePid}" || true`, { encoding: 'utf-8' })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  } catch { /* ignore */ }
  if (!childPids.length) return

  for (const pid of childPids) {
    try { execSync(`kill -TERM ${pid}`, { stdio: 'ignore' }) } catch { /* ignore */ }
  }
  spawnSync('sleep', ['0.3'])
  for (const pid of childPids) {
    try { execSync(`kill -0 ${pid}`, { stdio: 'ignore' }); execSync(`kill -KILL ${pid}`, { stdio: 'ignore' }) } catch { /* ignore */ }
  }
}

function getServerName(agentId: string): string {
  return `kitty-talk-${agentId}`
}

function buildSessionEnv(
  sessionId: string,
  agentName: string,
  groupId: string | null,
  busDir: string
): Record<string, string> {
  return {
    KITTY_AGENT_ID: sessionId,
    KITTY_AGENT_NAME: agentName,
    KITTY_GROUP_ID: groupId || '',
    KITTY_BUS_DIR: busDir,
  }
}

function buildAgentCommand(baseCmd: string, env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return baseCmd
  const prefix = Object.entries(env)
    .map(([key, value]) => `${key}=${shellEscape(String(value))}`)
    .join(' ')
  return prefix ? `env ${prefix} ${baseCmd}` : baseCmd
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function hasClaudeMcp(_agentId: string, cwd?: string): boolean {
  if (!cwd) return false
  const configPath = join(cwd, '.mcp.json')
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    return Boolean(config?.mcpServers?.['kitty-talk'])
  } catch {
    return false
  }
}

function hasCodexMcp(cwd?: string, tmuxName?: string): boolean {
  if (!cwd) return false
  const projectCwd = resolveCodexProjectCwd(cwd, tmuxName)
  const configPath = getCodexProjectConfigPath(projectCwd)
  try {
    const content = readFileSync(configPath, 'utf-8')
    const serverName = CODEX_SERVER_NAME
    const tablePath = getCodexServerTablePath(serverName)
    return hasTomlTable(content, tablePath)
  } catch {
    return false
  }
}

function resolveNodePath(): string {
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  try {
    const fromPath = execSync('command -v node', { encoding: 'utf-8' }).trim()
    if (fromPath) return fromPath
  } catch {
    // Ignore and throw below with actionable guidance.
  }
  throw new Error('无法找到 Node.js 可执行文件。请确认已安装 node 且可通过绝对路径访问。')
}

function getCodexServerTablePath(serverName: string): string {
  // Quote dynamic segment to safely support '-' and other special chars.
  return `mcp_servers.${tomlQuotedKey(serverName)}`
}

function tomlQuotedKey(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function hasTomlTable(content: string, tablePath: string): boolean {
  const wanted = canonicalTablePath(tablePath)
  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const current = parseTomlTableHeader(line)
    if (!current) continue
    if (current === wanted) return true
  }
  return false
}

function removeTomlTable(content: string, tablePath: string): string {
  const wanted = canonicalTablePath(tablePath)
  const lines = content.split(/\r?\n/)
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    const current = parseTomlTableHeader(line)
    if (current) {
      skipping = current === wanted
      if (!skipping) out.push(line)
      continue
    }
    if (!skipping) out.push(line)
  }
  return out.join('\n')
}

function listTomlTables(content: string): string[] {
  const lines = content.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    const table = parseTomlTableHeader(line)
    if (table) out.push(table)
  }
  return out
}

function removeCodexLegacySessionTables(content: string): string {
  let next = content
  for (const table of listTomlTables(content)) {
    if (!table.startsWith('mcp_servers.kitty-talk-') && table !== 'mcp_servers.kitty-mcp' && !table.startsWith('mcp_servers.kitty-mcp.')) continue
    next = removeTomlTable(next, table)
  }
  return next
}

function cleanupCodexGlobalLegacyTables(): void {
  const globalPath = join(homedir(), '.codex', 'config.toml')
  let content = ''
  try { content = readFileSync(globalPath, 'utf-8') } catch { return }
  const next = removeCodexLegacySessionTables(content)
  if (next === content) return
  writeFileSync(globalPath, `${next.trimEnd()}\n`)
}

function cleanupCodexLegacySessionProjectConfigs(): void {
  const sessionsRoot = join(homedir(), '.kitty-kitty', 'sessions')
  let entries: string[] = []
  try { entries = readdirSync(sessionsRoot) } catch { return }
  for (const dir of entries) {
    const configPath = join(sessionsRoot, dir, '.codex', 'config.toml')
    let content = ''
    try { content = readFileSync(configPath, 'utf-8') } catch { continue }
    const next = removeCodexLegacySessionTables(content)
    if (next === content) continue
    try {
      writeFileSync(configPath, `${next.trimEnd()}\n`)
    } catch { /* ignore */ }
  }
}

function parseTomlTableHeader(line: string): string | null {
  const match = line.match(/^\s*\[(.+?)\]\s*$/)
  if (!match) return null
  return canonicalTablePath(match[1])
}

function canonicalTablePath(value: string): string {
  return splitTomlPath(value).join('.')
}

function splitTomlPath(value: string): string[] {
  const parts: string[] = []
  let current = ''
  let inQuote = false
  let escaped = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (inQuote) {
      if (escaped) {
        current += ch
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inQuote = false
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"') {
      inQuote = true
      continue
    }
    if (ch === '.') {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current.trim())
  return parts.filter(Boolean)
}
