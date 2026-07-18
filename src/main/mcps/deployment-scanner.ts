import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { parseCodexMcpToml, parseJsonc } from './config-converters.ts'

function readClaudeMcpNames(cwd: string): string[] {
  const file = join(cwd, '.mcp.json')
  if (!existsSync(file)) return []
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'))
    return Object.keys(data?.mcpServers || {})
  } catch { return [] }
}

function readCodexMcpNames(cwd: string): string[] {
  const file = join(cwd, '.codex', 'config.toml')
  if (!existsSync(file)) return []
  try {
    return Object.keys(parseCodexMcpToml(readFileSync(file, 'utf-8')))
  } catch { return [] }
}

export function readOpenCodeMcpNames(cwd: string): string[] {
  for (const filename of ['opencode.json', 'opencode.jsonc']) {
    const file = join(cwd, filename)
    if (!existsSync(file)) continue
    try {
      const data = parseJsonc(readFileSync(file, 'utf-8'))
      return Object.keys(data?.mcp || {})
    } catch { /* try the other supported filename */ }
  }
  return []
}

/** Return the union used when copying MCPs during a tool switch. */
export function listDeployed(cwd: string): string[] {
  if (!cwd) return []
  return [...new Set([
    ...readClaudeMcpNames(cwd),
    ...readCodexMcpNames(cwd),
    ...readOpenCodeMcpNames(cwd),
  ])].sort()
}

/** Return only the MCPs actually deployed for the selected session tool. */
export function listDeployedForTool(cwd: string, tool: string): string[] {
  if (!cwd) return []
  if (tool === 'codex') return readCodexMcpNames(cwd).sort()
  if (tool === 'opencode') return readOpenCodeMcpNames(cwd).sort()
  return readClaudeMcpNames(cwd).sort()
}

export function readConfiguredServers(cwd: string): Record<string, Record<string, any>> {
  const servers: Record<string, Record<string, any>> = {}
  const claudeFile = join(cwd, '.mcp.json')
  if (existsSync(claudeFile)) {
    try {
      const data = JSON.parse(readFileSync(claudeFile, 'utf-8'))
      for (const [name, cfg] of Object.entries(data?.mcpServers || {})) {
        if (cfg && typeof cfg === 'object') servers[name] = cfg as Record<string, any>
      }
    } catch { /* continue with other tool configs */ }
  }
  for (const filename of ['opencode.json', 'opencode.jsonc']) {
    const file = join(cwd, filename)
    if (!existsSync(file)) continue
    try {
      const data = parseJsonc(readFileSync(file, 'utf-8'))
      for (const [name, cfg] of Object.entries(data?.mcp || {})) {
        if (!(name in servers) && cfg && typeof cfg === 'object') servers[name] = cfg as Record<string, any>
      }
      break
    } catch { /* continue with the other supported filename */ }
  }
  const codexFile = join(cwd, '.codex', 'config.toml')
  if (existsSync(codexFile)) {
    try {
      const parsed = parseCodexMcpToml(readFileSync(codexFile, 'utf-8'))
      for (const [name, cfg] of Object.entries(parsed)) {
        if (!(name in servers)) servers[name] = cfg
      }
    } catch { /* ignore invalid TOML subset */ }
  }
  return servers
}
