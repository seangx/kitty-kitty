import { useState, useRef, useEffect } from 'react'
import type { SessionInfo } from '@shared/types/session'
import { T, btnClose, btnGhost, btnPrimary, inputWell, popover, popupHeader } from './ui-tokens'

interface Props {
  session: SessionInfo
  onSave: (roles: string, expertise: string) => void
  onClose: () => void
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
    <div style={{ ...popover({ alpha: 'f5', radius: 16 }), padding: 14, width: 320 }}>
      {/* Header */}
      <div data-drag-handle style={popupHeader()}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>
          🏷 角色 · {session.title}
        </span>
        <button onClick={onClose} style={btnClose()}>
          ✕
        </button>
      </div>

      {/* Roles */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: T.faint, marginBottom: 4 }}>角色标签（逗号分隔）</div>
        <input
          ref={rolesRef}
          type="text"
          value={roles}
          onChange={(e) => setRoles(e.target.value)}
          placeholder="ux, frontend, design"
          style={inputWell()}
        />
      </div>

      {/* Expertise */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: T.faint, marginBottom: 4 }}>专长描述</div>
        <textarea
          value={expertise}
          onChange={handleExpertiseChange}
          placeholder="负责设计系统和交互原型..."
          rows={4}
          style={{ ...inputWell(), padding: '8px 12px', resize: 'vertical' }}
        />
        <div
          style={{
            fontSize: 10,
            color: T.faint,
            textAlign: 'right',
            marginTop: 2,
          }}
        >
          {expertise.length} / {EXPERTISE_LIMIT}
        </div>
      </div>

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={btnGhost()}>
          取消
        </button>
        <button onClick={handleSave} style={{ ...btnPrimary(), padding: '6px 18px' }}>
          保存
        </button>
      </div>
    </div>
  )
}
