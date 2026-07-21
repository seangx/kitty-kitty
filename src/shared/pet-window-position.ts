// The tallest pet transition is 128 DIP higher than the idle stage. Keep this
// much transparent space above the normal pet UI so it stays inside the native
// BrowserWindow instead of being clipped by the window boundary.
export const PET_ANIMATION_HEADROOM = 128

export interface PetWindowPoint {
  x: number
  y: number
}

/**
 * Persist the visible idle-stage position rather than the transparent native
 * window top. This keeps existing saved positions compatible after adding
 * animation headroom above the pet.
 */
export function toPetWindowPosition(anchor: PetWindowPoint): PetWindowPoint {
  return { x: anchor.x, y: anchor.y - PET_ANIMATION_HEADROOM }
}

export function toPetAnchorPosition(windowPosition: PetWindowPoint): PetWindowPoint {
  return { x: windowPosition.x, y: windowPosition.y + PET_ANIMATION_HEADROOM }
}
