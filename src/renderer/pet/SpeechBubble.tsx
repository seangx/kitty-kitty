import { useEffect, useState } from 'react'
import { T, popover } from './ui-tokens'

interface Props {
  text: string
  duration?: number
  onDone: () => void
  persistent?: boolean
  onClick?: () => void
  accentColor?: string
}

export default function SpeechBubble({ text, duration = 3000, onDone, persistent, onClick, accentColor }: Props) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    if (persistent) return
    const t = setTimeout(() => { setVisible(false); onDone() }, duration)
    return () => clearTimeout(t)
  }, [duration, onDone, persistent])

  if (!visible) return null

  const handleClick = () => {
    if (onClick) onClick()
    setVisible(false)
    onDone()
  }

  return (
    <div
      onClick={persistent ? handleClick : undefined}
      style={{
        ...popover({ alpha: 'ee', radius: 12 }),
        position: 'absolute',
        bottom: '100%',
        left: '50%',
        transform: 'translateX(-50%)',
        marginBottom: 4,
        padding: '6px 12px',
        fontSize: 12,
        whiteSpace: 'nowrap',
        animation: 'fadeInUp 0.3s ease',
        pointerEvents: persistent ? 'auto' : 'none',
        cursor: persistent ? 'pointer' : 'default',
        borderLeft: accentColor ? `3px solid ${accentColor}` : `1px solid ${T.border}14`,
      }}
    >
      {text}
      <style>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateX(-50%) translateY(6px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `}</style>
    </div>
  )
}
