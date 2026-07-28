export const DECK_INTERACTIVE_SELECTOR = [
  '.session-deck__rail',
  '.session-deck__branch',
  '.session-deck__menu',
  '.session-deck__name-dialog',
  '.session-deck__restart-progress',
  '.session-deck__drag-preview',
].join(', ')

interface ClosestTarget {
  closest(selectors: string): unknown
}

/**
 * The native Deck window is much wider than its visible surfaces. Only the
 * visible interaction islands should make that whole window capture clicks.
 */
export function isDeckInteractiveTarget(target: EventTarget | null): boolean {
  const candidate = target as unknown as ClosestTarget | null
  if (!candidate || typeof candidate.closest !== 'function') return false
  return Boolean(candidate.closest(DECK_INTERACTIVE_SELECTOR))
}
