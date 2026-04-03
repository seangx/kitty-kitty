import { create } from 'zustand'
import type { BubbleConfig } from '@shared/types/config'
import { DEFAULT_BUBBLE_CONFIG } from '@shared/types/config'

interface ConfigState {
  bubble: BubbleConfig
  setBubble: (updates: Partial<BubbleConfig>) => void
  resetBubble: () => void
}

// Load from localStorage
function loadConfig(): BubbleConfig {
  try {
    const saved = localStorage.getItem('kitty-bubble-config')
    if (saved) return { ...DEFAULT_BUBBLE_CONFIG, ...JSON.parse(saved) }
  } catch {}
  return DEFAULT_BUBBLE_CONFIG
}

function saveConfig(config: BubbleConfig) {
  localStorage.setItem('kitty-bubble-config', JSON.stringify(config))
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  bubble: loadConfig(),

  setBubble: (updates) => {
    const next = { ...get().bubble, ...updates }
    saveConfig(next)
    set({ bubble: next })
  },

  resetBubble: () => {
    saveConfig(DEFAULT_BUBBLE_CONFIG)
    set({ bubble: DEFAULT_BUBBLE_CONFIG })
  }
}))
