export interface DeckWorkArea {
  x: number
  y: number
  width: number
  height: number
}

export const SIDE_DECK_RAIL_WIDTH = 82
export const SIDE_DECK_EXPANDED_WIDTH = 720

export function getSideDeckBounds(
  edge: 'left' | 'right',
  expanded: boolean,
  workArea: DeckWorkArea,
  currentY: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const width = expanded
    ? Math.min(SIDE_DECK_EXPANDED_WIDTH, workArea.width)
    : Math.min(SIDE_DECK_RAIL_WIDTH, workArea.width)
  const x = edge === 'left' ? workArea.x : workArea.x + workArea.width - width
  const y = Math.max(workArea.y, Math.min(currentY, workArea.y + workArea.height - height))
  return { x: Math.round(x), y: Math.round(y), width, height }
}
