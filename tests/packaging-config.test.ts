import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('electron package excludes local git worktrees', async () => {
  const config = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  assert.match(config, /^\s*-\s+['"]?!\*\*\/\.worktrees\/\*\*['"]?\s*$/m)
})
