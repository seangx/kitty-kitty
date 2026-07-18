import { BrowserWindow, ipcMain, screen, shell } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { is } from '@electron-toolkit/utils'
import { PET_WINDOW } from '@shared/constants'
import { log } from '../logger'
import { getSideDeckBounds } from './deck-window-layout'

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
const SNAP_PEEK = 64      // 顶部吸附后屏内留出的一截(px)
const SNAP_THRESHOLD = 24 // 窗口边缘距屏幕 workArea < 此值(或越界)即吸附
let snapState: { edge: SnapEdge; restore: { x: number; y: number } } | null = null
let snapDeckExpanded = false

/**
 * 窗口中心点所在的显示器。
 * 不用 getDisplayMatching(重叠面积法):拖动越过屏间边界时,窗口探进相邻屏的
 * 面积一超过一半,matching 就突然切到相邻屏,吸附会用错屏的 workArea 计算,
 * 把窗口推出整个虚拟桌面(多屏丢猫 bug 的根因)。中心点法稳定且符合直觉。
 */
function displayForWindow(b: Electron.Rectangle): Electron.Display {
  return screen.getDisplayNearestPoint({
    x: Math.round(b.x + b.width / 2),
    y: Math.round(b.y + b.height / 2),
  })
}

/**
 * 该显示器 edge 方向外侧、窗口正对的位置上,是否还有相邻显示器。
 * 内边(屏与屏之间的过渡)不允许吸附——把窗口推出这种边不是"藏进边缘",
 * 而是塞进相邻屏。只有虚拟桌面的外边缘才能吸附隐藏。
 */
function hasAdjacentDisplay(disp: Electron.Display, edge: SnapEdge, b: Electron.Rectangle): boolean {
  const db = disp.bounds
  // 探测点:屏物理边界(bounds,非 workArea——workArea 顶部让出的 menubar 仍属本屏)
  // 外侧 8px,在窗口中线对应的位置上
  const probe = edge === 'left' ? { x: db.x - 8, y: Math.round(b.y + b.height / 2) }
    : edge === 'right' ? { x: db.x + db.width + 8, y: Math.round(b.y + b.height / 2) }
    : { x: Math.round(b.x + b.width / 2), y: db.y - 8 }
  return screen.getAllDisplays().some((d) =>
    d.id !== disp.id &&
    probe.x >= d.bounds.x && probe.x < d.bounds.x + d.bounds.width &&
    probe.y >= d.bounds.y && probe.y < d.bounds.y + d.bounds.height)
}

/** 拖动松手时判定该吸附到哪条边(left/right/top),都不满足返回 null。下边不支持。 */
function computeSnapEdge(win: BrowserWindow): SnapEdge | null {
  const b = win.getBounds()
  const disp = displayForWindow(b)
  const wa = disp.workArea
  const candidates: Array<{ edge: SnapEdge; d: number }> = [
    { edge: 'left', d: b.x - wa.x },
    { edge: 'right', d: (wa.x + wa.width) - (b.x + b.width) },
    { edge: 'top', d: b.y - wa.y },
  ]
  const cands = candidates.filter((c) => c.d < SNAP_THRESHOLD && !hasAdjacentDisplay(disp, c.edge, b))
  if (!cands.length) return null
  cands.sort((a, c) => a.d - c.d) // 最越界/最近的一条边优先
  return cands[0].edge
}

/** 把窗口吸附到指定边。左右边显示窄 Deck；顶部仍保留原来的探头隐藏。 */
function snapTo(win: BrowserWindow, edge: SnapEdge): void {
  const b = win.getBounds()
  const wa = displayForWindow(b).workArea
  snapState = { edge, restore: { x: b.x, y: b.y } }
  snapDeckExpanded = false
  let x = b.x
  let y = b.y
  if (edge === 'left' || edge === 'right') {
    win.setBounds(getSideDeckBounds(edge, false, wa, y, b.height), true)
  } else {
    y = wa.y - (b.height - SNAP_PEEK)
    win.setPosition(Math.round(x), Math.round(y))
  }
  win.webContents.send('pet:snapped', { edge })
  win.webContents.send('pet:deck-expanded', { expanded: false })
}

