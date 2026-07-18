export interface DeckWorkArea {
  x: number
  y: number
  width: number
  height: number
}

// 收起态只显示 128px 的猫；展开态为完整 Deck 画布。
export const SIDE_DECK_PET_WIDTH = 128
export const SIDE_DECK_EXPANDED_WIDTH = 720
// macOS 会在透明 BrowserWindow 的原生 bounds 动画期间留下合成残影。
export const ANIMATE_SIDE_DECK_BOUNDS = false

export function getSideDeckBounds(
  edge: 'left' | 'right',
  expanded: boolean,
  workArea: DeckWorkArea,
  currentY: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const width = expanded
    ? Math.min(SIDE_DECK_EXPANDED_WIDTH, workArea.width)
    : Math.min(SIDE_DECK_PET_WIDTH, workArea.width)
  const x = edge === 'left' ? workArea.x : workArea.x + workArea.width - width
  const y = Math.max(workArea.y, Math.min(currentY, workArea.y + workArea.height - height))
  return { x: Math.round(x), y: Math.round(y), width, height }
}
