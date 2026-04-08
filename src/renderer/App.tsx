import { useEffect, useState } from 'react'
import PetCanvas from './pet/PetCanvas'
import PopupRouter from './pet/PopupRouter'

export default function App() {
  const [popupInfo, setPopupInfo] = useState<{ type: string; params: string } | null>(null)

  useEffect(() => {
    const hash = window.location.hash
    // #popup/skills/sessionId
    const match = hash.match(/^#popup\/(\w+)\/(.+)$/)
    if (match) {
      setPopupInfo({ type: match[1], params: decodeURIComponent(match[2]) })
      document.body.className = 'popup-mode'
    } else {
      document.body.className = 'pet-mode'
    }
  }, [])

  if (popupInfo) {
    return <PopupRouter type={popupInfo.type} params={popupInfo.params} />
  }

  return <PetCanvas />
}
