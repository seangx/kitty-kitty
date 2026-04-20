import { useState, useEffect, useMemo } from 'react'
import type { AnimationState, SkinId } from '@shared/types/pet'

/**
 * Load all PNG sprite frames at build time via Vite glob import.
 * File layout: src/renderer/pet/sprites/<skin>/<state>-<idx>.png
 */
const FRAME_URLS = import.meta.glob('./sprites/*/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>

/**
 * Group urls by `${skin}/${state}` → sorted frame URLs.
 */
const FRAME_INDEX: Record<string, string[]> = (() => {
  const map: Record<string, { idx: number; url: string }[]> = {}
  for (const [path, url] of Object.entries(FRAME_URLS)) {
    // path example: ./sprites/calico/idle-0.png
    const match = path.match(/\/sprites\/([^/]+)\/([\w-]+?)-(\d+)\.png$/)
    if (!match) continue
    const [, skin, state, idx] = match
    const key = `${skin}/${state}`
    ;(map[key] ??= []).push({ idx: Number(idx), url })
  }
  const out: Record<string, string[]> = {}
  for (const [key, arr] of Object.entries(map)) {
    arr.sort((a, b) => a.idx - b.idx)
    out[key] = arr.map((e) => e.url)
  }
  return out
})()

/** Whether a skin has any PNG sprites at all */
export function skinHasPngSprites(skin: SkinId): boolean {
  for (const key of Object.keys(FRAME_INDEX)) {
    if (key.startsWith(`${skin}/`)) return true
  }
  return false
}

/** Frame timing per animation state (ms per frame) */
const INTERVAL_MS: Record<AnimationState, number> = {
  'idle': 900,
  'walk-left': 200,
  'walk-right': 200,
  'sleep': 1200,
  'happy': 350,
  'think': 600,
  'talk': 250,
  'sad': 800,
  'stretch': 500,
  'dance': 250,
  'roll': 350,
  'lick': 300,
  'jump': 200,
  'sneak': 500,
}

interface Props {
  state: AnimationState
  skin: SkinId
  size?: number
}

export default function PngSprite({ state, skin, size = 128 }: Props) {
  const urls = useMemo(() => {
    // Prefer state-specific frames; for walk-left fall back to walk-right with horizontal flip
    const key = `${skin}/${state}`
    if (FRAME_INDEX[key]?.length) return { urls: FRAME_INDEX[key], flip: false }
    if (state === 'walk-left' && FRAME_INDEX[`${skin}/walk-right`]?.length) {
      return { urls: FRAME_INDEX[`${skin}/walk-right`], flip: true }
    }
    // Fallback to idle for missing states
    return { urls: FRAME_INDEX[`${skin}/idle`] ?? [], flip: false }
  }, [state, skin])

  const interval = INTERVAL_MS[state] ?? 600
  const frameIdx = useFrameAnimation(urls.urls.length, interval)

  const src = urls.urls[frameIdx] ?? urls.urls[0]
  if (!src) return null

  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      draggable={false}
      style={{
        imageRendering: 'pixelated',
        display: 'block',
        filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.45))',
        transform: urls.flip ? 'scaleX(-1)' : undefined,
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    />
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
