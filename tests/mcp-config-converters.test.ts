import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseCodexMcpToml,
  parseJsonc,
  toClaudeMcp,
  toCodexMcp,
  toOpenCodeMcp,
} from '../src/main/mcps/config-converters.ts'

test('converts an OpenCode local MCP into Claude and Codex native formats', () => {
  const source = {
    type: 'local',
    command: ['npx', '-y', '@example/server'],
    environment: { API_KEY: 'secret' },
  }

  assert.deepEqual(toClaudeMcp(source), {
    command: 'env',
    args: ['API_KEY=secret', 'npx', '-y', '@example/server'],
  })
  assert.deepEqual(toCodexMcp(source), {
    command: 'npx',
    args: ['-y', '@example/server'],
    env: { API_KEY: 'secret' },
  })
})

test('parses quoted Codex MCP sections and nested env/header tables', () => {
  const parsed = parseCodexMcpToml(`
model = "gpt-5"

[mcp_servers."local.tools"]
command = "node"
args = ["server.js", "--quiet"]

[mcp_servers."local.tools".env]
TOKEN = "abc"

[mcp_servers.remote]
type = "streamable-http"
url = "https://mcp.example.com"

[mcp_servers.remote.http_headers]
Authorization = "Bearer token"
`)

  assert.deepEqual(parsed, {
    'local.tools': {
      command: 'node',
      args: ['server.js', '--quiet'],
      env: { TOKEN: 'abc' },
    },
    remote: {
      type: 'streamable-http',
      url: 'https://mcp.example.com',
      http_headers: { Authorization: 'Bearer token' },
    },
  })
})

test('converts Claude stdio and Codex remote MCPs into OpenCode format', () => {
  assert.deepEqual(toOpenCodeMcp({
    command: 'env',
    args: ['TOKEN=abc', 'node', 'server.js'],
  }), {
    type: 'local',
    command: ['node', 'server.js'],
    environment: { TOKEN: 'abc' },
  })

  assert.deepEqual(toOpenCodeMcp({
    type: 'streamable-http',
    url: 'https://mcp.example.com',
    http_headers: { Authorization: 'Bearer token' },
  }), {
    type: 'remote',
    url: 'https://mcp.example.com',
    headers: { Authorization: 'Bearer token' },
  })
})

test('parses OpenCode JSONC without stripping comment-like text in strings', () => {
  assert.deepEqual(parseJsonc(`{
    // project MCPs
    "url": "https://example.com/a//b",
    "literal": "x,}",
    "mcp": {
      "demo": { "type": "local", "command": ["node", "server.js"], },
    },
  }`), {
    url: 'https://example.com/a//b',
    literal: 'x,}',
    mcp: { demo: { type: 'local', command: ['node', 'server.js'] } },
  })
})
