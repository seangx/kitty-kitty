/**
 * MCPs Manager — bridges mcpsmgr CLI (https://github.com/jtianling/mcps-manager) into kitty-kitty.
 *
 * Mirrors the skills-manager design. mcpsmgr does not yet expose --json on
 * every subcommand, so all parsers are best-effort text scanners isolated as
 * helper functions, easy to swap out once mcpsmgr ships structured output.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { log } from '../logger'
import type { McpServerInfo } from '@shared/types/mcps'
import { parseCodexMcpToml, parseJsonc, toClaudeMcp, toCodexMcp, toOpenCodeMcp } from './config-converters'
import {
  cliFailureMessage,
  findReportedDeployments,
  findRequiredEnvPrompts,
  findSavedServers,
  runCli,
  type CliResult,
} from './cli-runner'
import { listDeployed, listDeployedForTool, readConfiguredServers } from './deployment-scanner'
import { listCentralFromFs as scanCentralFromFs, missingCentralDefinitionPath as findMissingCentralDefinitionPath } from './central-repository'

export { parseCodexMcpToml, parseJsonc, toClaudeMcp, toCodexMcp, toOpenCodeMcp } from './config-converters'

const execFileAsync = promisify(execFile)

const SAFE_NAME = /^[a-zA-Z0-9_@/.:-]+$/

function validateName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed || !SAFE_NAME.test(trimmed)) {
    throw new Error(`无效的 MCP server 名: ${trimmed}`)
  }
  return trimmed
}

// ─── CLI Runner ─────────────────────────────────────────

let mcpsMgrPath: string | null = null
let lastAvailableCheck = 0
const AVAILABLE_CHECK_TTL = 60_000

async function resolveMcpsMgr(): Promise<string | null> {
  if (mcpsMgrPath && Date.now() - lastAvailableCheck < AVAILABLE_CHECK_TTL) {
    return mcpsMgrPath
  }
  try {
    const { stdout } = await execFileAsync('which', ['mcpsmgr'], { encoding: 'utf-8' })
    mcpsMgrPath = stdout.trim() || null
  } catch {
    mcpsMgrPath = null
  }
  lastAvailableCheck = Date.now()
  return mcpsMgrPath
}

export async function isAvailable(): Promise<boolean> {
  return (await resolveMcpsMgr()) !== null
}

async function runMcpsMgr(args: string[], cwd?: string, input?: string): Promise<CliResult> {
  const bin = await resolveMcpsMgr()
  if (!bin) {
    return { success: false, stdout: '', stderr: 'mcpsmgr 未安装。请运行: npm install -g mcpsmgr' }
  }
  const result = await runCli(bin, args, { cwd, input })
  if (result.success) {
    log('mcps', `ok: mcpsmgr ${args.join(' ')}`)
  } else {
    log('mcps', `fail: mcpsmgr ${args.join(' ')} → ${cliFailureMessage(result, 'Unknown error').slice(0, 400)}`)
  }
  return result
}

// ─── Central repository scanner ─────────────────────────

const CENTRAL_DIR = join(homedir(), '.mcps-manager', 'servers')

/**
 * mcpsmgr <= 0.3 can infer scoped names (for example @upstash/context7) but
 * writes them as nested paths without creating the scope directory first.
 * Accept only a missing JSON path inside the central repository; never create
 * an arbitrary path copied from CLI output.
 */
async function runMcpsMgrWithScopedRetry(args: string[], cwd?: string, input?: string): Promise<CliResult> {
  let result = await runMcpsMgr(args, cwd, input)
  if (result.success) return result
  const missingPath = findMissingCentralDefinitionPath(result, CENTRAL_DIR)
  if (!missingPath) return result
  mkdirSync(dirname(missingPath), { recursive: true })
  log('mcps', `retry after creating scoped central directory: ${dirname(missingPath)}`)
  result = await runMcpsMgr(args, cwd, input)
  return result
}

/**
 * mcpsmgr 0.4 stores one JSON definition per server; older releases used one
 * directory per server. Support both layouts because the CLI's text output is
 * version-sensitive and harder to parse robustly.
 */
function listCentralFromFs(): McpServerInfo[] {
  return scanCentralFromFs(CENTRAL_DIR)
}

// ─── Deployed scanner (per-project) ─────────────────────

const TOOL_AGENT_MAP: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex',
  opencode: 'opencode',
  shell: 'claude-code',
}

