import { useState, useRef, useEffect } from 'react'
import type { SessionInfo } from '@shared/types/session'

interface Props {
  onSubmit: (message: string, tool: string) => void
  onClose: () => void
  sessions: SessionInfo[]
}

const TOOLS = [
  { id: 'claude', label: '⚡ Claude' },
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

export default function InputPopup({ onSubmit, onClose, sessions }: Props) {
  const [message, setMessage] = useState('')
  const [tool, setTool] = useState('claude')
  const inputRef = useRef<HTMLInputElement>(null)

  const isSlashAt = message.trimStart().startsWith('/@')
  const afterSlashAt = isSlashAt ? message.trimStart().slice(2) : ''
  const slashAtQuery = afterSlashAt.trimStart()
  const selectingTarget = isSlashAt && (!slashAtQuery || !slashAtQuery.includes(' '))
  const targetQuery = selectingTarget ? slashAtQuery : ''
  const peerSuggestions = sessions
    .filter((s) => s.status !== 'dead')
    .map((s) => s.title.trim())
    .filter((title, idx, arr) => title && arr.indexOf(title) === idx)
    .filter((title) => !targetQuery || title.toLowerCase().includes(targetQuery.toLowerCase()))
    .slice(0, 8)

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

  const applySlashTarget = (target: string) => {
    setMessage(`/@ ${target} `)
    setTimeout(() => inputRef.current?.focus(), 0)
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
      {/* Drag handle */}
      <div data-drag-handle style={{ height: 4, cursor: 'grab' }} />

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

      {selectingTarget && (
        <div style={{
          marginTop: 8,
          borderRadius: 12,
          border: `1px solid ${C.outline}33`,
          background: `${C.container}dd`,
          overflow: 'hidden'
        }}>
          <div style={{ padding: '6px 10px', fontSize: 10, color: C.textDim }}>
            协作命令 · 先选目标
          </div>
          <button
            onClick={() => setMessage('/@peers')}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: '7px 10px',
              border: 'none',
              background: 'transparent',
              color: C.text,
              fontSize: 11,
              cursor: 'pointer'
            }}
          >
            /@peers
          </button>
          <button
            onClick={() => setMessage('/@listen')}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: '7px 10px',
              border: 'none',
              background: 'transparent',
              color: C.text,
              fontSize: 11,
              cursor: 'pointer'
            }}
          >
            /@listen
          </button>
          {peerSuggestions.map((target) => (
            <button
              key={target}
              onClick={() => applySlashTarget(target)}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '7px 10px',
                border: 'none',
                background: 'transparent',
                color: C.text,
                fontSize: 11,
                cursor: 'pointer'
              }}
            >
              @{target}
            </button>
          ))}
        </div>
      )}

      <div style={{ marginTop: 6, fontSize: 9, color: C.textDim, textAlign: 'center', opacity: 0.6 }}>
        Enter 发送 · Esc 取消
      </div>
    </div>
  )
}
