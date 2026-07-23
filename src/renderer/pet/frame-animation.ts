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

/** Move the animation clock one step toward the nearest endpoint.
 * For ping-pong clips, the same frame can occur on either half of the
 * timeline, so the clock may need to move backward to move the image forward. */
export function stepTickTowardNearestEndpoint(
  tick: number,
  frameCount: number,
  pingpong = false,
): number {
  const frame = resolveAnimationFrame(tick, frameCount, pingpong)
  const nextFrame = stepTowardNearestEndpoint(frame, frameCount)
  if (nextFrame === frame) return tick
  if (!pingpong) return tick + nextFrame - frame

  if (resolveAnimationFrame(tick + 1, frameCount, true) === nextFrame) {
    return tick + 1
  }
  const previousTick = Math.max(0, tick - 1)
  if (resolveAnimationFrame(previousTick, frameCount, true) === nextFrame) {
    return previousTick
  }
  return tick
}
