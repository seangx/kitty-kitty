import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildOpenCodePlugin } from '../src/main/opencode-plugin-template.ts'

test('OpenCode plugin bridges memory, session ids, and input notifications', async (t) => {
  const plugin = buildOpenCodePlugin('/tmp/kitty test/wakeup.sock')
  const dir = mkdtempSync(join(tmpdir(), 'kitty-opencode-plugin-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'kitty-kitty.mjs')
  writeFileSync(file, plugin)
  execFileSync(process.execPath, ['--check', file])

  const memoryFile = join(dir, 'MEMORY.md')
  writeFileSync(memoryFile, '# Repository memory\n- keep MCP configs aligned\n')
  const previousMemory = process.env.KITTY_CLAUDE_MEMORY_FILE
  process.env.KITTY_CLAUDE_MEMORY_FILE = memoryFile
  t.after(() => {
    if (previousMemory === undefined) delete process.env.KITTY_CLAUDE_MEMORY_FILE
    else process.env.KITTY_CLAUDE_MEMORY_FILE = previousMemory
  })
  const module = await import(`${pathToFileURL(file).href}?test=${Date.now()}`)
  const hooks = await module.KittyKittyPlugin()
  const output = { system: [] as string[] }
  await hooks['experimental.chat.system.transform']({}, output)
  assert.equal(output.system.length, 1)
  assert.ok(output.system[0].includes('# Repository memory'))

  assert.ok(plugin.includes(`const SOCKET_PATH = "/tmp/kitty test/wakeup.sock"`))
  assert.ok(plugin.includes('experimental.chat.system.transform'))
  assert.ok(plugin.includes('KITTY_CLAUDE_MEMORY_FILE'))
  assert.ok(plugin.includes("event?.properties?.sessionID || event?.properties?.info?.id"))
  assert.ok(plugin.includes("event.type === 'session.idle'"))
  assert.ok(plugin.includes("event.type === 'permission.asked'"))
  assert.ok(plugin.includes("event.type === 'question.asked'"))
  assert.ok(plugin.includes("'X-Kitty-Session': kittyId"))
})
