import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  CODEX_TURN_COMPLETED_EVENT,
  COMPLETION_NOTIFICATION,
  getCompletionNotificationWindowBounds,
  upsertCompletionNotification,
} from '../src/shared/completion-notification.ts'
import {
  isPaneInForeground,
  parseForegroundPaneIds,
} from '../src/main/tmux/foreground-pane.ts'

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
  assert.match(wakeup, /isPaneForeground\(row\.paneId\)/)
  assert.match(wakeup, /showCompletionNotification\(row\.id, row\.title\)/)
  assert.match(notifications, /upsertCompletionNotification\(notifications/)
  assert.doesNotMatch(notifications, /notifications\.push\(/)
  assert.match(notifications, /showInactive\(\)/)
  assert.match(renderer, /COMPLETION_NOTIFICATION\.MAX_VISIBLE/)
  assert.match(renderer, /className="completion-notification-ignore"/)
  assert.match(renderer, /window\.api\.invoke\('session:attach', notification\.sessionId\)/)
  assert.doesNotMatch(renderer, /LIFE_MS|remainingRef|自动消失/)
  assert.doesNotMatch([wakeup, notifications, renderer].join('\n'), /session:needs-input/)
})

test('completion notifications are suppressed only for the pane shown by an attached client', () => {
  const clientPaneOutput = '%24\n%31\n'

  assert.deepEqual([...parseForegroundPaneIds(clientPaneOutput)], ['%24', '%31'])
  assert.equal(isPaneInForeground('%24', clientPaneOutput), true)
  assert.equal(isPaneInForeground('%25', clientPaneOutput), false)
})

test('missing or malformed pane state fails open so notifications are not lost', () => {
  assert.equal(isPaneInForeground('', '%24\n'), false)
  assert.equal(isPaneInForeground('%24', ''), false)
  assert.equal(isPaneInForeground('%24', 'no server running\n'), false)
  assert.deepEqual([...parseForegroundPaneIds('%24\nunexpected\n%31\n')], ['%24', '%31'])
})

test('the latest completion replaces an existing card for the same agent', () => {
  const existing = [
    { id: 'old-a', sessionId: 'agent-a', sessionName: 'Agent A', createdAt: 1 },
    { id: 'only-b', sessionId: 'agent-b', sessionName: 'Agent B', createdAt: 2 },
  ]
  const latest = {
    id: 'new-a',
    sessionId: 'agent-a',
    sessionName: 'Renamed Agent A',
    createdAt: 3,
  }

  const result = upsertCompletionNotification(existing, latest)

  assert.deepEqual(result, [latest, existing[1]])
  assert.deepEqual(existing.map((notification) => notification.id), ['old-a', 'only-b'])
})
