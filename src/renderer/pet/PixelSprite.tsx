import { useState, useEffect } from 'react'
import type { AnimationState, SkinId } from '@shared/types/pet'
import { PIXEL_SPRITES, PIXEL_PALETTES, PixelFrame, Palette } from './animations/pixel-sprites'
import PngSprite, { skinHasPngSprites } from './PngSprite'

interface Props {
  state: AnimationState
  skin?: SkinId
  size?: number
}

export default function PixelSprite({ state, skin = 'calico', size = 128 }: Props) {
  // If the skin has real PNG sprites, use them
  if (skin && skinHasPngSprites(skin)) {
    return <PngSprite state={state} skin={skin} size={size} />
  }

  // Fallback: SVG-rendered ASCII pixel sprites for skins without PNG assets yet
  const spriteSet = PIXEL_SPRITES[skin] ?? PIXEL_SPRITES.calico
  const palette = PIXEL_PALETTES[skin] ?? PIXEL_PALETTES.calico
  const config = spriteSet[state] ?? spriteSet.idle
  const frameIdx = useFrameAnimation(config.frames.length, config.intervalMs)
  // Clamp frame index: state change races can leave frameIdx pointing past the new array
  const current = config.frames[frameIdx] ?? config.frames[0]
  if (!current) return null
  return <PixelFrameView frame={current} palette={palette} size={size} />
}

function PixelFrameView({ frame, palette, size }: { frame: PixelFrame; palette: Palette; size: number }) {
  const cols = frame.rows[0]?.length ?? 16
  const rows = frame.rows.length
  return (
    <svg
      viewBox={`0 0 ${cols} ${rows}`}
      width={size}
      height={size}
      style={{
        imageRendering: 'pixelated',
        display: 'block',
        filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.45))',
      }}
      shapeRendering="crispEdges"
    >
      {frame.rows.map((row, y) =>
        row.split('').map((ch, x) => {
          const color = palette[ch]
          if (!color) return null
          return <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={color} />
        })
      )}
    </svg>
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