/** Copy the project's existing MCP set into a newly selected tool. */
export async function syncManagedMcpsToTool(cwd: string, tool: string): Promise<void> {
  const agent = TOOL_AGENT_MAP[tool]
  if (!cwd || !agent || tool === 'shell') return
  const target = new Set(listDeployedForTool(cwd, tool))
  const central = new Set(listCentralFromFs().map((item) => item.name))
  const union = await listDeployed(cwd)
  const configured = readConfiguredServers(cwd)
  const direct: Record<string, Record<string, any>> = {}
  for (const name of union) {
    if (target.has(name)) continue
    if (central.has(name)) {
      const result = await runMcpsMgr(['add', name, '-a', agent, '-y'], cwd)
      if (result.success) {
        target.add(name)
        continue
      }
      log('mcps', `sync ${name} → ${agent} via mcpsmgr failed: ${(result.stderr || result.stdout).slice(0, 160)}`)
    }
    if (configured[name]) direct[name] = configured[name]
  }
  if (!Object.keys(direct).length) return
  if (tool === 'opencode') writeOpenCodeMcp(cwd, direct)
  else if (tool === 'codex') writeTomlMcp(cwd, direct)
  else writeJsonMcp(cwd, direct)
  log('mcps', `direct sync → ${agent}: ${Object.keys(direct).join(', ')}`)
}

// ─── Operations (all async) ─────────────────────────────

export async function listMcps(cwd?: string, tool?: string): Promise<{ central: McpServerInfo[]; deployed: string[] }> {
  const central = listCentralFromFs()
  const deployed = cwd ? (tool ? listDeployedForTool(cwd, tool) : listDeployed(cwd)) : []
  return { central, deployed }
}

/**
 * `add` — pull server into central repo (if needed) AND deploy to the
 * current project for the right agent. Mirrors how skills-manager treats
 * `add` as the user-facing "give me this".
 *
 * `source` may be a central-repo name, a GitHub owner/repo, or a full URL.
 */
export async function addMcp(cwd: string, source: string, tool: string): Promise<{ success: boolean; message: string }> {
  const safe = validateName(source)
  const agent = TOOL_AGENT_MAP[tool] || 'claude-code'
  const before = new Set(listDeployedForTool(cwd, tool))
  // mcpsmgr 0.4.10 still prompts to trust README-derived configs even with
  // `-y`. The Add button is the user's authorization, so answer only that
  // confirmation through stdin. Any further prompt is left unanswered and the
  // postcondition check below prevents a prompt-only exit from becoming a
  // false success.
  const result = await runMcpsMgrWithScopedRetry(['add', safe, '-a', agent, '-y'], cwd, 'y\n')
  const after = listDeployedForTool(cwd, tool)
  const reported = new Set(findReportedDeployments(`${result.stdout}\n${result.stderr}`))
  const deployedName = after.find((name) => !before.has(name))
    ?? after.find((name) => reported.has(name))
  if (deployedName) {
    return { success: true, message: `${deployedName} 已部署到 ${agent}` }
  }
  const requiredEnv = findRequiredEnvPrompts(`${result.stdout}\n${result.stderr}`)
  if (requiredEnv.length > 0) {
    return {
      success: false,
      message: `安装需要环境变量 ${requiredEnv.join(', ')}，尚未写入项目配置`,
    }
  }
  return { success: false, message: cliFailureMessage(result, '部署失败') }
}

export async function removeMcp(cwd: string, name: string): Promise<{ success: boolean; message: string }> {
  const safe = validateName(name)
  try {
    const removed = [
      removeJsonMcp(cwd, safe),
      removeTomlMcp(cwd, safe),
      removeOpenCodeMcp(cwd, safe),
    ].some(Boolean)
    return {
      success: true,
      message: removed ? `${safe} 已从三套项目配置移除` : `${safe} 未部署在项目中`,
    }
  } catch (err: any) {
    return { success: false, message: err?.message || '移除失败' }
  }
}

