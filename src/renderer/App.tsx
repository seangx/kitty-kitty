import { useEffect, useState } from 'react'
import PetCanvas from './pet/PetCanvas'
import PopupRouter from './pet/PopupRouter'
import CompletionNotifications from './completion/CompletionNotifications'

export default function App() {
  const [popupInfo, setPopupInfo] = useState<{ type: string; params: string } | null>(null)
  const [completionMode] = useState(() => window.location.hash === '#completion-notifications')

  useEffect(() => {
    const hash = window.location.hash
    if (hash === '#completion-notifications') {
      document.body.className = 'completion-notification-mode'
      return
    }
    // #popup/skills/sessionId
    const match = hash.match(/^#popup\/(\w+)\/(.+)$/)
    if (match) {
      setPopupInfo({ type: match[1], params: decodeURIComponent(match[2]) })
      document.body.className = 'popup-mode'
    } else {
      document.body.className = 'pet-mode'
    }
  }, [])

  if (completionMode) return <CompletionNotifications />

  if (popupInfo) {
    return <PopupRouter type={popupInfo.type} params={popupInfo.params} />
  }

  return <PetCanvas />
}
