import { useState, useRef, useEffect } from 'react'
import type { ToolId } from '../store/config-store'
import { T, btnPrimary, inputWell, popover } from './ui-tokens'

interface Props {
  onSubmit: (message: string, tool: ToolId) => void
  onClose: () => void
  defaultTool?: ToolId
}

const TOOLS: { id: ToolId; label: string }[] = [
  { id: 'claude', label: '⚡ Claude' },
  { id: 'codex',  label: '✦ Codex' },
  { id: 'opencode', label: '◈ OpenCode' },
]

export default function InputPopup({ onSubmit, onClose, defaultTool = 'claude' }: Props) {
  const [message, setMessage] = useState('')
  const [tool, setTool] = useState<ToolId>(defaultTool)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 100)
    return () => clearTimeout(t)
  }, [])

  const handleSubmit = () => {
    const text = message.trim()
    if (!text) return
    onSubmit(text, tool)
    onClose()
  }

  return (
    <div style={{ ...popover({ alpha: 'f0', radius: 16 }), padding: 10, width: 280 }}>
      <div data-drag-handle style={{ height: 4, cursor: 'grab' }} />

      {/* Tool tabs */}
      <div style={{ display: 'flex', gap: 4, padding: '0 2px 6px' }}>
        {TOOLS.map((t) => {
          const active = tool === t.id
          return (
            <button
              key={t.id}
              onClick={() => setTool(t.id)}
              style={{
                flex: 1,
                padding: '5px 8px',
                borderRadius: 8,
                border: `1px solid ${active ? `${T.accent}55` : `${T.border}12`}`,
                background: active ? `${T.accent}1f` : 'rgba(255,255,255,0.03)',
                color: active ? T.accent : T.faint,
                fontSize: 10,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      {/* Input row */}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          ref={inputRef}
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit()
            if (e.key === 'Escape') onClose()
          }}
          placeholder="输入第一句话..."
          style={{ ...inputWell({ radius: 9999 }), flex: 1, padding: '7px 12px' }}
        />
        <button
          onClick={handleSubmit}
          style={{ ...btnPrimary({ radius: 9999 }), padding: '7px 16px' }}
        >
          ▶
        </button>
      </div>

      <div style={{ marginTop: 6, fontSize: 9, color: T.faint, textAlign: 'center', opacity: 0.8 }}>
        Enter 发送 · Esc 取消
      </div>
    </div>
  )
}
