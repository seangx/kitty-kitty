import { useState, useRef, useEffect } from 'react'
import type { SessionInfo } from '@shared/types/session'

interface Props {
  session: SessionInfo
  onSave: (roles: string, expertise: string) => void
  onClose: () => void
}

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

const EXPERTISE_LIMIT = 500

function normalizeRoles(input: string): string {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',')
}

export default function AgentMetadataPopup({ session, onSave, onClose }: Props) {
  const [roles, setRoles] = useState(session.roles || '')
  const [expertise, setExpertise] = useState(session.expertise || '')
  const rolesRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(() => rolesRef.current?.focus(), 100)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSave = () => {
    onSave(normalizeRoles(roles), expertise.trim())
  }

  const handleExpertiseChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value
    if (v.length <= EXPERTISE_LIMIT) setExpertise(v)
  }

  return (
    <div
      style={{
        background: `${C.variant}f5`,
        backdropFilter: 'blur(32px)',
        WebkitBackdropFilter: 'blur(32px)',
        borderRadius: 16,
        padding: 14,
        width: 320,
        boxShadow: `0 12px 48px rgba(0,0,0,0.6), inset 0 1px 0 ${C.outline}20`,
        fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
        color: C.text,
      }}
    >
      {/* Header */}
      <div
        data-drag-handle
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
          cursor: 'grab',
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600 }}>
          🏷 角色 · {session.title}
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: C.textDim,
            cursor: 'pointer',
            fontSize: 16,
          }}
        >
          ✕
        </button>
      </div>

      {/* Roles */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4 }}>角色标签（逗号分隔）</div>
        <input
          ref={rolesRef}
          type="text"
          value={roles}
          onChange={(e) => setRoles(e.target.value)}
          placeholder="ux, frontend, design"
          style={{
            width: '100%',
            padding: '7px 12px',
            borderRadius: 9999,
            border: `1px solid ${C.outline}33`,
            background: `${C.container}cc`,
            color: C.text,
            fontSize: 12,
            outline: 'none',
            fontFamily: 'inherit',
            boxSizing: 'border-box',
          }}
        />
      </div>

      {/* Expertise */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4 }}>专长描述</div>
        <textarea
          value={expertise}
          onChange={handleExpertiseChange}
          placeholder="负责设计系统和交互原型..."
          rows={4}
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: 12,
            border: `1px solid ${C.outline}33`,
            background: `${C.container}cc`,
            color: C.text,
            fontSize: 12,
            outline: 'none',
            fontFamily: 'inherit',
            resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />
        <div
          style={{
            fontSize: 10,
            color: C.textDim,
            textAlign: 'right',
            marginTop: 2,
          }}
        >
          {expertise.length} / {EXPERTISE_LIMIT}
        </div>
      </div>

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          onClick={onClose}
          style={{
            padding: '6px 16px',
            borderRadius: 9999,
            border: `1px solid ${C.outline}44`,
            background: 'transparent',
            color: C.textDim,
            fontSize: 12,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          取消
        </button>
        <button
          onClick={handleSave}
          style={{
            padding: '6px 18px',
            borderRadius: 9999,
            border: 'none',
            background: `linear-gradient(135deg, ${C.primary}, ${C.primaryDim})`,
            color: C.surface,
            fontSize: 12,
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontWeight: 600,
          }}
        >
          保存
        </button>
      </div>
    </div>
  )
}
