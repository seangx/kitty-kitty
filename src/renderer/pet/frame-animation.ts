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
