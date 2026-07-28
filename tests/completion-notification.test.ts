import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  CODEX_TURN_COMPLETED_EVENT,
  COMPLETION_NOTIFICATION,
  getCompletionNotificationWindowBounds,
} from '../src/shared/completion-notification.ts'

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('completion notification window stays top-centered inside the active display work area', () => {
  assert.deepEqual(
    getCompletionNotificationWindowBounds({ x: 1440, y: 25, width: 1920, height: 1055 }),
    {
      x: 2220,
      y: 43,
      width: COMPLETION_NOTIFICATION.WINDOW_WIDTH,
      height: COMPLETION_NOTIFICATION.WINDOW_HEIGHT,
    },
  )
})

test('codex turn completion is routed to a transient notification instead of needs-input state', async () => {
  const [wakeup, notifications, renderer] = await Promise.all([
    source('src/main/wakeup.ts'),
    source('src/main/windows/completion-notification-window.ts'),
    source('src/renderer/completion/CompletionNotifications.tsx'),
  ])

  assert.equal(CODEX_TURN_COMPLETED_EVENT, 'codex_turn_completed')
  assert.match(wakeup, /payload\?\.notification_type/)
  assert.match(wakeup, /notificationType === CODEX_TURN_COMPLETED_EVENT/)
  assert.doesNotMatch(wakeup, /hookEvent === CODEX_TURN_COMPLETED_EVENT/)
  assert.match(wakeup, /showCompletionNotification\(row\.id, row\.title\)/)
  assert.match(notifications, /showInactive\(\)/)
  assert.match(renderer, /COMPLETION_NOTIFICATION\.MAX_VISIBLE/)
  assert.match(renderer, /className="completion-notification-ignore"/)
  assert.match(renderer, /window\.api\.invoke\('session:attach', notification\.sessionId\)/)
  assert.doesNotMatch(renderer, /LIFE_MS|remainingRef|自动消失/)
  assert.doesNotMatch([wakeup, notifications, renderer].join('\n'), /session:needs-input/)
})
