import { useCallback, useEffect, useRef, useState } from 'react'
import SkillsPanel from './SkillsPanel'
import SettingsPanel from './SettingsPanel'

interface Props {
  type: string
  params: string
}

const BASE_WIDTH = 480 // design baseline width

export default function PopupRouter({ type, params }: Props) {
  const dragOff = useRef({ x: 0, y: 0 })
  const [scale, setScale] = useState(1)

  // Recalculate scale when window resizes
  useEffect(() => {
    const update = () => setScale(window.innerWidth / BASE_WIDTH)
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  const onClose = useCallback(() => {
    window.api.invoke('popup-close')
  }, [])

  // Drag the whole window via title bar
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (!(e.target as HTMLElement).closest('[data-drag-handle]')) return
    e.preventDefault()
    dragOff.current = { x: e.screenX, y: e.screenY }
    const onMove = (ev: MouseEvent) => {
      const dx = ev.screenX - dragOff.current.x
      const dy = ev.screenY - dragOff.current.y
      if (dx || dy) {
        window.api.invoke('move-popup', dx, dy)
        dragOff.current = { x: ev.screenX, y: ev.screenY }
      }
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  const noop = () => {}

  return (
    <div
      style={{ width: '100%', height: '100%', overflow: 'auto', zoom: scale }}
      onMouseDown={onMouseDown}
    >
      {type === 'skills' && (
        <div style={{ width: '100%', height: '100%' }} className="popup-skills-override">
          <SkillsPanel
            sessionId={params}
            onClose={onClose}
            onSay={noop}
            onDance={noop}
          />
        </div>
      )}
      {type === 'settings' && (
        <SettingsPanel onClose={onClose} />
      )}
    </div>
  )
}
