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

  return (
    <div style={{
      background: `${C.variant}f5`, backdropFilter: 'blur(32px)', WebkitBackdropFilter: 'blur(32px)',
      borderRadius: 16, padding: 16, width: 260,
      boxShadow: `0 12px 48px rgba(0,0,0,0.6), inset 0 1px 0 ${C.outline}20`,
      fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", color: C.text,
    }}>
      <div data-drag-handle style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, cursor: 'grab' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>⚙️ 气泡设置</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textDim, cursor: 'pointer', fontSize: 16 }}>✕</button>
      </div>

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
