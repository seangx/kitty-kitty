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

/** Frame timing per animation state (ms per frame). Slower than 12fps so the
 *  motion reads calmly; locomotion (walk/run/jump) a touch quicker than idle. */
const INTERVAL_MS: Record<AnimationState, number> = {
  'idle': 140,
  'walk-left': 110,
  'walk-right': 110,
  'sleep': 180,
  'happy': 110,
  'think': 150,
  'talk': 130,
  'sad': 180,
  'stretch': 150,
  'dance': 110,
  'roll': 120,
  'lick': 150,
  'jump': 110,
  'sneak': 150,
}

/** States that play forward-then-backward (ping-pong) instead of looping 0→11→0.
 *  These are in-place "gesture" clips (the cat returns to its rest pose), so a
 *  back-and-forth read is seamless. Locomotion/tumbling clips are left as plain
 *  forward loops since reversing them would look like walking backwards. */
const PING_PONG: Set<AnimationState> = new Set([
  'idle', 'sleep', 'sad', 'stretch', 'think', 'lick', 'talk', 'happy',
])

interface Props {
  state: AnimationState
  skin: SkinId
  size?: number
}

export default function PngSprite({ state, skin, size = 128 }: Props) {
  const urls = useMemo(() => {
    // Prefer state-specific frames; for walk-left fall back to walk-right with horizontal flip
    const key = `${skin}/${state}`
    if (FRAME_INDEX[key]?.length) return { urls: FRAME_INDEX[key], flip: false, resolved: state as AnimationState }
    if (state === 'walk-left' && FRAME_INDEX[`${skin}/walk-right`]?.length) {
      return { urls: FRAME_INDEX[`${skin}/walk-right`], flip: true, resolved: 'walk-right' as AnimationState }
    }
    // Fallback to idle for missing states — use idle's timing/ping-pong too.
    return { urls: FRAME_INDEX[`${skin}/idle`] ?? [], flip: false, resolved: 'idle' as AnimationState }
  }, [state, skin])

  const interval = INTERVAL_MS[urls.resolved] ?? 600
  const frameIdx = useFrameAnimation(urls.urls.length, interval, PING_PONG.has(urls.resolved))

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
        // Calico set is 256px photoreal RGBA, scaled down — keep it smooth.
        imageRendering: 'auto',
        display: 'block',
        filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.45))',
        transform: urls.flip ? 'scaleX(-1)' : undefined,
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    />
  )
}

function useFrameAnimation(frameCount: number, intervalMs: number, pingpong = false): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    setTick(0)
    if (frameCount <= 1) return
    const id = setInterval(() => setTick((t) => t + 1), intervalMs)
    return () => clearInterval(id)
  }, [frameCount, intervalMs])

  if (frameCount <= 1) return 0
  if (!pingpong) return tick % frameCount
  // 0,1,…,n-1,n-2,…,1 then repeat — seamless forward/back with no jump.
  const period = (frameCount - 1) * 2
  const pos = tick % period
  return pos < frameCount ? pos : period - pos
}
