import { useState, useEffect, useRef } from 'react'
import { useConfigStore } from '../store/config-store'
import type { BubbleConfig } from '@shared/types/config'

interface Props {
  onClose: () => void
}

const C = {
  variant: '#23233f', container: '#17172f',
  text: '#e5e3ff', textDim: '#aaa8c3',
  primaryDim: '#645efb', outline: '#46465c',
}

const layouts: Array<{ id: BubbleConfig['layout']; emoji: string; label: string }> = [
  { id: 'cloud', emoji: '☁️', label: '云朵' },
  { id: 'arc', emoji: '🌈', label: '弧形' },
  { id: 'stack', emoji: '📚', label: '堆叠' },
]

export default function SettingsPanel({ onClose }: Props) {
  const { bubble, setBubble, resetBubble } = useConfigStore()
  const [paneMode, setPaneMode] = useState(false)
  const [paneModeLoading, setPaneModeLoading] = useState(false)
  const [ntfyTopic, setNtfyTopic] = useState('')
  const ntfyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    window.api.invoke('pane-mode:get').then(setPaneMode).catch(() => {})
    window.api.invoke('ntfy:topic:get').then((t: any) => setNtfyTopic(t || '')).catch(() => {})
  }, [])

  const togglePaneMode = async () => {
    setPaneModeLoading(true)
    try {
      const next = !paneMode
      await window.api.invoke('pane-mode:set', next)
      setPaneMode(next)
    } catch (e) {
      console.error('pane-mode:set failed:', e)
    }
    setPaneModeLoading(false)
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

      {/* Pane Mode Toggle */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 12, color: C.text }}>Pane 模式</div>
            <div style={{ fontSize: 10, color: paneModeLoading ? C.primaryDim : C.textDim, marginTop: 2 }}>
              {paneModeLoading ? '正在切换布局...' : '同组会话合并为分屏窗口'}
            </div>
          </div>
          <button onClick={togglePaneMode} disabled={paneModeLoading}
            style={{
              width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer',
              background: paneMode ? C.primaryDim : `${C.outline}66`,
              position: 'relative', transition: 'background 0.2s',
              opacity: paneModeLoading ? 0.5 : 1,
            }}>
            <div style={{
              width: 16, height: 16, borderRadius: '50%', background: '#fff',
              position: 'absolute', top: 3,
              left: paneMode ? 21 : 3,
              transition: 'left 0.2s',
            }} />
          </button>
        </div>
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

      <div style={{ height: 1, background: `${C.outline}33`, margin: '12px 0' }} />

      {/* Bubble section header */}
      <div style={{ fontSize: 11, color: C.textDim, marginBottom: 8, fontWeight: 500 }}>气泡</div>

      {/* Size */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: C.textDim, marginBottom: 6 }}>大小</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, color: C.textDim }}>A</span>
          <input type="range" min="0.6" max="1.8" step="0.1" value={bubble.sizeScale}
            onChange={(e) => setBubble({ sizeScale: parseFloat(e.target.value) })}
            style={{ flex: 1, accentColor: C.primaryDim }} />
          <span style={{ fontSize: 14, color: C.textDim }}>A</span>
          <span style={{ fontSize: 11, color: C.text, minWidth: 28, textAlign: 'right' }}>{bubble.sizeScale.toFixed(1)}</span>
        </div>
      </div>

      {/* Layout */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: C.textDim, marginBottom: 6 }}>排布</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {layouts.map((l) => (
            <button key={l.id} onClick={() => setBubble({ layout: l.id })}
              style={{
                flex: 1, padding: '8px 4px', borderRadius: 10,
                border: bubble.layout === l.id ? `1px solid ${C.primaryDim}88` : `1px solid ${C.outline}33`,
                background: bubble.layout === l.id ? `${C.primaryDim}22` : `${C.container}88`,
                color: bubble.layout === l.id ? C.text : C.textDim,
                cursor: 'pointer', fontSize: 11, textAlign: 'center', fontFamily: 'inherit',
              }}>
              <div style={{ fontSize: 18 }}>{l.emoji}</div>
              <div style={{ marginTop: 2 }}>{l.label}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Hint */}
      <div style={{ fontSize: 10, color: C.textDim, opacity: 0.7, textAlign: 'center', marginBottom: 8 }}>
        💡 右键单个气泡可修改颜色
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