/** `install` — pull source into the central repository WITHOUT deploying. */
export async function installMcp(source: string): Promise<{ success: boolean; message: string }> {
  const safe = validateName(source)
  const before = new Set(listCentralFromFs().map((server) => server.name))
  // `install` has no -y flag in mcpsmgr 0.4.10, but uses the same README trust
  // prompt as `add`. Feed the explicit UI authorization through stdin.
  const result = await runMcpsMgrWithScopedRetry(['install', safe], undefined, 'y\n')
  const after = listCentralFromFs().map((server) => server.name)
  const reported = new Set(findSavedServers(`${result.stdout}\n${result.stderr}`))
  const installedName = after.find((name) => !before.has(name))
    ?? after.find((name) => reported.has(name))
  if (installedName) {
    return { success: true, message: `${installedName} 已入仓` }
  }
  const requiredEnv = findRequiredEnvPrompts(`${result.stdout}\n${result.stderr}`)
  if (requiredEnv.length > 0) {
    return {
      success: false,
      message: `安装需要环境变量 ${requiredEnv.join(', ')}，尚未写入中央仓库`,
    }
  }
  return { success: false, message: cliFailureMessage(result, '安装失败') }
}

export async function uninstallMcp(name: string): Promise<{ success: boolean; message: string }> {
  const safe = validateName(name)
  const result = await runMcpsMgr(['uninstall', safe])
  if (result.success) {
    return { success: true, message: `${safe} 已从中央仓库移除` }
  }
  return { success: false, message: cliFailureMessage(result, '卸载失败') }
}

// ─── Manual paste-JSON writer ───────────────────────────

/**
 * Accept either `{"name1": {...}, "name2": {...}}` (bare server map) or
 * `{"mcpServers": {"name1": {...}}}` (wrapped). Returns the bare map.
 */
function unwrapServers(raw: any): Record<string, any> {
  if (raw && typeof raw === 'object' && raw.mcpServers && typeof raw.mcpServers === 'object') {
    return raw.mcpServers
  }
  if (raw && typeof raw === 'object' && raw.mcp && typeof raw.mcp === 'object') {
    return raw.mcp
  }
  if (raw && typeof raw === 'object') return raw
  throw new Error('JSON 必须是 object')
}

function ensureDir(p: string): void {
  try { mkdirSync(dirname(p), { recursive: true }) } catch { /* ignore */ }
}

function writeJsonMcp(cwd: string, servers: Record<string, any>): string[] {
  const file = join(cwd, '.mcp.json')
  let existing: any = { mcpServers: {} }
  if (existsSync(file)) {
    try { existing = JSON.parse(readFileSync(file, 'utf-8')) } catch { /* keep default */ }
  }
  if (!existing.mcpServers || typeof existing.mcpServers !== 'object') existing.mcpServers = {}
  const added: string[] = []
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue
    existing.mcpServers[name] = toClaudeMcp(cfg as Record<string, any>)
    added.push(name)
  }
  ensureDir(file)
  writeFileSync(file, JSON.stringify(existing, null, 2) + '\n')
  return added
}

function removeJsonMcp(cwd: string, name: string): boolean {
  const file = join(cwd, '.mcp.json')
  if (!existsSync(file)) return false
  const data = JSON.parse(readFileSync(file, 'utf-8'))
  if (!data?.mcpServers || !Object.prototype.hasOwnProperty.call(data.mcpServers, name)) return false
  delete data.mcpServers[name]
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  return true
}

/**
 * Minimal JSON → TOML serializer for a single mcp_servers entry. Handles
 * strings, numbers, booleans, string arrays, and one level of nested objects
 * (rendered as a child `[mcp_servers.<name>.<sub>]` table — matches how Codex
 * expects `env` / `headers`). Anything more exotic gets JSON.stringified and
 * the user can hand-edit afterwards.
 */
function tomlEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function renderTomlValue(v: any): string {
  if (typeof v === 'string') return `"${tomlEscape(v)}"`
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    return `[${v.map(renderTomlValue).join(', ')}]`
  }
  return `"${tomlEscape(JSON.stringify(v))}"`
}

function renderTomlSection(name: string, cfg: Record<string, any>): string {
  const lines: string[] = [`[mcp_servers."${name}"]`]
  const subTables: Array<[string, Record<string, any>]> = []
  for (const [k, v] of Object.entries(cfg)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      subTables.push([k, v])
    } else {
      lines.push(`${k} = ${renderTomlValue(v)}`)
    }
  }
  for (const [k, sub] of subTables) {
    lines.push('')
    lines.push(`[mcp_servers."${name}".${k}]`)
    for (const [sk, sv] of Object.entries(sub)) {
      lines.push(`${sk} = ${renderTomlValue(sv)}`)
    }
  }
  return lines.join('\n') + '\n'
}

/**
 * Strip an existing `[mcp_servers.<name>]` block (and any nested
 * `[mcp_servers.<name>.<sub>]` tables) so we can re-append the new one. We
 * deliberately do a line-scan rather than full TOML parse — keeps the file
 * predictable for hand editing and avoids a toml dependency.
 */
