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

/**
 * Deck 不再依赖屏幕吸附。它以猫当前的水平中心为基准扩展，并根据猫位于
 * 屏幕哪一半选择长条栏所在侧；最终窗口始终限制在当前显示器工作区内。
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
  const y = Math.max(workArea.y, Math.min(current.y, workArea.y + workArea.height - current.height))
  return {
    edge,
    bounds: {
      x: Math.round(x),
      y: Math.round(y),
      width,
      height: current.height,
    },
  }
}
