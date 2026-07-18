import { basename } from 'path'

/** Build the stable pane header shown by tmux from Kitty's own session data. */
export function formatPaneLabel(title: string, cwd: string): string {
  const dirName = basename(cwd.trim()) || cwd.trim()
  const customName = title.replace(/[\r\n]+/g, ' ').trim()
  if (!customName) return dirName
  if (!dirName || customName === dirName) return customName
  return `${customName} (${dirName})`
}
