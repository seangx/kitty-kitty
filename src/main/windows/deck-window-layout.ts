export interface DeckWorkArea {
  x: number
  y: number
  width: number
  height: number
}

export interface DeckWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export type DeckWindowEdge = 'left' | 'right'

export const FLOATING_DECK_WIDTH = 720
// macOS 会在透明 BrowserWindow 的原生 bounds 动画期间留下合成残影。
export const ANIMATE_FLOATING_DECK_BOUNDS = false

export interface FloatingDeckWindow {
  setBounds(bounds: DeckWindowBounds, animate?: boolean): void
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void
}

/**
 * 透明窗口改变大小时不能继承之前停在猫/Deck 控件上的鼠标捕获状态。
 * 先应用新 bounds，再让透明区域重新穿透；renderer 会在鼠标真正进入
 * 可见控件时恢复交互。
 */
export function applyFloatingDeckBounds(
  win: FloatingDeckWindow,
  bounds: DeckWindowBounds,
): void {
  win.setBounds(bounds, ANIMATE_FLOATING_DECK_BOUNDS)
  win.setIgnoreMouseEvents(true, { forward: true })
}

/**
 * Deck 不再依赖屏幕吸附。它以猫当前的水平中心为基准扩展，并根据猫位于
 * 屏幕哪一半选择长条栏所在侧。展开后的窗口使用当前显示器完整工作区高度，
 * 让长条栏随屏幕变化，同时避开菜单栏和 Dock。
 */
export function getFloatingDeckLayout(
  current: DeckWindowBounds,
  workArea: DeckWorkArea,
): { edge: DeckWindowEdge; bounds: DeckWindowBounds } {
  const petCenterX = current.x + current.width / 2
  const edge: DeckWindowEdge = petCenterX <= workArea.x + workArea.width / 2 ? 'left' : 'right'
  const width = Math.min(FLOATING_DECK_WIDTH, workArea.width)
  const idealX = petCenterX - width / 2
  const x = Math.max(workArea.x, Math.min(idealX, workArea.x + workArea.width - width))
  return {
    edge,
    bounds: {
      x: Math.round(x),
      y: workArea.y,
      width,
      height: workArea.height,
    },
  }
}
