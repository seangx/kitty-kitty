import { useState, useEffect, useRef } from 'react'
import { useConfigStore } from '../store/config-store'

interface Props {
  onClose: () => void
}

const C = {
  variant: '#23233f', container: '#17172f',
  text: '#e5e3ff', textDim: '#aaa8c3',
  primaryDim: '#645efb', outline: '#46465c',
}

const DECK_ACCENT_PRESETS = ['#6fd7c8', '#78a9ff', '#a78bfa', '#fb7185', '#f0b45a']

interface ArchivedGroup {
  id: string
  name: string
  color: string | null
  sessionCount: number
}

export default function SettingsPanel({ onClose }: Props) {
  const { bubble, setBubble, resetBubble } = useConfigStore()
  const [ntfyTopic, setNtfyTopic] = useState('')
  const [codexHiveBridge, setCodexHiveBridgeState] = useState(false)
  const [archivedGroups, setArchivedGroups] = useState<ArchivedGroup[]>([])
  const ntfyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadArchived = () => {
    window.api.invoke('group:list-archived').then((g: any) => setArchivedGroups(g || [])).catch(() => {})
  }

  useEffect(() => {
    window.api.invoke('ntfy:topic:get').then((t: any) => setNtfyTopic(t || '')).catch(() => {})
    window.api.invoke('config:codex-hive-bridge:get').then((v: any) => setCodexHiveBridgeState(!!v)).catch(() => {})
    loadArchived()
  }, [])

  const handleUnarchive = async (id: string) => {
    try {
      await window.api.invoke('group:unarchive', id)
      loadArchived()
    } catch (e) {
      console.error('unarchive failed:', e)
    }
  }

  return (
    <div style={{
      background: `${C.variant}f5`, backdropFilter: 'blur(32px)', WebkitBackdropFilter: 'blur(32px)',
      borderRadius: 16, padding: 16, width: 260,
      boxShadow: `0 12px 48px rgba(0,0,0,0.6), inset 0 1px 0 ${C.outline}20`,
      fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", color: C.text,
    }}>
      <div data-drag-handle style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, cursor: 'grab' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>⚙️ 设置</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textDim, cursor: 'pointer', fontSize: 16 }}>✕</button>
      </div>

      {/* Ntfy notification */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: C.text, marginBottom: 4 }}>通知</div>
        <input
          type="text"
          placeholder="ntfy topic"
          value={ntfyTopic}
          onChange={(e) => {
            const v = e.target.value
            setNtfyTopic(v)
            if (ntfyTimer.current) clearTimeout(ntfyTimer.current)
            ntfyTimer.current = setTimeout(() => {
              window.api.invoke('ntfy:topic:set', v.trim())
            }, 1000)
          }}
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: '6px 10px', borderRadius: 8,
            border: `1px solid ${C.outline}55`,
            background: `${C.container}aa`,
            color: C.text, fontSize: 12,
            fontFamily: 'inherit', outline: 'none',
          }}
        />
        <div style={{ fontSize: 10, color: C.textDim, marginTop: 3 }}>
          ntfy.sh 推送主题，留空关闭
        </div>
      </div>

      {/* Codex hive bridge (path B) */}
      <div style={{ marginBottom: 14 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={codexHiveBridge}
            onChange={(e) => {
              const v = e.target.checked
              setCodexHiveBridgeState(v)
              window.api.invoke('config:codex-hive-bridge:set', v).catch(() => {})
            }}
            style={{ accentColor: C.primaryDim }}
          />
          <span style={{ fontSize: 12, color: C.text }}>Codex 走 hive 联动</span>
          <span style={{ fontSize: 9, color: '#fcd34d', border: '1px solid #fcd34d55', borderRadius: 4, padding: '0 4px' }}>实验</span>
        </label>
        <div style={{ fontSize: 10, color: C.textDim, marginTop: 3, marginLeft: 22 }}>
          codex 新建会话用 <code>codex --remote</code> 接到 kitty-hive 的 daemon，可接收 hive 推送
        </div>
      </div>

      {/* Archived groups */}
      {archivedGroups.length > 0 && (
        <>
          <div style={{ height: 1, background: `${C.outline}33`, margin: '12px 0' }} />
          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 8, fontWeight: 500 }}>📦 已归档 ({archivedGroups.length})</div>
          <div style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {archivedGroups.map((g) => (
              <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: g.color || C.primaryDim, flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {g.name}
                  <span style={{ fontSize: 10, color: C.textDim, marginLeft: 6 }}>{g.sessionCount} 会话</span>
                </span>
                <button onClick={() => handleUnarchive(g.id)}
                  style={{ padding: '2px 10px', borderRadius: 9999, background: `${C.container}aa`, border: `1px solid ${C.outline}33`, color: C.text, fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}>
                  恢复
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <div style={{ height: 1, background: `${C.outline}33`, margin: '12px 0' }} />

      {/* Deck section header */}
      <div style={{ fontSize: 11, color: C.textDim, marginBottom: 8, fontWeight: 500 }}>Deck</div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: C.textDim, marginBottom: 7 }}>选中颜色</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="color"
            value={bubble.deckAccentColor}
            onChange={(e) => setBubble({ deckAccentColor: e.target.value })}
            aria-label="Deck 选中颜色"
            style={{ width: 32, height: 26, padding: 0, border: `1px solid ${C.outline}55`, borderRadius: 7, background: 'transparent', cursor: 'pointer' }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            {DECK_ACCENT_PRESETS.map((color) => (
              <button
                key={color}
                onClick={() => setBubble({ deckAccentColor: color })}
                aria-label={`选择 ${color}`}
                style={{
                  width: 20, height: 20, borderRadius: '50%', background: color, cursor: 'pointer',
                  border: bubble.deckAccentColor === color ? '2px solid #fff' : '1px solid rgba(255,255,255,.22)',
                  boxShadow: bubble.deckAccentColor === color ? `0 0 0 2px ${color}55` : 'none',
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <div style={{ textAlign: 'center' }}>
        <button onClick={resetBubble}
          style={{ padding: '4px 14px', borderRadius: 9999, background: `${C.container}aa`, border: `1px solid ${C.outline}33`, color: C.textDim, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>
          恢复默认
        </button>
      </div>
    </div>
  )
}
