import { app, BrowserWindow, dialog } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createPetWindow } from './windows/pet-window'
import { createTray } from './tray'
import { registerIpcHandlers } from './ipc/handlers'
import { initDB, closeDB } from './db/database'
import { initLogger, log } from './logger'
import { hasTmux, focusAnyAttachedSession } from './tmux/session-manager'
import * as sessionMcp from './mcp/session-mcp-manager'
import * as ntfy from './ntfy'

app.whenReady().then(() => {
  initLogger()
  log('app', 'ready')
  electronApp.setAppUserModelId('com.kitty-kitty.app')

  if (!hasTmux()) {
    log('app', 'tmux not found')
    dialog.showErrorBox(
      'Kitty Kitty — 缺少 tmux',
      '未检测到 tmux，会话管理功能无法使用。\n\n'
      + '安装方法：\n'
      + '  macOS:  brew install tmux\n'
      + '  Ubuntu: sudo apt install tmux\n\n'
      + '安装后重新启动 Kitty Kitty。'
    )
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  try { initDB(); log('app', 'db initialized') } catch (e) { log('app', 'db error:', e) }
  try { registerIpcHandlers(); log('app', 'ipc handlers registered') } catch (e) { log('app', 'ipc error:', e) }
  try { createTray(); log('app', 'tray created') } catch (e) { log('app', 'tray error:', e) }
  try { createPetWindow(); log('app', 'pet window created') } catch (e) { log('app', 'window error:', e) }
  try { ntfy.start(); log('app', 'ntfy listener started') } catch (e) { log('app', 'ntfy error:', e) }
})

app.on('window-all-closed', () => {
  // Don't quit - the pet lives in the tray
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createPetWindow()
  }
  // Dock click: bring the terminal to front if any session is attached
  if (process.platform === 'darwin') {
    focusAnyAttachedSession()
  }
})

app.on('before-quit', () => {
  ntfy.stop()
  sessionMcp.cleanupAll()
  closeDB()
})
