export interface MenuPosition {
  left: number
  top: number
}

/** Keep a fixed-position menu inside the viewport without changing its size. */
export function clampMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 4,
): MenuPosition {
  const maxLeft = Math.max(margin, viewportWidth - menuWidth - margin)
  const maxTop = Math.max(margin, viewportHeight - menuHeight - margin)
  return {
    left: Math.min(Math.max(x, margin), maxLeft),
    top: Math.min(Math.max(y, margin), maxTop),
  }
}