function stripExistingTomlSection(text: string, name: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const headerRe = new RegExp(`^\\[mcp_servers\\.(?:"${escapedName}"|${escapedName})(?:\\.[A-Za-z0-9_-]+)?\\]\\s*$`)
  const anyHeaderRe = /^\[[^\]]+\]\s*$/
  let inSection = false
  for (const line of lines) {
    if (headerRe.test(line)) { inSection = true; continue }
    if (inSection && anyHeaderRe.test(line)) {
      inSection = false
      // fall through to push this header line below
    }
    if (!inSection) out.push(line)
  }
  return out.join('\n')
}

function writeTomlMcp(cwd: string, servers: Record<string, any>): string[] {
  const file = join(cwd, '.codex', 'config.toml')
  let text = ''
  if (existsSync(file)) {
    try { text = readFileSync(file, 'utf-8') } catch { /* keep empty */ }
  }
  const added: string[] = []
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue
    text = stripExistingTomlSection(text, name)
    if (text && !text.endsWith('\n')) text += '\n'
    if (text && !text.endsWith('\n\n')) text += '\n'
    text += renderTomlSection(name, toCodexMcp(cfg as Record<string, any>))
    added.push(name)
  }
  if (Object.values(servers).some((cfg) => cfg && typeof cfg === 'object' && toCodexMcp(cfg).url)) {
    if (!/^experimental_use_rmcp_client\s*=/m.test(text)) {
      text = `experimental_use_rmcp_client = true\n\n${text}`
    }
  }
  ensureDir(file)
  writeFileSync(file, text)
  return added
}

function removeTomlMcp(cwd: string, name: string): boolean {
  const file = join(cwd, '.codex', 'config.toml')
  if (!existsSync(file)) return false
  const text = readFileSync(file, 'utf-8')
  const next = stripExistingTomlSection(text, name)
  if (next === text) return false
  writeFileSync(file, next.replace(/^\s+|\s+$/g, '') + '\n')
  return true
}

function writeOpenCodeMcp(cwd: string, servers: Record<string, any>): string[] {
  const file = join(cwd, 'opencode.json')
  let data: any = {}
  if (existsSync(file)) {
    data = parseJsonc(readFileSync(file, 'utf-8'))
  }
  if (!data || typeof data !== 'object') data = {}
  if (!data.mcp || typeof data.mcp !== 'object') data.mcp = {}
  const added: string[] = []
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue
    data.mcp[name] = toOpenCodeMcp(cfg as Record<string, any>)
    added.push(name)
  }
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  return added
}

function removeOpenCodeMcp(cwd: string, name: string): boolean {
  for (const filename of ['opencode.json', 'opencode.jsonc']) {
    const file = join(cwd, filename)
    if (!existsSync(file)) continue
    let data: any
    try { data = parseJsonc(readFileSync(file, 'utf-8')) } catch { continue }
    if (!data?.mcp || !Object.prototype.hasOwnProperty.call(data.mcp, name)) continue
    delete data.mcp[name]
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
    return true
  }
  return false
}

export async function writeManualMcp(
  cwd: string,
  jsonText: string,
  tool: string,
): Promise<{ success: boolean; message: string }> {
  if (!cwd) return { success: false, message: '没有工作目录' }
  let parsed: any
  try { parsed = JSON.parse(jsonText) } catch (err: any) {
    return { success: false, message: `JSON 解析失败: ${err?.message || err}` }
  }
  let servers: Record<string, any>
  try { servers = unwrapServers(parsed) } catch (err: any) {
    return { success: false, message: err?.message || '格式错误' }
  }
  const names = Object.keys(servers)
  if (names.length === 0) return { success: false, message: '没有任何 server' }
  for (const name of names) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      return { success: false, message: `非法 server 名: ${name}` }
    }
  }
  try {
    // Manual entries are a deliberate user edit: keep all supported tools in
    // sync immediately so switching tools cannot silently lose an MCP.
    writeJsonMcp(cwd, servers)
    writeTomlMcp(cwd, servers)
    const added = writeOpenCodeMcp(cwd, servers)
    const target = '.mcp.json + .codex/config.toml + opencode.json'
    log('mcps', `manual sync → ${target}: ${added.join(', ')}`)
    return { success: true, message: `已同步 ${target}: ${added.join(', ')}` }
  } catch (err: any) {
    return { success: false, message: err?.message || '写入失败' }
  }
}
