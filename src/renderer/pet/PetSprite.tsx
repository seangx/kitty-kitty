import type { AnimationState, SkinId } from '@shared/types/pet'
import PixelSprite from './PixelSprite'

interface Props {
  state: AnimationState
  skin?: SkinId
  size?: number
}

export default function PetSprite({ state, skin = 'calico', size = 128 }: Props) {
  return <PixelSprite state={state} skin={skin} size={size} />
}
