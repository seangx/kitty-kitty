/**
 * Tracks claude sessions that were just "cleared" (新对话) but whose new jsonl
 * hasn't been created on disk yet.
 *
 * Why this exists:
 *   claude `/clear` rolls to a fresh session id, but the new jsonl is created
 *   LAZILY — only after the user sends their first message. In the window
 *   between clear and that first message, the ONLY jsonl on disk for this cwd
 *   is the OLD one. Two code paths would wrongly resurrect it:
 *     1. syncExternalSessionIds() sees the emptied externalSessionId, picks the
 *        newest unclaimed jsonl (= the old one), and backfills it.
 *     2. restartSessionPane() with an empty ext falls back to `claude -c`
 *        (continue), which also resumes the newest = old jsonl.
 *
 * Marking the session as "cleared" makes both paths treat it as "start fresh"
 * until the wakeup Stop hook reports the genuinely-new jsonl (cwd-validated),
 * at which point we clear the mark.
 */

const cleared = new Map<string, number>()
// Safety cap: if the user clears but never sends a message, drop the mark so a
// later restart doesn't stay stuck in "always new" forever.
const TTL_MS = 10 * 60_000

export function markCleared(id: string): void {
  cleared.set(id, Date.now())
}

export function isCleared(id: string): boolean {
  const t = cleared.get(id)
  if (t === undefined) return false
  if (Date.now() - t > TTL_MS) {
    cleared.delete(id)
    return false
  }
  return true
}

export function clearMark(id: string): void {
  cleared.delete(id)
}
