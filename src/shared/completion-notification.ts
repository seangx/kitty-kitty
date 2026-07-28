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
