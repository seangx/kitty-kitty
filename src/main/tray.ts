import { Tray, Menu, nativeImage, app } from 'electron'
import { join } from 'path'

let tray: Tray | null = null

export function createTray(): Tray {
  // Use the app icon for tray, resized to 22x22 for macOS menu bar
  const isDev = !app.isPackaged
  const iconPath = isDev
    ? join(__dirname, '../../build/icon.png')
    : join(process.resourcesPath, 'icon.png')
  let icon: Electron.NativeImage
  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 })
  } catch {
    // Fallback to emoji SVG if icon file not found
    icon = nativeImage.createFromBuffer(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
          <text x="2" y="18" font-size="18">🐱</text>
        </svg>`
      )
    ).resize({ width: 22, height: 22 })
  }

  tray = new Tray(icon)
  tray.setToolTip('Kitty Kitty')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '🐱 显示宠物',
      click: () => {
        const { BrowserWindow } = require('electron')
        const wins = BrowserWindow.getAllWindows()
        if (wins.length > 0) wins[0].show()
      }
    },
    { type: 'separator' },
    {
      label: '🚀 开机启动',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked })
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])

  tray.setContextMenu(contextMenu)

  return tray
}
