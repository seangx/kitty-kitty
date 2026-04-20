import type { SkinId } from '@shared/types/pet'
import { SKIN_META, PIXEL_PALETTES } from './pixel-sprites'

/**
 * Skin registry for the skin picker.
 * Each skin is a pixel-art color variant — actual sprites live in pixel-sprites.ts.
 * The `preview` field is a short colored indicator used in the picker UI.
 */

function previewFor(id: SkinId): { body: string; stroke: string } {
  const p = PIXEL_PALETTES[id]
  return { body: p.O, stroke: p.K }
}

export const SKINS: Record<SkinId, { name: string; body: string; stroke: string }> = {
  calico:  { name: SKIN_META.calico.name,  ...previewFor('calico')  },
  sheep:   { name: SKIN_META.sheep.name,   ...previewFor('sheep')   },
  chicken: { name: SKIN_META.chicken.name, ...previewFor('chicken') },
}
