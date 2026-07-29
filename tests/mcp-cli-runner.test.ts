import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  cliFailureMessage,
  findReportedDeployments,
  findRequiredEnvPrompts,
  findSavedServers,
  runCli,
} from '../src/main/mcps/cli-runner.ts'
import { listCentralFromFs, missingCentralDefinitionPath, readCentralConfigFromFs } from '../src/main/mcps/central-repository.ts'

test('supplies an authorized answer to a headless CLI prompt through stdin', async () => {
  const script = `
    let answer = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { answer += chunk })
    process.stdin.on('end', () => {
      if (answer.trim() === 'y') console.log('accepted')
      else { console.error('missing answer'); process.exitCode = 1 }
    })
  `

  const result = await runCli(process.execPath, ['-e', script], { input: 'y\n', timeoutMs: 2_000 })

  assert.equal(result.success, true)
  assert.equal(result.stdout.trim(), 'accepted')
})

test('closes stdin when no answer is required so a child cannot wait forever', async () => {
  const script = `
    process.stdin.resume()
    process.stdin.on('end', () => console.log('stdin closed'))
  `

  const result = await runCli(process.execPath, ['-e', script], { timeoutMs: 2_000 })

  assert.equal(result.success, true)
  assert.equal(result.stdout.trim(), 'stdin closed')
})

test('shows actionable CLI output instead of the generic execFile error', () => {
  assert.equal(cliFailureMessage({
    success: false,
    stdout: '\u001b[31mREADME analysis failed\u001b[0m\n',
    stderr: '',
    errorMessage: 'Command failed: mcpsmgr add example/repo',
  }, '部署失败'), 'README analysis failed')
})

test('extracts follow-up env prompts and actual agent deployments', () => {
  const output = `
    ? Enter value for API_KEY (stored locally, never sent to servers):
    ? Enter value for API_KEY (stored locally, never sent to servers):
      + chrome-devtools -> central repository
      + chrome-devtools -> Codex
    Server "chrome-devtools" saved to central repository.
  `

  assert.deepEqual(findRequiredEnvPrompts(output), ['API_KEY'])
  assert.deepEqual(findReportedDeployments(output), ['chrome-devtools'])
  assert.deepEqual(findSavedServers(output), ['chrome-devtools'])
})

test('repairs and scans scoped MCP central definitions safely', () => {
  const central = mkdtempSync(join(tmpdir(), 'kitty-mcps-central-'))
  try {
    const nested = join(central, '@upstash', 'context7.json')
    const result = {
      success: false,
      stdout: '',
      stderr: `Error: ENOENT: no such file or directory, open '${nested}'`,
    }
    assert.equal(missingCentralDefinitionPath(result, central), nested)
    assert.equal(missingCentralDefinitionPath({
      ...result,
      stderr: "Error: ENOENT: no such file or directory, open '/tmp/outside.json'",
    }, central), null)

    mkdirSync(join(central, '@upstash'), { recursive: true })
    writeFileSync(nested, JSON.stringify({
      name: '@upstash/context7',
      description: 'Context7 MCP',
      source: 'https://github.com/upstash/context7',
      default: { transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7'], env: {} },
      overrides: { codex: { args: ['@upstash/context7@latest'] } },
    }))
    assert.deepEqual(listCentralFromFs(central), [{
      name: '@upstash/context7',
      description: 'Context7 MCP',
      source: 'central',
    }])
    assert.deepEqual(readCentralConfigFromFs(central, '@upstash/context7'), {
      transport: 'stdio',
      command: 'npx',
      args: ['@upstash/context7@latest'],
      env: {},
    })
    assert.equal(readCentralConfigFromFs(central, '../../outside'), null)
  } finally {
    rmSync(central, { recursive: true, force: true })
  }
})

test('project deployment reuses a trusted scoped central definition before invoking mcpsmgr', () => {
  const source = readFileSync(new URL('../src/main/mcps/mcps-manager.ts', import.meta.url), 'utf8')
  const start = source.indexOf('export async function addMcp')
  const end = source.indexOf('export async function removeMcp', start)
  const block = source.slice(start, end)

  assert.ok(start >= 0)
  assert.ok(end > start)
  assert.match(block, /readCentralConfigFromFs\(CENTRAL_DIR, safe, agent\)/)
  assert.match(block, /tool === 'opencode'[\s\S]*?writeOpenCodeMcp/)
  assert.match(block, /tool === 'codex'[\s\S]*?writeTomlMcp/)
  assert.match(block, /else writeJsonMcp/)
  assert.match(block, /listDeployedForTool\(cwd, tool\)\.includes\(safe\)/)
  assert.ok(block.indexOf('readCentralConfigFromFs') < block.indexOf('runMcpsMgrWithScopedRetry'))
})
