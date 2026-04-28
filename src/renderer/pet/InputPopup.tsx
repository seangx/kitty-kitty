import { useState, useRef, useEffect } from 'react'
import type { ToolId } from '../store/config-store'

interface Props {
  onSubmit: (message: string, tool: ToolId) => void
  onClose: () => void
  defaultTool?: ToolId
}

const TOOLS: { id: ToolId; label: string }[] = [
  { id: 'claude', label: '⚡ Claude' },
  { id: 'codex',  label: '✦ Codex' },
]

// Aether Glass tokens
const C = {
  surface: '#0c0c1f',
  container: '#17172f',
  variant: '#23233f',
  primary: '#a7a5ff',
  primaryDim: '#645efb',
  text: '#e5e3ff',
  textDim: '#aaa8c3',
  outline: '#46465c',
}

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
    <div style={{
      background: `${C.variant}99`,
      backdropFilter: 'blur(32px)',
      WebkitBackdropFilter: 'blur(32px)',
      borderRadius: 16,
      padding: 10,
      width: 280,
      boxShadow: `0 10px 40px rgba(0,0,0,0.5), inset 0 1px 0 ${C.outline}26`,
      fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif"
    }}>
      <div data-drag-handle style={{ height: 4, cursor: 'grab' }} />

      {/* Tool tabs */}
      <div style={{ display: 'flex', gap: 4, padding: '0 2px 6px' }}>
        {TOOLS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTool(t.id)}
            style={{
              flex: 1,
              padding: '5px 8px',
              borderRadius: 9999,
              border: 'none',
              background: tool === t.id ? `${C.primaryDim}cc` : `${C.container}80`,
              color: tool === t.id ? C.surface : C.textDim,
              fontSize: 10,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t.label}
          </button>
        ))}
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
          style={{
            flex: 1,
            padding: '7px 12px',
            borderRadius: 9999,
            border: `1px solid ${C.outline}33`,
            background: `${C.container}cc`,
            color: C.text,
            fontSize: 12,
            outline: 'none',
            fontFamily: 'inherit'
          }}
        />
        <button
          onClick={handleSubmit}
          style={{
            padding: '7px 16px',
            borderRadius: 9999,
            border: 'none',
            background: `linear-gradient(135deg, ${C.primary}, ${C.primaryDim})`,
            color: C.surface,
            fontSize: 12,
            cursor: 'pointer',
            fontWeight: 600
          }}
        >
          ▶
        </button>
      </div>

      <div style={{ marginTop: 6, fontSize: 9, color: C.textDim, textAlign: 'center', opacity: 0.6 }}>
        Enter 发送 · Esc 取消
      </div>
    </div>
  )
}
