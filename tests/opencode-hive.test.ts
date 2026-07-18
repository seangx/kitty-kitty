import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureOpenCodeHiveMcp } from '../src/main/opencode-hive.ts'

test('configures the OpenCode Hive MCP through the installed Hive CLI', () => {
  let command = ''
  let args: string[] = []
  let options: any
  const result = ensureOpenCodeHiveMcp({
    port: 4312,
    run: ((nextCommand: string, nextArgs: string[], nextOptions: any) => {
      command = nextCommand
      args = nextArgs
      options = nextOptions
      return ''
    }) as any,
  })

  assert.deepEqual(result, { success: true })
  assert.equal(command, 'kitty-hive')
  assert.deepEqual(args, ['init', 'opencode', '--port', '4312'])
  assert.match(options.env.PATH, /^\/opt\/homebrew\/bin:\/usr\/local\/bin:/)
  assert.equal(options.timeout, 5000)
})

test('keeps Kitty startup optional when Hive is unavailable', () => {
  const result = ensureOpenCodeHiveMcp({
    run: (() => { throw new Error('ENOENT kitty-hive') }) as any,
  })

  assert.equal(result.success, false)
  assert.match(result.error || '', /ENOENT kitty-hive/)
})
