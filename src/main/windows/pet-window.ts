import { BrowserWindow, ipcMain, screen, shell } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { is } from '@electron-toolkit/utils'
import { PET_WINDOW } from '@shared/constants'
import { log } from '../logger'
import {
  ANIMATE_FLOATING_DECK_BOUNDS,
  getFloatingDeckLayout,
  type DeckWindowEdge,
} from './deck-window-layout'

let petWindow: BrowserWindow | null = null
let popupWindow: BrowserWindow | null = null
let mouseHandlerRegistered = false
let deckRestoreBounds: Electron.Rectangle | null = null
let deckEdge: DeckWindowEdge = 'right'

const POS_FILE = join(homedir(), '.kitty-kitty', 'window-pos.json')

function loadPosition(): { x: number; y: number } | null {
  try {
    const data = JSON.parse(readFileSync(POS_FILE, 'utf-8'))
    if (typeof data.x === 'number' && typeof data.y === 'number') {
      // Verify position is within a visible display
      const displays = screen.getAllDisplays()
      const visible = displays.some((d) => {
        const { x, y, width, height } = d.workArea
        return data.x >= x && data.x < x + width - 50 && data.y >= y && data.y < y + height - 50
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

/**
 * 窗口中心点所在的显示器。
 * 不用 getDisplayMatching(重叠面积法)，避免窗口跨屏时因重叠面积突变而选错屏。
 */
function displayForWindow(b: Electron.Rectangle): Electron.Display {
  return screen.getDisplayNearestPoint({
    x: Math.round(b.x + b.width / 2),
    y: Math.round(b.y + b.height / 2),
  })
}

function setFloatingDeckOpen(win: BrowserWindow, open: boolean): { edge: DeckWindowEdge } {
  if (open) {
    if (!deckRestoreBounds) {
      const current = win.getBounds()
      const layout = getFloatingDeckLayout(current, displayForWindow(current).workArea)
      deckRestoreBounds = current
      deckEdge = layout.edge
      win.setBounds(layout.bounds, ANIMATE_FLOATING_DECK_BOUNDS)
    }
    return { edge: deckEdge }
  }
  if (deckRestoreBounds) {
    const restore = deckRestoreBounds
    deckRestoreBounds = null
    win.setBounds(restore, ANIMATE_FLOATING_DECK_BOUNDS)
  }
  return { edge: deckEdge }
}

/**
 * 显示器布局变化(插拔屏/换扩展坞/切投影)后的自愈:
 * 显示器布局变化后关闭 Deck，并把普通宠物窗口拽回主屏可见区。
 */
function ensureOnScreen(): void {
  const win = petWindow
  if (!win || win.isDestroyed()) return
  const b = deckRestoreBounds ?? win.getBounds()
  const primary = screen.getPrimaryDisplay().workArea
  const clampToPrimary = (px: number, py: number): [number, number] => [
    Math.round(Math.max(primary.x, Math.min(px, primary.x + primary.width - PET_WINDOW.WIDTH))),
    Math.round(Math.max(primary.y, Math.min(py, primary.y + primary.height - PET_WINDOW.HEIGHT))),
  ]

  if (deckRestoreBounds) {
    deckRestoreBounds = null
    win.webContents.send('pet:deck-closed')
  }
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  const centerVisible = screen.getAllDisplays().some((d) => {
    const wa = d.workArea
    return cx >= wa.x && cx < wa.x + wa.width && cy >= wa.y && cy < wa.y + wa.height
  })
  if (!centerVisible) {
    const [x, y] = clampToPrimary(b.x, b.y)
    win.setBounds({ x, y, width: PET_WINDOW.WIDTH, height: PET_WINDOW.HEIGHT })
    savePosition(x, y)
  } else if (win.getBounds().width !== PET_WINDOW.WIDTH) {
    win.setBounds(b, ANIMATE_FLOATING_DECK_BOUNDS)
  }
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
      if (!win || win.isDestroyed()) return
      win.setAlwaysOnTop(true, 'screen-saver')
    })
    ipcMain.handle('drag-end', () => {
      const win = getPetWindow()
      if (!win || win.isDestroyed()) return
      win.setAlwaysOnTop(true, 'floating')
      const [x, y] = win.getPosition()
      savePosition(x, y)
    })
    ipcMain.handle('pet:set-deck-open', (_e, open: boolean) => {
      const win = getPetWindow()
      if (!win || win.isDestroyed()) return { edge: deckEdge }
      return setFloatingDeckOpen(win, !!open)
    })

    // 显示器布局变化后关闭 Deck 并自动拽回主屏可见区。
    let displayChangeTimer: ReturnType<typeof setTimeout> | null = null
    const onDisplayChange = (): void => {
      if (displayChangeTimer) clearTimeout(displayChangeTimer)
      displayChangeTimer = setTimeout(ensureOnScreen, 400)
    }
    screen.on('display-added', onDisplayChange)
    screen.on('display-removed', onDisplayChange)
    screen.on('display-metrics-changed', onDisplayChange)

    ipcMain.handle('popup-open', (_e, type: string, params: string) => {
      if (popupWindow && !popupWindow.isDestroyed()) {
        popupWindow.focus()
        return
      }
      const pet = getPetWindow()
      if (!pet) return
      const petBounds = pet.getBounds()
      const { x: px, y: py } = petBounds
      const popupW = 480
      const popupH = 520
      // Position to the left of the pet window
      let popupX = px - popupW - 12
      let popupY = py
      // If goes off-screen left, place to the right
      const display = screen.getDisplayMatching(pet.getBounds())
      if (popupX < display.workArea.x) {
        popupX = px + petBounds.width + 12
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

  // Deck 展开时保存的是临时大窗口坐标，不能覆盖猫的普通位置。
  petWindow.on('moved', () => {
    if (petWindow && !petWindow.isDestroyed() && !deckRestoreBounds) {
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
    deckRestoreBounds = null
  })

  return petWindow
}

export function getPetWindow(): BrowserWindow | null {
  return petWindow
}
