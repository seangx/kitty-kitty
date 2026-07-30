import { randomUUID } from 'crypto'
import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import {
  COMPLETION_NOTIFICATION_IPC,
  getCompletionNotificationWindowBounds,
  removeForegroundCompletionNotifications,
  type CompletionNotification,
  upsertCompletionNotification,
} from '@shared/completion-notification'
import { log } from '../logger'
import * as sessionRepo from '../db/session-repo'
import { foregroundPaneIds } from '../tmux/session-manager'

let notificationWindow: BrowserWindow | null = null
let registered = false
let rendererReady = false
let notifications: CompletionNotification[] = []
let foregroundTimer: ReturnType<typeof setInterval> | null = null

const FOREGROUND_RECONCILE_MS = 500

function currentDisplay(): Electron.Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

function positionWindow(win: BrowserWindow): void {
  win.setBounds(getCompletionNotificationWindowBounds(currentDisplay().workArea))
}

function sendNotifications(): void {
  const win = notificationWindow
  if (!rendererReady || !win || win.isDestroyed()) return
  win.webContents.send(COMPLETION_NOTIFICATION_IPC.CHANGED, notifications)
}

function hideWhenEmpty(): void {
  if (notifications.length > 0) return
  stopForegroundReconcile()
  const win = notificationWindow
  if (!win || win.isDestroyed()) return
  win.setIgnoreMouseEvents(true, { forward: true })
  win.hide()
}

function stopForegroundReconcile(): void {
  if (!foregroundTimer) return
  clearInterval(foregroundTimer)
  foregroundTimer = null
}

function reconcileForegroundNotifications(): void {
  if (notifications.length === 0) {
    stopForegroundReconcile()
    return
  }

  const paneIds = foregroundPaneIds()
  if (paneIds.size === 0) return

  const next = removeForegroundCompletionNotifications(
    notifications,
    sessionRepo.listSessions(),
    paneIds,
  )
  if (next.length === notifications.length) return

  const removed = notifications
    .filter((notification) => !next.some((candidate) => candidate.id === notification.id))
    .map((notification) => notification.sessionName)
  notifications = next
  sendNotifications()
  hideWhenEmpty()
  log('completion-notification', `focused session dismissed ${removed.join(', ')}`)
}

function ensureForegroundReconcile(): void {
  if (foregroundTimer) return
  foregroundTimer = setInterval(
    reconcileForegroundNotifications,
    FOREGROUND_RECONCILE_MS,
  )
  foregroundTimer.unref()
}

function ensureWindow(): BrowserWindow {
  if (notificationWindow && !notificationWindow.isDestroyed()) return notificationWindow

  rendererReady = false
  const bounds = getCompletionNotificationWindowBounds(currentDisplay().workArea)
  notificationWindow = new BrowserWindow({
    ...bounds,
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const win = notificationWindow
  win.setAlwaysOnTop(true, 'floating')
  win.setIgnoreMouseEvents(true, { forward: true })
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  const hash = '#completion-notifications'
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'] + hash)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'completion-notifications' })
  }

  win.webContents.on('did-finish-load', () => {
    rendererReady = true
    sendNotifications()
    if (notifications.length > 0) {
      positionWindow(win)
      win.showInactive()
    }
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    rendererReady = false
    log('completion-notification', `renderer gone: ${details.reason}`)
  })
  win.on('closed', () => {
    stopForegroundReconcile()
    rendererReady = false
    notificationWindow = null
  })
  return win
}

export function registerCompletionNotificationHandlers(): void {
  if (registered) return
  registered = true

  ipcMain.handle(COMPLETION_NOTIFICATION_IPC.LIST, () => notifications)
  ipcMain.handle(COMPLETION_NOTIFICATION_IPC.DISMISS, (_event, id: string) => {
    const before = notifications.length
    notifications = notifications.filter((notification) => notification.id !== id)
    if (notifications.length === before) return { success: false }
    sendNotifications()
    hideWhenEmpty()
    return { success: true }
  })
  ipcMain.handle(COMPLETION_NOTIFICATION_IPC.IGNORE_MOUSE, (_event, ignore: boolean) => {
    const win = notificationWindow
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(Boolean(ignore), { forward: true })
    }
  })

  screen.on('display-metrics-changed', () => {
    const win = notificationWindow
    if (win && !win.isDestroyed() && win.isVisible()) positionWindow(win)
  })
}

export function showCompletionNotification(sessionId: string, sessionName: string): void {
  const replacing = notifications.some((notification) => notification.sessionId === sessionId)
  notifications = upsertCompletionNotification(notifications, {
    id: randomUUID(),
    sessionId,
    sessionName,
    createdAt: Date.now(),
  })

  const win = ensureWindow()
  ensureForegroundReconcile()
  positionWindow(win)
  sendNotifications()
  if (rendererReady) win.showInactive()
  log('completion-notification', `${replacing ? 'refreshed' : 'queued'} ${sessionName} (${sessionId})`)
}

export function closeCompletionNotificationWindow(): void {
  stopForegroundReconcile()
  notifications = []
  const win = notificationWindow
  if (win && !win.isDestroyed()) win.destroy()
  notificationWindow = null
  rendererReady = false
}
