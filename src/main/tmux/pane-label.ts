import { basename } from 'path'

export const PANE_BORDER_STATUS = 'bottom'
export const PANE_BORDER_FORMAT = '#[fg=#{?pane_active,#645efb,#46465c},bg=#1e1e36,align=right] #{?@kitty_label,#{@kitty_label},#{b:pane_current_path}} '

/** Build the stable pane header shown by tmux from Kitty's own session data. */
export function formatPaneLabel(title: string, cwd: string): string {
  const dirName = basename(cwd.trim()) || cwd.trim()
  const customName = title.replace(/[\r\n]+/g, ' ').trim()
  if (!customName) return dirName
  if (!dirName || customName === dirName) return customName
  return `${customName} (${dirName})`
}
