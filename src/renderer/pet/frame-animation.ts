export function resolveAnimationFrame(
  tick: number,
  frameCount: number,
  pingpong = false,
  oneShot = false,
): number {
  if (frameCount <= 1) return 0
  if (oneShot) return Math.min(Math.max(tick, 0), frameCount - 1)
  if (!pingpong) return tick % frameCount

  // 0,1,…,n-1,n-2,…,1 then repeat — seamless forward/back with no jump.
  const period = (frameCount - 1) * 2
  const pos = tick % period
  return pos < frameCount ? pos : period - pos
}

/** Move one frame toward the closest endpoint. Both endpoints may represent
 * the same rest pose, so callers can settle without waiting for a full loop. */
export function stepTowardNearestEndpoint(frame: number, frameCount: number): number {
  if (frameCount <= 1) return 0
  const last = frameCount - 1
  const current = Math.min(Math.max(frame, 0), last)
  if (current === 0 || current === last) return current
  return current <= last / 2 ? current - 1 : current + 1
}
