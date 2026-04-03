import { useEffect, useRef } from 'react'

/**
 * Auto-close a popup/menu when the mouse moves away from it.
 * Works even when the element renders directly under the cursor
 * (where mouseenter/mouseleave won't fire on first exit).
 */
export function useAutoClose(
  open: boolean,
  onClose: () => void,
  padding = 8 // extra pixels of tolerance around the element
) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    let active = false

    // Small delay so the menu fully renders and we skip the opening right-click
    const timer = setTimeout(() => {
      active = true
    }, 200)

    const onMove = (e: PointerEvent) => {
      if (!active || !ref.current) return
      const rect = ref.current.getBoundingClientRect()
      const outside =
        e.clientX < rect.left - padding ||
        e.clientX > rect.right + padding ||
        e.clientY < rect.top - padding ||
        e.clientY > rect.bottom + padding

      if (outside) {
        onClose()
      }
    }

    document.addEventListener('pointermove', onMove)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointermove', onMove)
    }
  }, [open, onClose, padding])

  return ref
}
