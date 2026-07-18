import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cliFailureMessage,
  findReportedDeployments,
  findRequiredEnvPrompts,
  findSavedServers,
  runCli,
} from '../src/main/mcps/cli-runner.ts'

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
