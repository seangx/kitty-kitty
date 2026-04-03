import { useState, useEffect } from 'react'
import type { AnimationState, SkinId } from '@shared/types/pet'
import { SKINS } from './animations/sprite-data'

interface Props {
  state: AnimationState
  skin?: SkinId
  size?: number
}

export default function PetSprite({ state, skin = 'classic', size = 128 }: Props) {
  const spriteSet = SKINS[skin]?.sprites ?? SKINS.classic.sprites
  const config = spriteSet[state]
  const frameIndex = useFrameAnimation(config.frames.length, config.intervalMs)

  return (
    <div
      className="flex items-center justify-center transition-transform duration-300"
      style={{ width: size, height: size }}
    >
      <pre
        className="text-white text-center leading-tight select-none pointer-events-none"
        style={{
          fontSize: size / 8,
          textShadow: '0 0 4px rgba(0,0,0,0.8), 0 0 8px rgba(0,0,0,0.4)',
          whiteSpace: 'pre'
        }}
      >
        {config.frames[frameIndex]}
      </pre>
    </div>
  )
}

function useFrameAnimation(frameCount: number, intervalMs: number): number {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    setFrame(0)
    if (frameCount <= 1) return
    const id = setInterval(() => {
      setFrame((prev) => (prev + 1) % frameCount)
    }, intervalMs)
    return () => clearInterval(id)
  }, [frameCount, intervalMs])

  return frame
}
