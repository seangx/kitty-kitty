import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  CODEX_TURN_COMPLETED_EVENT,
  COMPLETION_NOTIFICATION,
  getCompletionNotificationWindowBounds,
  removeForegroundCompletionNotifications,
  upsertCompletionNotification,
} from '../src/shared/completion-notification.ts'
import {
  isGhosttyFrontmost,
  isPaneActuallyForeground,
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

test('completion notifications are suppressed only for the pane shown by foreground Ghostty', () => {
  const clientPaneOutput = '%24\n%31\n'
  const ghosttyAppInfo = '"CFBundleIdentifier"="com.mitchellh.ghostty"\n'

  assert.deepEqual([...parseForegroundPaneIds(clientPaneOutput)], ['%24', '%31'])
  assert.equal(isPaneInForeground('%24', clientPaneOutput), true)
  assert.equal(isPaneInForeground('%25', clientPaneOutput), false)
  assert.equal(isGhosttyFrontmost(ghosttyAppInfo), true)
  assert.equal(
    isPaneActuallyForeground('%24', clientPaneOutput, ghosttyAppInfo),
    true,
  )
})

test('an attached pane is not foreground while another macOS app is active', () => {
  const clientPaneOutput = '%24\n'
  const finderAppInfo = '"CFBundleIdentifier"="com.apple.finder"\n'

  assert.equal(isPaneInForeground('%24', clientPaneOutput), true)
  assert.equal(isGhosttyFrontmost(finderAppInfo), false)
  assert.equal(
    isPaneActuallyForeground('%24', clientPaneOutput, finderAppInfo),
    false,
  )
})

test('missing or malformed pane state fails open so notifications are not lost', () => {
  const ghosttyAppInfo = '"CFBundleIdentifier"="com.mitchellh.ghostty"\n'

  assert.equal(isPaneInForeground('', '%24\n'), false)
  assert.equal(isPaneInForeground('%24', ''), false)
  assert.equal(isPaneInForeground('%24', 'no server running\n'), false)
  assert.equal(isGhosttyFrontmost(''), false)
  assert.equal(isGhosttyFrontmost('invalid app info'), false)
  assert.equal(isPaneActuallyForeground('%24', '', ghosttyAppInfo), false)
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

test('focusing a session removes only its completion card', () => {
  const notifications = [
    { id: 'a', sessionId: 'agent-a', sessionName: 'Agent A', createdAt: 1 },
    { id: 'b', sessionId: 'agent-b', sessionName: 'Agent B', createdAt: 2 },
    { id: 'c', sessionId: 'agent-c', sessionName: 'Agent C', createdAt: 3 },
  ]
  const sessions = [
    { id: 'agent-a', paneId: '%24' },
    { id: 'agent-b', paneId: '%25' },
    { id: 'agent-c', paneId: '%26' },
  ]

  assert.deepEqual(
    removeForegroundCompletionNotifications(
      notifications,
      sessions,
      new Set(['%25']),
    ),
    [notifications[0], notifications[2]],
  )
  assert.deepEqual(
    removeForegroundCompletionNotifications(notifications, sessions, new Set()),
    notifications,
  )
})

test('notification cards reflow before the main-process dismissal reply', async () => {
  const renderer = await source('src/renderer/completion/CompletionNotifications.tsx')
  const start = renderer.indexOf('const dismiss = useCallback')
  const end = renderer.indexOf('\n\n  const activate', start)
  const block = renderer.slice(start, end)

  assert.ok(start >= 0)
  assert.ok(end > start)
  assert.ok(block.indexOf('setNotifications((current)') < block.indexOf('window.api.invoke(COMPLETION_NOTIFICATION_IPC.DISMISS'))
})

test('notification activation focuses the live terminal without rebuilding every status bar', async () => {
  const sessionManagerSource = await source('src/main/tmux/session-manager.ts')
  const start = sessionManagerSource.indexOf('export function focusSession')
  const end = sessionManagerSource.indexOf('/**\n * Set KITTY_ACTIVE_GROUP', start)
  const block = sessionManagerSource.slice(start, end)

  assert.ok(start >= 0)
  assert.ok(end > start)
  assert.ok(block.indexOf('switch-client') < block.indexOf('tell application "Ghostty" to activate'))
  assert.ok(block.indexOf('tell application "Ghostty" to activate') < block.indexOf("'refresh-client', '-S'"))
  assert.doesNotMatch(block, /refreshAllStatusBars|scheduleStatusBarRefresh|setImmediate/)
})

test('visible completion cards reconcile against the foreground pane', async () => {
  const notifications = await source('src/main/windows/completion-notification-window.ts')

  assert.match(notifications, /FOREGROUND_RECONCILE_MS = 500/)
  assert.match(notifications, /foregroundPaneIds\(\)/)
  assert.match(notifications, /removeForegroundCompletionNotifications\(/)
  assert.match(notifications, /ensureForegroundReconcile\(\)/)
  assert.match(notifications, /stopForegroundReconcile\(\)/)
})
