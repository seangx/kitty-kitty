import { useEffect } from 'react'
import PetCanvas from './pet/PetCanvas'

export default function App() {
  useEffect(() => {
    document.body.className = 'pet-mode'
  }, [])

  return <PetCanvas />
}
