export interface BubbleConfig {
  sizeScale: number       // 0.5 ~ 2.0, default 1.0
  layout: 'cloud' | 'arc' | 'stack'  // cloud=organic scatter, arc=弧形, stack=堆叠
  colorTheme: 'indigo' | 'emerald' | 'rose' | 'amber' | 'custom'
  customColor?: string    // hex color when colorTheme='custom'
  skin: 'classic' | 'neko' | 'ghost' | 'robot' | 'bunny'
}

export const DEFAULT_BUBBLE_CONFIG: BubbleConfig = {
  sizeScale: 1.0,
  layout: 'cloud',
  colorTheme: 'indigo',
  skin: 'classic',
}

export const COLOR_THEMES: Record<string, { primary: string; dim: string; glass: string }> = {
  indigo:  { primary: '#a7a5ff', dim: '#645efb', glass: '#23233f' },
  emerald: { primary: '#6ee7b7', dim: '#10b981', glass: '#1a2f2a' },
  rose:    { primary: '#fda4af', dim: '#e11d48', glass: '#2f1a23' },
  amber:   { primary: '#fcd34d', dim: '#d97706', glass: '#2f2a1a' },
}
