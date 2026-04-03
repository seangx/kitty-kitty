import { useRef, useCallback } from 'react'

export function useDraggable() {
  const pos = useRef({ x: 0, y: 0 })
  const offset = useRef({ x: 0, y: 0 })
  const dragging = useRef(false)
  const elRef = useRef<HTMLDivElement | null>(null)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // Only drag from the header area (first child or element with data-drag-handle)
    const target = e.target as HTMLElement
    if (!target.closest('[data-drag-handle]')) return

    dragging.current = true
    const el = elRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    offset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current || !elRef.current) return
      const x = ev.clientX - offset.current.x
      const y = ev.clientY - offset.current.y
      elRef.current.style.left = `${x}px`
      elRef.current.style.top = `${y}px`
      elRef.current.style.transform = 'none'
      pos.current = { x, y }
    }

    const onUp = () => {
      dragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  return { elRef, onMouseDown }
}
