import type { AnimationState, SkinId } from '@shared/types/pet'
import PixelSprite from './PixelSprite'

interface Props {
  state: AnimationState
  skin?: SkinId
  size?: number
  onFrameChange?: (state: AnimationState, frame: number) => void
}

export default function PetSprite({ state, skin = 'calico', size = 128, onFrameChange }: Props) {
  return <PixelSprite state={state} skin={skin} size={size} onFrameChange={onFrameChange} />
}
