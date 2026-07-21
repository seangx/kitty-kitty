export interface AutoCloseRect {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * Treat adjacent trigger and menu rectangles as one safe corridor. This lets
 * the pointer cross the visual gap between them without dismissing the menu.
 */
export function isPointerOutsideSafeCorridor(
  x: number,
  y: number,
  rects: AutoCloseRect[],
  padding: number,
): boolean {
  if (rects.length === 0) return true
  const left = Math.min(...rects.map((rect) => rect.left)) - padding
  const right = Math.max(...rects.map((rect) => rect.right)) + padding
  const top = Math.min(...rects.map((rect) => rect.top)) - padding
  const bottom = Math.max(...rects.map((rect) => rect.bottom)) + padding
  return x < left || x > right || y < top || y > bottom
}
