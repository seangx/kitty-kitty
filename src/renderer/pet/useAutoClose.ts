import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { isPointerOutsideSafeCorridor } from './auto-close-geometry'

/**
 * Auto-close a popup/menu when the mouse moves away from it.
 * Works even when the element renders directly under the cursor
 * (where mouseenter/mouseleave won't fire on first exit).
 */
export function useAutoClose(
  open: boolean,
  onClose: () => void,
  padding = 8, // extra pixels of tolerance around the element
  anchorRef?: RefObject<HTMLElement | null>,
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
      const rects = [ref.current.getBoundingClientRect()]
      if (anchorRef?.current) rects.push(anchorRef.current.getBoundingClientRect())
      const outside = isPointerOutsideSafeCorridor(e.clientX, e.clientY, rects, padding)

      if (outside) {
        onClose()
      }
    }

    document.addEventListener('pointermove', onMove)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointermove', onMove)
    }
  }, [anchorRef, open, onClose, padding])

  return ref
}
