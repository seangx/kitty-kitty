import { useAutoClose } from './useAutoClose'

interface MenuItem { label: string; onClick: () => void; separator?: false }
interface Separator { separator: true }
type MenuEntry = MenuItem | Separator

interface Props { x: number; y: number; onClose: () => void; items: MenuEntry[] }

const C = {
  variant: '#23233f',
  primaryDim: '#645efb',
  text: '#e5e3ff',
  outline: '#46465c',
}

export default function ContextMenu({ x, y, onClose, items }: Props) {
  const ref = useAutoClose(true, onClose)

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed', left: x, top: y, zIndex: 200,
        background: `${C.variant}f0`,
        backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
        borderRadius: 12, padding: '4px 0', minWidth: 140,
        boxShadow: `0 8px 32px rgba(0,0,0,0.5), inset 0 1px 0 ${C.outline}20`,
        fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif"
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => {
        if ('separator' in item && item.separator) {
          return <div key={i} style={{ margin: '3px 8px', borderTop: `1px solid ${C.outline}30` }} />
        }
        const m = item as MenuItem
        return (
          <button
            key={i}
            onClick={() => { m.onClick(); onClose() }}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '6px 12px', fontSize: 12, color: C.text,
              background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit'
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.background = `${C.primaryDim}33` }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'none' }}
          >
            {m.label}
          </button>
        )
      })}
    </div>
  )
}
