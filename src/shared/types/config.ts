export interface BubbleConfig {
  sizeScale: number       // 0.5 ~ 2.0, default 1.0
  layout: 'cloud' | 'arc' | 'stack'  // cloud=organic scatter, arc=弧形, stack=堆叠
  colorTheme: 'indigo' | 'emerald' | 'rose' | 'amber' | 'custom'
  customColor?: string    // hex color when colorTheme='custom'
  deckAccentColor: string // selected path / drop target accent
  skin: 'calico' | 'sheep' | 'chicken'
}

export const DEFAULT_BUBBLE_CONFIG: BubbleConfig = {
  sizeScale: 1.0,
  layout: 'cloud',
  colorTheme: 'indigo',
  deckAccentColor: '#6fd7c8',
  skin: 'calico',
}

// Bubble accent presets. Keys are stored in user config — never rename.
// Values follow the neutral macOS-native palette (see renderer/pet/ui-tokens.ts);
// `glass` is the neutral popover surface shared by all themes.
export const COLOR_THEMES: Record<string, { primary: string; dim: string; glass: string }> = {
  indigo:  { primary: '#8ab8ff', dim: '#5b93f0', glass: '#191b27' },
  emerald: { primary: '#7dd8b0', dim: '#4fae8d', glass: '#191b27' },
  rose:    { primary: '#f5a3b3', dim: '#e0607a', glass: '#191b27' },
  amber:   { primary: '#eec96e', dim: '#d19a3f', glass: '#191b27' },
}
