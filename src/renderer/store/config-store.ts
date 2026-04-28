import { create } from 'zustand'
import type { BubbleConfig } from '@shared/types/config'
import { DEFAULT_BUBBLE_CONFIG } from '@shared/types/config'

export type ToolId = 'claude' | 'codex'
const VALID_TOOLS: ToolId[] = ['claude', 'codex']

interface ConfigState {
  bubble: BubbleConfig
  setBubble: (updates: Partial<BubbleConfig>) => void
  resetBubble: () => void

  lastTool: ToolId
  setLastTool: (tool: ToolId) => void
}

// Load from localStorage
function loadConfig(): BubbleConfig {
  const VALID_SKINS: BubbleConfig['skin'][] = ['calico', 'sheep', 'chicken']
  try {
    const saved = localStorage.getItem('kitty-bubble-config')
    if (saved) {
      const parsed = { ...DEFAULT_BUBBLE_CONFIG, ...JSON.parse(saved) }
      if (!VALID_SKINS.includes(parsed.skin)) parsed.skin = DEFAULT_BUBBLE_CONFIG.skin
      return parsed
    }
  } catch {}
  return DEFAULT_BUBBLE_CONFIG
}

function saveConfig(config: BubbleConfig) {
  localStorage.setItem('kitty-bubble-config', JSON.stringify(config))
}

function loadLastTool(): ToolId {
  try {
    const saved = localStorage.getItem('kitty-last-tool')
    if (saved && (VALID_TOOLS as string[]).includes(saved)) return saved as ToolId
  } catch {}
  return 'claude'
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
  },

  lastTool: loadLastTool(),
  setLastTool: (tool) => {
    try { localStorage.setItem('kitty-last-tool', tool) } catch {}
    set({ lastTool: tool })
  },
}))
