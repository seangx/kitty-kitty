import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAutoClose } from './useAutoClose'
import { clampMenuPosition } from './menu-position'
import { MENU_ITEM_HOVER, T, menuSurface } from './ui-tokens'

interface MenuItem { label: string; onClick: () => void; separator?: false }
interface Separator { separator: true }
type MenuEntry = MenuItem | Separator

interface Props { x: number; y: number; onClose: () => void; items: MenuEntry[] }

export default function ContextMenu({ x, y, onClose, items }: Props) {
  const autoCloseRef = useAutoClose(true, onClose)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  const reposition = useCallback(() => {
    const menu = menuRef.current
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    setPosition(clampMenuPosition(
      x,
      y,
      rect.width,
      rect.height,
      window.innerWidth,
      window.innerHeight,
      8,
    ))
  }, [x, y])
  const setRef = useCallback((node: HTMLDivElement | null) => {
    ;(autoCloseRef as React.MutableRefObject<HTMLDivElement | null>).current = node
    menuRef.current = node
  }, [autoCloseRef])

  useLayoutEffect(reposition, [reposition])
  useEffect(() => {
    const menu = menuRef.current
    const observer = menu ? new ResizeObserver(reposition) : null
    if (menu) observer?.observe(menu)
    window.addEventListener('resize', reposition)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', reposition)
    }
  }, [reposition])

  return (
    <div
      ref={setRef}
      className="pet-context-menu"
      style={{
        ...menuSurface(),
        position: 'fixed', ...position, zIndex: 200,
        minWidth: 140, whiteSpace: 'nowrap',
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => {
        if ('separator' in item && item.separator) {
          return <div key={i} style={{ margin: '3px 8px', borderTop: `1px solid ${T.border}12` }} />
        }
        const m = item as MenuItem
        return (
          <button
            key={i}
            onClick={() => { m.onClick(); onClose() }}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '6px 12px', fontSize: 12, color: T.text,
              background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit'
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.background = MENU_ITEM_HOVER }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'none' }}
          >
            {m.label}
          </button>
        )
      })}
    </div>
  )
}
