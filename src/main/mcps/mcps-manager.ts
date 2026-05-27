/**
 * MCPs Manager — bridges mcpsmgr CLI (https://github.com/jtianling/mcps-manager) into kitty-kitty.
 *
 * Mirrors the skills-manager design. mcpsmgr does not yet expose --json on
 * every subcommand, so all parsers are best-effort text scanners isolated as
 * helper functions, easy to swap out once mcpsmgr ships structured output.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { log } from '../logger'
import type { McpServerInfo } from '@shared/types/mcps'

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

interface CliResult {
  success: boolean
  stdout: string
  stderr: string
}

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

async function runMcpsMgr(args: string[], cwd?: string): Promise<CliResult> {
  const bin = await resolveMcpsMgr()
  if (!bin) {
    return { success: false, stdout: '', stderr: 'mcpsmgr 未安装。请运行: npm install -g mcpsmgr' }
  }
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd,
      encoding: 'utf-8',
      timeout: 60_000,
    })
    log('mcps', `ok: mcpsmgr ${args.join(' ')}`)
    return { success: true, stdout: stdout || '', stderr: stderr || '' }
  } catch (err: any) {
    const stdout = String(err?.stdout || '')
    const stderr = String(err?.stderr || err?.message || 'Unknown error')
    log('mcps', `fail: mcpsmgr ${args.join(' ')} → ${stderr.slice(0, 200)}`)
    return { success: false, stdout, stderr }
  }
}

// ─── Central repository scanner ─────────────────────────

const CENTRAL_DIR = join(homedir(), '.mcps-manager', 'servers')

/**
 * mcpsmgr stores each installed MCP server as a subdirectory under
 * ~/.mcps-manager/servers/<name>/. Each may contain a `mcpsmgr.json` or
 * README we can sniff for a short description. We scan the FS directly rather
 * than rely on `mcpsmgr list` because the CLI's text output format is
 * version-sensitive and harder to parse robustly.
 */
function listCentralFromFs(): McpServerInfo[] {
  if (!existsSync(CENTRAL_DIR)) return []
  let entries: string[] = []
  try { entries = readdirSync(CENTRAL_DIR) } catch { return [] }
  const out: McpServerInfo[] = []
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const p = join(CENTRAL_DIR, name)
    try {
      if (!statSync(p).isDirectory()) continue
    } catch { continue }
    let description: string | undefined
    const manifestPath = join(p, 'mcpsmgr.json')
    if (existsSync(manifestPath)) {
      try {
        const json = JSON.parse(readFileSync(manifestPath, 'utf-8'))
        if (typeof json?.description === 'string') description = json.description.slice(0, 160)
      } catch { /* ignore */ }
    }
    out.push({ name, description, source: 'central' })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ─── Deployed scanner (per-project) ─────────────────────

const TOOL_AGENT_MAP: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex',
  shell: 'claude-code',
}

/**
 * Best-effort "what MCP servers are wired up in this project?" lookup.
 *
 * mcpsmgr writes to multiple per-agent config files (.mcp.json /
 * .codex/config.toml / .cursor/mcp.json / etc.). We only need the union of
 * server names to drive the panel's deployed-marker, so we read the two main
 * formats kitty-kitty cares about (claude-code .mcp.json and codex
 * .codex/config.toml) and merge them. If neither exists we fall back to a
 * mcpsmgr CLI call.
 */
export async function listDeployed(cwd: string): Promise<string[]> {
  if (!cwd) return []
  const names = new Set<string>()

  const mcpJson = join(cwd, '.mcp.json')
  if (existsSync(mcpJson)) {
    try {
      const data = JSON.parse(readFileSync(mcpJson, 'utf-8'))
      for (const k of Object.keys(data?.mcpServers || {})) names.add(k)
    } catch { /* ignore */ }
  }

  const codexToml = join(cwd, '.codex', 'config.toml')
  if (existsSync(codexToml)) {
    try {
      const text = readFileSync(codexToml, 'utf-8')
      // Match `[mcp_servers.<name>]` / `[mcp_servers."<name>"]`
      const re = /^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_.-]+))\]/gm
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const name = m[1] ?? m[2]
        if (name) names.add(name)
      }
    } catch { /* ignore */ }
  }

  return [...names].sort()
}

// ─── Operations (all async) ─────────────────────────────

export async function listMcps(cwd?: string): Promise<{ central: McpServerInfo[]; deployed: string[] }> {
  const central = listCentralFromFs()
  const deployed = cwd ? await listDeployed(cwd) : []
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
  const result = await runMcpsMgr(['add', safe, '-a', agent, '-y'], cwd)
  if (result.success) {
    return { success: true, message: `${safe} 已部署到 ${agent}` }
  }
  return { success: false, message: result.stderr.trim() || result.stdout.trim() || '部署失败' }
}

export async function removeMcp(cwd: string, name: string): Promise<{ success: boolean; message: string }> {
  const safe = validateName(name)
  const result = await runMcpsMgr(['remove', safe], cwd)
  if (result.success) {
    return { success: true, message: `${safe} 已从项目移除` }
  }
  return { success: false, message: result.stderr.trim() || result.stdout.trim() || '移除失败' }
}

/** `install` — pull source into the central repository WITHOUT deploying. */
export async function installMcp(source: string): Promise<{ success: boolean; message: string }> {
  const safe = validateName(source)
  const result = await runMcpsMgr(['install', safe, '-y'])
  if (result.success) {
    return { success: true, message: `${safe} 已入仓` }
  }
  return { success: false, message: result.stderr.trim() || result.stdout.trim() || '安装失败' }
}

export async function uninstallMcp(name: string): Promise<{ success: boolean; message: string }> {
  const safe = validateName(name)
  const result = await runMcpsMgr(['uninstall', safe])
  if (result.success) {
    return { success: true, message: `${safe} 已从中央仓库移除` }
  }
  return { success: false, message: result.stderr.trim() || result.stdout.trim() || '卸载失败' }
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
    existing.mcpServers[name] = cfg
    added.push(name)
  }
  ensureDir(file)
  writeFileSync(file, JSON.stringify(existing, null, 2) + '\n')
  return added
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
  const lines: string[] = [`[mcp_servers.${name}]`]
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
    lines.push(`[mcp_servers.${name}.${k}]`)
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
  const headerRe = new RegExp(`^\\[mcp_servers\\.${escapedName}(?:\\.[A-Za-z0-9_-]+)?\\]\\s*$`)
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
    text += renderTomlSection(name, cfg as Record<string, any>)
    added.push(name)
  }
  ensureDir(file)
  writeFileSync(file, text)
  return added
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
    const useToml = tool === 'codex'
    const added = useToml ? writeTomlMcp(cwd, servers) : writeJsonMcp(cwd, servers)
    const target = useToml ? '.codex/config.toml' : '.mcp.json'
    log('mcps', `manual write → ${target}: ${added.join(', ')}`)
    return { success: true, message: `已写入 ${target}: ${added.join(', ')}` }
  } catch (err: any) {
    return { success: false, message: err?.message || '写入失败' }
  }
}
