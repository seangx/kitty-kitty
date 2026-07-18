type CanonicalMcp =
  | {
      transport: 'stdio'
      command: string
      args: string[]
      env: Record<string, string>
      enabled?: boolean
      timeout?: number
    }
  | {
      transport: 'http'
      url: string
      headers: Record<string, string>
      bearerTokenEnvVar?: string
      enabled?: boolean
      timeout?: number
      oauth?: unknown
    }

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]))
}

function canonicalMcp(cfg: Record<string, any>): CanonicalMcp {
  const isRemote =
    cfg.transport === 'http' ||
    cfg.type === 'remote' ||
    cfg.type === 'http' ||
    cfg.type === 'sse' ||
    cfg.type === 'streamable-http' ||
    (cfg.url && !cfg.command)
  if (isRemote) {
    return {
      transport: 'http',
      url: String(cfg.url || ''),
      headers: stringRecord(cfg.headers || cfg.http_headers),
      ...(typeof cfg.bearerTokenEnvVar === 'string' ? { bearerTokenEnvVar: cfg.bearerTokenEnvVar } : {}),
      ...(typeof cfg.bearer_token_env_var === 'string' ? { bearerTokenEnvVar: cfg.bearer_token_env_var } : {}),
      ...(typeof cfg.enabled === 'boolean' ? { enabled: cfg.enabled } : {}),
      ...(typeof cfg.timeout === 'number' ? { timeout: cfg.timeout } : {}),
      ...(cfg.oauth !== undefined ? { oauth: cfg.oauth } : {}),
    }
  }

  const commandArray = Array.isArray(cfg.command) ? cfg.command.map(String) : null
  let command = commandArray ? commandArray[0] || '' : String(cfg.command || '')
  let args = commandArray ? commandArray.slice(1) : Array.isArray(cfg.args) ? cfg.args.map(String) : []
  const env = stringRecord(cfg.environment || cfg.env)

  // mcpsmgr represents env-bearing Claude/OpenCode commands through the
  // portable `env KEY=value ... command` form. Normalize it back first.
  if (command === 'env') {
    while (args.length > 0 && ENV_ASSIGNMENT.test(args[0])) {
      const assignment = args.shift()!
      const eq = assignment.indexOf('=')
      env[assignment.slice(0, eq)] = assignment.slice(eq + 1)
    }
    command = args.shift() || ''
  }

  return {
    transport: 'stdio',
    command,
    args,
    env,
    ...(typeof cfg.enabled === 'boolean' ? { enabled: cfg.enabled } : {}),
    ...(typeof cfg.timeout === 'number' ? { timeout: cfg.timeout } : {}),
  }
}

export function toClaudeMcp(cfg: Record<string, any>): Record<string, any> {
  const value = canonicalMcp(cfg)
  if (value.transport === 'http') {
    return {
      type: 'http',
      url: value.url,
      ...(Object.keys(value.headers).length ? { headers: value.headers } : {}),
    }
  }
  if (Object.keys(value.env).length) {
    return {
      command: 'env',
      args: [
        ...Object.entries(value.env).map(([key, item]) => `${key}=${item}`),
        value.command,
        ...value.args,
      ],
    }
  }
  return { command: value.command, args: value.args }
}

export function toCodexMcp(cfg: Record<string, any>): Record<string, any> {
  const value = canonicalMcp(cfg)
  if (value.transport === 'http') {
    return {
      type: 'streamable-http',
      url: value.url,
      ...(value.bearerTokenEnvVar ? { bearer_token_env_var: value.bearerTokenEnvVar } : {}),
      ...(Object.keys(value.headers).length ? { http_headers: value.headers } : {}),
    }
  }
  return {
    command: value.command,
    args: value.args,
    ...(Object.keys(value.env).length ? { env: value.env } : {}),
  }
}

export function toOpenCodeMcp(cfg: Record<string, any>): Record<string, any> {
  const value = canonicalMcp(cfg)
  if (value.transport === 'http') {
    return {
      type: 'remote',
      url: value.url,
      ...(Object.keys(value.headers).length ? { headers: value.headers } : {}),
      ...(value.oauth !== undefined ? { oauth: value.oauth } : {}),
      ...(typeof value.timeout === 'number' ? { timeout: value.timeout } : {}),
      ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    }
  }
  return {
    type: 'local',
    command: [value.command, ...value.args].filter(Boolean),
    ...(Object.keys(value.env).length ? { environment: value.env } : {}),
    ...(typeof value.timeout === 'number' ? { timeout: value.timeout } : {}),
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
  }
}

function parseTomlValue(raw: string): unknown {
  const value = raw.trim()
  if (value.startsWith('"') || value.startsWith('[')) {
    try { return JSON.parse(value) } catch { /* fall through */ }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  return value
}

/** Parse the MCP-only subset of Codex TOML without touching unrelated config. */
export function parseCodexMcpToml(text: string): Record<string, Record<string, any>> {
  const servers: Record<string, Record<string, any>> = {}
  let current: Record<string, any> | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    const header = line.match(/^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))(?:\.([A-Za-z0-9_-]+))?\]$/)
    if (header) {
      const name = header[1] || header[2]
      const root = servers[name] || (servers[name] = {})
      const child = header[3]
      current = child ? (root[child] ||= {}) : root
      continue
    }
    if (line.startsWith('[')) {
      current = null
      continue
    }
    if (!current || !line || line.startsWith('#')) continue
    const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/)
    if (assignment) current[assignment[1]] = parseTomlValue(assignment[2])
  }
  return servers
}

/** Parse JSONC comments/trailing commas while preserving string contents. */
export function parseJsonc(text: string): any {
  let clean = ''
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const next = text[i + 1]
    if (lineComment) {
      if (char === '\n') { lineComment = false; clean += char }
      continue
    }
    if (blockComment) {
    if (char === '*' && next === '/') { blockComment = false; i++ }
      else if (char === '\n') clean += char
      continue
    }
    if (inString) {
      clean += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; clean += char; continue }
    if (char === '/' && next === '/') { lineComment = true; i++; continue }
    if (char === '/' && next === '*') { blockComment = true; i++; continue }
    clean += char
  }
  let withoutTrailing = ''
  inString = false
  escaped = false
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i]
    if (inString) {
      withoutTrailing += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; withoutTrailing += char; continue }
    if (char === ',') {
      let nextIndex = i + 1
      while (/\s/.test(clean[nextIndex] || '')) nextIndex++
      if (clean[nextIndex] === '}' || clean[nextIndex] === ']') continue
    }
    withoutTrailing += char
  }
  return JSON.parse(withoutTrailing)
}
