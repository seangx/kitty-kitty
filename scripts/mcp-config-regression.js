#!/usr/bin/env node

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function splitTomlPath(value) {
  const parts = []
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
      if (current.trim()) parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function canonicalTablePath(value) {
  return splitTomlPath(value).join('.')
}

function parseTomlTableHeader(line) {
  const match = line.match(/^\s*\[(.+?)\]\s*$/)
  if (!match) return null
  return canonicalTablePath(match[1])
}

function removeTomlTable(content, tablePath) {
  const wanted = canonicalTablePath(tablePath)
  const lines = content.split(/\r?\n/)
  const out = []
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

function listTomlTables(content) {
  const out = []
  for (const line of content.split(/\r?\n/)) {
    const table = parseTomlTableHeader(line)
    if (table) out.push(table)
  }
  return out
}

function removeCodexLegacySessionTables(content) {
  let next = content
  for (const table of listTomlTables(content)) {
    if (!table.startsWith('mcp_servers.kitty-talk-') && table !== 'mcp_servers.kitty-mcp' && !table.startsWith('mcp_servers.kitty-mcp.')) continue
    next = removeTomlTable(next, table)
  }
  return next
}

function upsertKittyMcp(content, nodePath, proxyPath, scriptPath, busDir) {
  const tablePath = 'mcp_servers.kitty-mcp'
  const envTablePath = `${tablePath}.env`
  const cleaned = removeTomlTable(
    removeTomlTable(
      removeCodexLegacySessionTables(content),
      tablePath
    ),
    envTablePath
  ).trimEnd()
  const lines = [
    '[mcp_servers."kitty-mcp"]',
    `command = ${JSON.stringify(nodePath)}`,
    `args = [${JSON.stringify(proxyPath)}, ${JSON.stringify(scriptPath)}]`,
    '',
    '[mcp_servers."kitty-mcp".env]',
    `KITTY_BUS_DIR = ${JSON.stringify(busDir)}`,
  ]
  return `${cleaned}${cleaned ? '\n\n' : ''}${lines.join('\n')}\n`
}

function removeKittyMcp(content) {
  const tablePath = 'mcp_servers.kitty-mcp'
  const envTablePath = `${tablePath}.env`
  return `${removeTomlTable(removeTomlTable(removeCodexLegacySessionTables(content), tablePath), envTablePath).trimEnd()}\n`
}

function countOccurrences(haystack, needle) {
  return (haystack.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
}

function main() {
  const seed = [
    '[mcp_servers.pencil]',
    'command = "/Applications/Pencil.app/..."',
    '',
    '[mcp_servers."kitty-talk-abc123"]',
    'command = "/opt/homebrew/bin/node"',
    '',
    '[mcp_servers."kitty-mcp"]',
    'command = "/opt/homebrew/bin/node"',
    'args = ["/tmp/old-proxy.js", "/tmp/old-server.js"]',
    '',
    '[mcp_servers."kitty-mcp".env]',
    'KITTY_BUS_DIR = "/tmp/old-bus"',
    '',
  ].join('\n')

  const inserted = upsertKittyMcp(seed, '/opt/homebrew/bin/node', '/tmp/new-proxy.js', '/tmp/new-server.js', '/tmp/new-bus')
  assert(inserted.includes('[mcp_servers.pencil]'), 'should preserve unrelated mcp server table')
  assert(!inserted.includes('kitty-talk-abc123'), 'should remove legacy kitty-talk-* tables')
  assert(countOccurrences(inserted, '[mcp_servers."kitty-mcp"]') === 1, 'should contain exactly one kitty-mcp table')
  assert(inserted.includes('/tmp/new-proxy.js'), 'should write new proxy path')
  assert(inserted.includes('/tmp/new-server.js'), 'should write new server path')
  assert(inserted.includes('KITTY_BUS_DIR = "/tmp/new-bus"'), 'should write new bus dir')

  const removed = removeKittyMcp(inserted)
  assert(removed.includes('[mcp_servers.pencil]'), 'remove should preserve unrelated table')
  assert(!removed.includes('kitty-mcp'), 'remove should delete kitty-mcp table and env table')

  console.log('MCP_CONFIG_REGRESSION_OK')
}

main()
