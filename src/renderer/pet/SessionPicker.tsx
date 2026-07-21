import { useState } from 'react'
import type { ToolId } from '../store/config-store'
import {
  DIRECTORY_TOOLS,
  createDirectoryStartAction,
} from '@shared/directory-session'
import type { ExternalDirectorySession } from '@shared/directory-session'
import { T, btnClose, btnGhost, btnPrimary, popover, popupHeader } from './ui-tokens'

export type PickAction =
  | { type: 'new'; tool: string }
  | { type: 'continue-latest'; tool: string }
  | { type: 'resume'; tool: string; id: string }

interface Props {
  dir: string
  defaultTool: ToolId
  sessions: ExternalDirectorySession[]
  onPick: (action: PickAction) => void
  onClose: () => void
}

const TOOL_BADGE: Record<string, { label: string; color: string }> = {
  claude: { label: '⚡ Claude', color: '#78a9ff' },
  codex:  { label: '✦ Codex',  color: '#f0b45a' },
  opencode: { label: '◈ OpenCode', color: '#6fd7c8' },
}

export default function SessionPicker({ dir, defaultTool, sessions: initialSessions, onPick, onClose }: Props) {
  const dirName = dir.split('/').pop() || dir
  const [sessions, setSessions] = useState(initialSessions)
  const [tool, setTool] = useState<ToolId>(defaultTool)

  const handleDelete = async (id: string, tool: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const target = sessions.find((s) => s.id === id)
    if (!window.confirm(`确定删除会话记录「${target?.summary || id.slice(0, 8)}」？\n仅删除历史记录，不影响正在运行的会话。`)) return
    try {
      await window.api.invoke('session:delete-external-session', tool, dir, id)
      setSessions((prev) => prev.filter((s) => s.id !== id))
    } catch (err) {
      console.error('Failed to delete session:', err)
    }
  }

  return (
    <div style={{
      ...popover({ alpha: 'f5', radius: 16 }), padding: 14, width: 320,
      maxHeight: 420, overflow: 'auto',
    }}>
      <div data-drag-handle style={{ ...popupHeader(), marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>📂 {dirName}</div>
          <div style={{ fontSize: 10, color: T.faint, marginTop: 2 }}>
            选择工具后继续或新建
          </div>
        </div>
        <button onClick={onClose} style={{ ...btnClose(), fontSize: 14 }}>✕</button>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {DIRECTORY_TOOLS.map((toolOption) => {
          const badge = TOOL_BADGE[toolOption]
          const active = tool === toolOption
          return (
            <button
              key={toolOption}
              onClick={() => setTool(toolOption)}
              style={{
                flex: 1, padding: '6px 5px', borderRadius: 8,
                border: `1px solid ${active ? `${badge.color}66` : `${T.border}12`}`,
                background: active ? `${badge.color}1c` : 'rgba(255,255,255,0.03)',
                color: active ? badge.color : T.faint,
                fontSize: 10, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              {badge.label}
            </button>
          )
        })}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <button
          onClick={() => onPick(createDirectoryStartAction('new', tool))}
          style={{
            ...btnGhost({ radius: 10 }), flex: 1, padding: '8px 12px',
            color: T.text, fontWeight: 600, textAlign: 'center',
          }}
        >
          🆕 新建
        </button>
        <button
          onClick={() => onPick(createDirectoryStartAction('continue-latest', tool))}
          style={{ ...btnPrimary({ radius: 10 }), flex: 1, padding: '8px 12px', textAlign: 'center' }}
        >
          ✨ 继续最近
        </button>
      </div>

      {sessions.length > 0 && (
        <div style={{ fontSize: 10, color: T.faint, marginTop: 8, marginBottom: 4 }}>指定会话恢复：</div>
      )}
      {sessions.map((s) => {
        const sTool = s.tool || defaultTool
        const badge = TOOL_BADGE[sTool] || { label: sTool, color: T.faint }
        return (
          <div key={`${sTool}:${s.id}`} style={{
            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4,
          }}>
            <button
              onClick={() => onPick({ type: 'resume', tool: sTool, id: s.id })}
              style={{
                flex: 1, padding: '8px 12px', borderRadius: 10,
                background: 'rgba(255,255,255,0.03)', border: `1px solid ${T.border}12`,
                color: T.text, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                textAlign: 'left', transition: 'border-color 0.2s, background 0.2s', overflow: 'hidden',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = `${T.accent}55` }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = `${T.border}12` }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                <span style={{
                  fontSize: 9, padding: '1px 6px', borderRadius: 4, flexShrink: 0,
                  color: badge.color, border: `1px solid ${badge.color}55`, background: `${badge.color}11`,
                }}>{badge.label}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.summary}
                </span>
              </div>
              <div style={{ fontSize: 10, color: T.faint, marginTop: 2 }}>{s.date}</div>
            </button>
            <button
              onClick={(e) => handleDelete(s.id, sTool, e)}
              title="删除此会话"
              style={{
                width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                background: 'none', border: `1px solid ${T.border}12`,
                color: T.dangerText, fontSize: 12, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'background 0.2s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `${T.danger}1f` }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none' }}
            >
              🗑
            </button>
          </div>
        )
      })}
    </div>
  )
}