/** 左右吸附时让 Deck 从所在屏幕边缘向内展开或收回。 */
function setSnapDeckExpanded(win: BrowserWindow, expanded: boolean): void {
  if (!snapState || snapState.edge === 'top') return
  if (snapDeckExpanded === expanded) return
  const b = win.getBounds()
  const { x: rx, y: ry } = snapState.restore
  const display = screen.getDisplayNearestPoint({
    x: Math.round(rx + PET_WINDOW.WIDTH / 2),
    y: Math.round(ry + PET_WINDOW.HEIGHT / 2),
  })
  const wa = display.workArea
  snapDeckExpanded = expanded
  win.setBounds(getSideDeckBounds(snapState.edge, expanded, wa, b.y, b.height), true)
  win.webContents.send('pet:deck-expanded', { expanded })
}

/** 解除吸附,滑回吸附前位置(clamp 进屏内保证完整可见)。 */
function unsnap(win: BrowserWindow): void {
  if (!snapState) return
  // clamp 用 restore 点所在的屏:吸附时窗口大部分在屏外,当前 bounds 的
  // 中心可能已不落在原屏(甚至任何屏)内,不能拿它定屏
  const { x: rx, y: ry } = snapState.restore
  const wa = screen.getDisplayNearestPoint({
    x: Math.round(rx + PET_WINDOW.WIDTH / 2),
    y: Math.round(ry + PET_WINDOW.HEIGHT / 2),
  }).workArea
  let x = rx
  let y = ry
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - PET_WINDOW.WIDTH))
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - PET_WINDOW.HEIGHT))
  snapState = null
  snapDeckExpanded = false
  win.setBounds({
    x: Math.round(x), y: Math.round(y),
    width: PET_WINDOW.WIDTH, height: PET_WINDOW.HEIGHT,
  }, true)
  win.webContents.send('pet:unsnapped')
  win.webContents.send('pet:deck-expanded', { expanded: false })
}

/**
 * 显示器布局变化(插拔屏/换扩展坞/切投影)后的自愈:
 * - 若处于吸附态,窗口大部分在旧屏的屏外坐标,新布局下极易失效(丢猫) →
 *   一律解除吸附,把猫拽回吸附前位置(clamp 进主屏可见区)。
 * - 若非吸附但窗口中心已不在任何屏的可见区(所在屏被拔掉) → 拽回主屏可见。
 * 两种情况都把归位后的可见坐标写进位置文件,重启也不会再卡屏外。
 */
function ensureOnScreen(): void {
  const win = petWindow
  if (!win || win.isDestroyed()) return
  const b = win.getBounds()
  const primary = screen.getPrimaryDisplay().workArea
  const clampToPrimary = (px: number, py: number): [number, number] => [
    Math.round(Math.max(primary.x, Math.min(px, primary.x + primary.width - PET_WINDOW.WIDTH))),
    Math.round(Math.max(primary.y, Math.min(py, primary.y + primary.height - PET_WINDOW.HEIGHT))),
  ]

  if (snapState) {
    // 吸附态:用吸附前位置归位(它也可能在已拔掉的屏上,故 clamp 到主屏)
    const { x: rx, y: ry } = snapState.restore
    snapState = null
    snapDeckExpanded = false
    win.webContents.send('pet:unsnapped')
    const [x, y] = clampToPrimary(rx, ry)
    win.setBounds({ x, y, width: PET_WINDOW.WIDTH, height: PET_WINDOW.HEIGHT })
    savePosition(x, y)
    return
  }

  // 非吸附:窗口中心是否还落在某块屏的可见区内
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  const centerVisible = screen.getAllDisplays().some((d) => {
    const wa = d.workArea
    return cx >= wa.x && cx < wa.x + wa.width && cy >= wa.y && cy < wa.y + wa.height
  })
  if (!centerVisible) {
    const [x, y] = clampToPrimary(b.x, b.y)
    win.setPosition(x, y)
    savePosition(x, y)
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
      // 拖动已吸附的猫 → 先隐式解除吸附(窗口跟手,不移动),让 renderer 退出探头模式
      if (snapState) {
        unsnap(win)
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
    ipcMain.handle('pet:set-deck-expanded', (_e, expanded: boolean) => {
      const win = getPetWindow()
      if (win && !win.isDestroyed()) setSnapDeckExpanded(win, !!expanded)
    })

    // 显示器布局变化自愈:插拔屏/换扩展坞后若猫卡在失效坐标(尤其吸附态换屏),
    // 自动拽回主屏可见区。debounce + 缓冲,等系统重排稳定再读 bounds。
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
