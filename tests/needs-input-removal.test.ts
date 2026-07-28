import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('removed needs-input state no longer reaches main or renderer surfaces', async () => {
  const files = await Promise.all([
    source('src/main/wakeup.ts'),
    source('src/main/ipc/session-handlers.ts'),
    source('src/renderer/store/session-store.ts'),
    source('src/renderer/pet/PetCanvas.tsx'),
    source('src/renderer/pet/SessionDeck.tsx'),
    source('src/renderer/pet/SessionDeck.css'),
    source('src/renderer/pet/TagCloud.tsx'),
  ])
  const combined = files.join('\n')

  assert.doesNotMatch(combined, /session:needs-input/)
  assert.doesNotMatch(combined, /\bneedsInput\b/)
  assert.doesNotMatch(combined, /在等你喵/)
  assert.doesNotMatch(combined, /kitty-needs-input-pulse/)
  assert.doesNotMatch(combined, /session-deck__attention/)
})

test('session identity sync remains while legacy attention producers are removed', async () => {
  const hookInstaller = await source('src/main/hook-installer.ts')
  const openCodePlugin = await source('src/main/opencode-plugin-template.ts')

  assert.match(hookInstaller, /const SESSION_SYNC_EVENT = 'Stop'/)
  assert.match(hookInstaller, /removeTaggedHookForEvent\(settings, 'Notification'\)/)
  assert.match(openCodePlugin, /event\.type === 'session\.created' \|\| event\.type === 'session\.updated'/)
  assert.doesNotMatch(openCodePlugin, /event\.type === 'session\.idle'/)
  assert.doesNotMatch(openCodePlugin, /event\.type === 'permission\.asked'/)
  assert.doesNotMatch(openCodePlugin, /event\.type === 'question\.asked'/)
})
