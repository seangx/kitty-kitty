import { BrowserWindow, ipcMain, screen, shell } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { is } from '@electron-toolkit/utils'
import { PET_WINDOW } from '@shared/constants'
import { log } from '../logger'

let petWindow: BrowserWindow | null = null
let popupWindow: BrowserWindow | null = null
let mouseHandlerRegistered = false

const POS_FILE = join(homedir(), '.kitty-kitty', 'window-pos.json')

function loadPosition(): { x: number; y: number } | null {
  try {
    const data = JSON.parse(readFileSync(POS_FILE, 'utf-8'))
    if (typeof data.x === 'number' && typeof data.y === 'number') {
      // Verify position is within a visible display
      const displays = screen.getAllDisplays()
      const visible = displays.some((d) => {
        const { x, y, width, height } = d.bounds
        return data.x >= x - 100 && data.x < x + width && data.y >= y - 100 && data.y < y + height
      })
      if (visible) return { x: data.x, y: data.y }
    }
  } catch { /* ignore */ }
  return null
}

function savePosition(x: number, y: number): void {
  try {
    mkdirSync(join(homedir(), '.kitty-kitty'), { recursive: true })
    writeFileSync(POS_FILE, JSON.stringify({ x, y }))
  } catch { /* ignore */ }
}

export function createPetWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay()
  const { width: screenWidth, height: screenHeight } = display.workAreaSize

  const saved = loadPosition()
  const startX = saved?.x ?? (screenWidth - PET_WINDOW.WIDTH - 50)
  const startY = saved?.y ?? (screenHeight - PET_WINDOW.HEIGHT)

  petWindow = new BrowserWindow({
    width: PET_WINDOW.WIDTH,
    height: PET_WINDOW.HEIGHT,
    x: startX,
    y: startY,
    transparent: true,
    frame: false,
    // DO NOT set alwaysOnTop here — it breaks blur events
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Set alwaysOnTop AFTER creation so blur events fire correctly
  petWindow.setAlwaysOnTop(true, 'floating')

  // Start with click-through enabled on transparent areas; renderer toggles dynamically
  petWindow.setIgnoreMouseEvents(true, { forward: true })

  if (!mouseHandlerRegistered) {
    mouseHandlerRegistered = true
    ipcMain.handle('set-ignore-mouse', (_e, ignore: boolean) => {
      const win = getPetWindow()
      if (win && !win.isDestroyed()) {
        win.setIgnoreMouseEvents(ignore, { forward: true })
      }
    })
    ipcMain.handle('move-window', (_e, dx: number, dy: number) => {
      const win = getPetWindow()
      if (win && !win.isDestroyed()) {
        const [x, y] = win.getPosition()
        win.setPosition(x + dx, y + dy)
      }
    })
    ipcMain.handle('drag-start', () => {
      const win = getPetWindow()
      if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver')
    })
    ipcMain.handle('drag-end', () => {
      const win = getPetWindow()
      if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'floating')
    })
    ipcMain.handle('popup-open', (_e, type: string, params: string) => {
      if (popupWindow && !popupWindow.isDestroyed()) {
        popupWindow.focus()
        return
      }
      const pet = getPetWindow()
      if (!pet) return
      const [px, py] = pet.getPosition()
      const popupW = 480
      const popupH = 520
      // Position to the left of the pet window
      let popupX = px - popupW - 12
      let popupY = py
      // If goes off-screen left, place to the right
      const display = screen.getDisplayMatching(pet.getBounds())
      if (popupX < display.workArea.x) {
        popupX = px + PET_WINDOW.WIDTH + 12
      }
      // Clamp Y
      popupY = Math.max(display.workArea.y, Math.min(popupY, display.workArea.y + display.workArea.height - popupH))

      popupWindow = new BrowserWindow({
        width: popupW,
        height: popupH,
        x: popupX,
        y: popupY,
        transparent: true,
        frame: false,
        resizable: true,
        skipTaskbar: true,
        hasShadow: true,
        alwaysOnTop: true,
        webPreferences: {
          preload: join(__dirname, '../preload/index.js'),
          sandbox: false,
          contextIsolation: true,
          nodeIntegration: false
        }
      })
      popupWindow.setAlwaysOnTop(true, 'floating')

      const hash = `#popup/${type}/${encodeURIComponent(params)}`
      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        popupWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + hash)
      } else {
        popupWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: `popup/${type}/${encodeURIComponent(params)}` })
      }

      popupWindow.on('closed', () => {
        popupWindow = null
        // Notify pet window that popup closed
        const p = getPetWindow()
        if (p && !p.isDestroyed()) p.webContents.send('popup-closed', type)
      })
    })
    ipcMain.handle('move-popup', (_e, dx: number, dy: number) => {
      if (popupWindow && !popupWindow.isDestroyed()) {
        const [x, y] = popupWindow.getPosition()
        popupWindow.setPosition(x + dx, y + dy)
      }
    })
    ipcMain.handle('popup-close', () => {
      if (popupWindow && !popupWindow.isDestroyed()) {
        popupWindow.close()
        popupWindow = null
      }
    })
  }

  // Save position when window moves
  petWindow.on('moved', () => {
    if (petWindow && !petWindow.isDestroyed()) {
      const [x, y] = petWindow.getPosition()
      savePosition(x, y)
    }
  })

  if (process.platform === 'darwin') {
    petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  petWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Notify renderer when window loses focus (click outside)
  petWindow.on('blur', () => {
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send('window-blur')
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    petWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    petWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  petWindow.on('ready-to-show', () => {
    const b = petWindow!.getBounds()
    log('window', `ready-to-show bounds=${b.x},${b.y} ${b.width}x${b.height}`)
  })

  petWindow.webContents.on('did-finish-load', () => {
    log('window', 'renderer loaded')
  })

  petWindow.webContents.on('render-process-gone', (_e, details) => {
    log('window', 'renderer CRASHED:', details.reason)
  })

  petWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) { // warnings and errors
      log('renderer', `[${level === 2 ? 'WARN' : 'ERROR'}] ${message}`)
    }
  })

  petWindow.on('closed', () => {
    petWindow = null
  })

  return petWindow
}

export function getPetWindow(): BrowserWindow | null {
  return petWindow
}
