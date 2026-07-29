/**
 * Parse the active pane reported for each attached tmux client.
 *
 * There can be multiple kitty agents inside one tmux session, so
 * `session_attached` is not precise enough for completion notifications.
 */
export function parseForegroundPaneIds(output: string): Set<string> {
  return new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter((paneId) => /^%\d+$/.test(paneId)),
  )
}

export function isPaneInForeground(paneId: string, clientPaneOutput: string): boolean {
  const candidate = paneId.trim()
  if (!/^%\d+$/.test(candidate)) return false
  return parseForegroundPaneIds(clientPaneOutput).has(candidate)
}

const GHOSTTY_BUNDLE_ID = 'com.mitchellh.ghostty'

export function isGhosttyFrontmost(frontmostAppInfo: string): boolean {
  const bundleId = frontmostAppInfo.match(
    /"CFBundleIdentifier"\s*=\s*"([^"]+)"/,
  )?.[1]
  return bundleId === GHOSTTY_BUNDLE_ID
}

export function isPaneActuallyForeground(
  paneId: string,
  clientPaneOutput: string,
  frontmostAppInfo: string,
): boolean {
  return isGhosttyFrontmost(frontmostAppInfo)
    && isPaneInForeground(paneId, clientPaneOutput)
}
