import { useEffect, useState } from 'react'

interface Props {
  text: string
  duration?: number
  onDone: () => void
}

export default function SpeechBubble({ text, duration = 3000, onDone }: Props) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => { setVisible(false); onDone() }, duration)
    return () => clearTimeout(t)
  }, [duration, onDone])

  if (!visible) return null

  return (
    <div style={{
      position: 'absolute',
      bottom: '100%',
      left: '50%',
      transform: 'translateX(-50%)',
      marginBottom: 4,
      padding: '6px 12px',
      borderRadius: 12,
      background: '#23233fee',
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
      color: '#e5e3ff',
      fontSize: 12,
      fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
      whiteSpace: 'nowrap',
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
      animation: 'fadeInUp 0.3s ease',
      pointerEvents: 'none',
    }}>
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
