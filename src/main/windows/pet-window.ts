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

// ─── 贴边隐藏(探头吸附) ───────────────────
type SnapEdge = 'left' | 'right' | 'top'
const SNAP_PEEK = 64      // 吸附后屏内留出的一截(px)
const SNAP_THRESHOLD = 24 // 窗口边缘距屏幕 workArea < 此值(或越界)即吸附
let snapState: { edge: SnapEdge; restore: { x: number; y: number } } | null = null

/** 拖动松手时判定该吸附到哪条边(left/right/top),都不满足返回 null。下边不支持。 */
function computeSnapEdge(win: BrowserWindow): SnapEdge | null {
  const b = win.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  const cands: Array<{ edge: SnapEdge; d: number }> = [
    { edge: 'left', d: b.x - wa.x },
    { edge: 'right', d: (wa.x + wa.width) - (b.x + b.width) },
    { edge: 'top', d: b.y - wa.y },
  ].filter((c) => c.d < SNAP_THRESHOLD)
  if (!cands.length) return null
  cands.sort((a, c) => a.d - c.d) // 最越界/最近的一条边优先
  return cands[0].edge
}

/** 把窗口移到指定边、只留 SNAP_PEEK 一截在屏内,并记录吸附前位置。 */
function snapTo(win: BrowserWindow, edge: SnapEdge): void {
  const b = win.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  snapState = { edge, restore: { x: b.x, y: b.y } }
  let x = b.x
  let y = b.y
  if (edge === 'left') x = wa.x - (b.width - SNAP_PEEK)
  else if (edge === 'right') x = wa.x + wa.width - SNAP_PEEK
  else if (edge === 'top') y = wa.y - (b.height - SNAP_PEEK)
  win.setPosition(Math.round(x), Math.round(y))
  win.webContents.send('pet:snapped', { edge })
}

/** 解除吸附,滑回吸附前位置(clamp 进屏内保证完整可见)。 */
function unsnap(win: BrowserWindow): void {
  if (!snapState) return
  const b = win.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  let { x, y } = snapState.restore
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - b.width))
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - b.height))
  snapState = null
  win.setPosition(Math.round(x), Math.round(y))
  win.webContents.send('pet:unsnapped')
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
      // 拖动已吸附的猫 → 先隐式解除吸附(窗口跟手,不移动),让 renderer 退出探头模式
      if (snapState) {
        snapState = null
        win.webContents.send('pet:unsnapped')
      }
    })
    ipcMain.handle('drag-end', () => {
      const win = getPetWindow()
      if (!win || win.isDestroyed()) return
      win.setAlwaysOnTop(true, 'floating')
      const edge = computeSnapEdge(win)
      if (edge) snapTo(win, edge)
    })
    ipcMain.handle('pet:unsnap', () => {
      const win = getPetWindow()
      if (win && !win.isDestroyed()) unsnap(win)
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

  // Save position when window moves (吸附期间不存,避免把屏外坐标写进位置文件)
  petWindow.on('moved', () => {
    if (petWindow && !petWindow.isDestroyed() && !snapState) {
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
