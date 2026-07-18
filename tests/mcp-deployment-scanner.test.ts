import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { listDeployed, listDeployedForTool } from '../src/main/mcps/deployment-scanner.ts'

test('reports deployed MCPs for the current tool instead of merging agent configs', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kitty-mcp-scan-'))
  try {
    mkdirSync(join(cwd, '.codex'), { recursive: true })
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
      mcpServers: { 'claude-only': { command: 'node', args: ['claude.js'] } },
    }))
    writeFileSync(join(cwd, '.codex', 'config.toml'), `
[mcp_servers."codex-only"]
command = "node"
args = ["codex.js"]
`)
    writeFileSync(join(cwd, 'opencode.jsonc'), `{
      // OpenCode project MCPs
      "mcp": { "opencode-only": { "type": "local", "command": ["node", "open.js"] } }
    }`)

    assert.deepEqual(listDeployedForTool(cwd, 'claude'), ['claude-only'])
    assert.deepEqual(listDeployedForTool(cwd, 'codex'), ['codex-only'])
    assert.deepEqual(listDeployedForTool(cwd, 'opencode'), ['opencode-only'])
    assert.deepEqual(listDeployed(cwd), ['claude-only', 'codex-only', 'opencode-only'])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
