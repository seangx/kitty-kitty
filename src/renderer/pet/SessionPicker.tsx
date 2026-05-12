import { useState } from 'react'

interface ExternalSession {
  id: string
  summary: string
  date: string
  tool?: string
}

export type PickAction =
  | { type: 'new'; tool: string }
  | { type: 'continue-latest'; tool: string }
  | { type: 'resume'; tool: string; id: string }

interface Props {
  dir: string
  defaultTool: string  // used for "新建" / "继续最近" buttons; per-row resume uses entry.tool
  sessions: ExternalSession[]
  onPick: (action: PickAction) => void
  onClose: () => void
}

const C = {
  variant: '#23233f', container: '#17172f',
  text: '#e5e3ff', textDim: '#aaa8c3',
  primaryDim: '#645efb', primary: '#a7a5ff', outline: '#46465c',
}

const TOOL_BADGE: Record<string, { label: string; color: string }> = {
  claude: { label: '⚡ Claude', color: '#a7a5ff' },
  codex:  { label: '✦ Codex',  color: '#fcd34d' },
}

export default function SessionPicker({ dir, defaultTool, sessions: initialSessions, onPick, onClose }: Props) {
  const dirName = dir.split('/').pop() || dir
  const [sessions, setSessions] = useState(initialSessions)

  const handleDelete = async (id: string, tool: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await window.api.invoke('session:delete-external-session', tool, dir, id)
      setSessions((prev) => prev.filter((s) => s.id !== id))
    } catch (err) {
      console.error('Failed to delete session:', err)
    }
  }

  return (
    <div style={{
      background: `${C.variant}f5`, backdropFilter: 'blur(32px)', WebkitBackdropFilter: 'blur(32px)',
      borderRadius: 16, padding: 14, width: 320, maxHeight: 420, overflow: 'auto',
      boxShadow: `0 12px 48px rgba(0,0,0,0.6), inset 0 1px 0 ${C.outline}20`,
      fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", color: C.text,
    }}>
      <div data-drag-handle style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, cursor: 'grab' }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>📂 {dirName}</div>
          <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>
            选择继续或新建 · 默认工具 {TOOL_BADGE[defaultTool]?.label || defaultTool}
          </div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textDim, cursor: 'pointer', fontSize: 14 }}>✕</button>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <button
          onClick={() => onPick({ type: 'new', tool: defaultTool })}
          style={{
            flex: 1, padding: '8px 12px', borderRadius: 10,
            background: `${C.container}cc`, border: `1px solid ${C.outline}44`,
            color: C.text, fontSize: 12, fontWeight: 600,
            cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center',
          }}
        >
          🆕 新建
        </button>
        <button
          onClick={() => onPick({ type: 'continue-latest', tool: defaultTool })}
          style={{
            flex: 1, padding: '8px 12px', borderRadius: 10,
            background: `linear-gradient(135deg, ${C.primary}, ${C.primaryDim})`,
            border: 'none', color: '#0c0c1f', fontSize: 12, fontWeight: 600,
            cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center',
          }}
        >
          ✨ 继续最近
        </button>
      </div>

      {sessions.length > 0 && (
        <div style={{ fontSize: 10, color: C.textDim, marginTop: 8, marginBottom: 4 }}>指定会话恢复：</div>
      )}
      {sessions.map((s) => {
        const sTool = s.tool || defaultTool
        const badge = TOOL_BADGE[sTool] || { label: sTool, color: C.textDim }
        return (
          <div key={`${sTool}:${s.id}`} style={{
            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4,
          }}>
            <button
              onClick={() => onPick({ type: 'resume', tool: sTool, id: s.id })}
              style={{
                flex: 1, padding: '8px 12px', borderRadius: 10,
                background: `${C.container}cc`, border: `1px solid ${C.outline}33`,
                color: C.text, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                textAlign: 'left', transition: 'all 0.2s', overflow: 'hidden',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = `${C.primaryDim}66` }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = `${C.outline}33` }}
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
              <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>{s.date}</div>
            </button>
            <button
              onClick={(e) => handleDelete(s.id, sTool, e)}
              title="删除此会话"
              style={{
                width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                background: 'none', border: `1px solid ${C.outline}33`,
                color: '#ff6e84', fontSize: 12, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#ff6e8422' }}
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
