import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('electron package excludes local git worktrees', async () => {
  const config = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  assert.match(config, /^\s*-\s+['"]?!\*\*\/\.worktrees\/\*\*['"]?\s*$/m)
})

test('local macOS pack receives a complete ad-hoc signature', async () => {
  const [packageJson, signer] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../tools/adhoc-sign-macos-app.sh', import.meta.url), 'utf8'),
  ])

  const scripts = JSON.parse(packageJson).scripts as Record<string, string>
  assert.match(scripts.pack, /electron-builder --dir && bash tools\/adhoc-sign-macos-app\.sh/)
  assert.match(signer, /codesign --force --deep --sign -/)
  assert.match(signer, /codesign --verify --deep --strict/)
})
