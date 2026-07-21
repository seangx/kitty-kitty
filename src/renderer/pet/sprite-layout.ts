import type { AnimationState, SkinId } from '@shared/types/pet'

const BASE_SPRITE_PIXELS = 256

const FRAME_CANVAS: Record<string, { width: number; height: number }> = {
  'calico/idle': { width: 320, height: 256 },
  'calico/deck-open': { width: 320, height: 512 },
}

export function getPngSpriteDisplaySize(
  skin: SkinId,
  state: AnimationState,
  size = 128,
): { width: number; height: number } {
  const canvas = FRAME_CANVAS[`${skin}/${state}`] ?? {
    width: BASE_SPRITE_PIXELS,
    height: BASE_SPRITE_PIXELS,
  }
  return {
    width: Math.round(size * canvas.width / BASE_SPRITE_PIXELS),
    height: Math.round(size * canvas.height / BASE_SPRITE_PIXELS),
  }
}

/**
 * The pet's desktop footprint must not change with its animation canvas.
 * Taller gestures overflow upward from the idle stage's fixed bottom edge.
 */
export function getPetAnimationStageSize(
  skin: SkinId,
  size = 128,
): { width: number; height: number } {
  return getPngSpriteDisplaySize(skin, 'idle', size)
}
