export const CODEX_TURN_COMPLETED_EVENT = 'codex_turn_completed'

export const COMPLETION_NOTIFICATION_IPC = {
  LIST: 'completion-notification:list',
  DISMISS: 'completion-notification:dismiss',
  IGNORE_MOUSE: 'completion-notification:set-ignore-mouse',
  CHANGED: 'completion-notification:changed',
} as const

export const COMPLETION_NOTIFICATION = {
  WINDOW_WIDTH: 360,
  WINDOW_HEIGHT: 216,
  TOP_OFFSET: 18,
  MAX_VISIBLE: 3,
} as const

export interface CompletionNotification {
  id: string
  sessionId: string
  sessionName: string
  createdAt: number
}

/**
 * Keep at most one completion card per Kitty agent/session.
 *
 * A fresh notification keeps its fresh id so an exit animation already
 * running for the replaced card cannot dismiss the newer completion.
 */
export function upsertCompletionNotification(
  notifications: readonly CompletionNotification[],
  next: CompletionNotification,
): CompletionNotification[] {
  return [
    next,
    ...notifications.filter((notification) => notification.sessionId !== next.sessionId),
  ]
}

export function removeForegroundCompletionNotifications(
  notifications: readonly CompletionNotification[],
  sessions: ReadonlyArray<{ id: string; paneId: string }>,
  foregroundPaneIds: ReadonlySet<string>,
): CompletionNotification[] {
  if (foregroundPaneIds.size === 0) return [...notifications]
  const foregroundSessionIds = new Set(
    sessions
      .filter((session) => foregroundPaneIds.has(session.paneId))
      .map((session) => session.id),
  )
  return notifications.filter(
    (notification) => !foregroundSessionIds.has(notification.sessionId),
  )
}

export interface ScreenWorkArea {
  x: number
  y: number
  width: number
  height: number
}

export function getCompletionNotificationWindowBounds(workArea: ScreenWorkArea): {
  x: number
  y: number
  width: number
  height: number
} {
  const { WINDOW_WIDTH: width, WINDOW_HEIGHT: height, TOP_OFFSET } = COMPLETION_NOTIFICATION
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + TOP_OFFSET,
    width,
    height,
  }
}
