// Shared neutral UI tokens + primitive styles for all pet-window popups.
// Visual direction: macOS-native, neutral surfaces, accent used sparingly —
// aligned with SessionDeck (SessionDeck.css). The legacy "Aether Glass"
// purple palette must not be reintroduced — the exact forbidden hexes are
// guarded by tests/ui-tokens.test.ts.

export const T = {
  // Surfaces (append alpha hex suffixes, e.g. `${T.surface}f5`)
  surface: '#191b27',
  surfaceStrong: '#1e2230',
  well: '#0a0c14',
  // Border channel — always used with an alpha suffix (`${T.border}14`)
  border: '#e0e5f5',
  // Text
  text: '#f4f6ff',
  muted: '#ced3e7',
  faint: '#8f96b0',
  // Accent (matches DEFAULT deckAccentColor; used for selection/primary only)
  accent: '#6fd7c8',
  accentText: '#0c1214',
  // Status
  danger: '#ff6977',
  dangerText: '#ff8e98',
  success: '#72d6a0',
  warning: '#f0b45a',
  info: '#78a9ff',
} as const

export const FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Plus Jakarta Sans", sans-serif'
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'

/** Shared accent swatch presets (bubble colors, group colors, deck accent). */
export const ACCENT_PRESETS = [
  '#6fd7c8',
  '#78a9ff',
  '#a78bfa',
  '#fb7185',
  '#f0b45a',
  '#72d6a0',
]

const SHADOW_POPOVER =
  '0 18px 48px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)'

/** Floating panel / dialog surface (Deck-coordinated glass). */
export function popover(opts?: { alpha?: string; radius?: number }): React.CSSProperties {
  const alpha = opts?.alpha ?? 'f5'
  return {
    background: `${T.surface}${alpha}`,
    backdropFilter: 'blur(28px) saturate(1.08)',
    WebkitBackdropFilter: 'blur(28px) saturate(1.08)',
    border: `1px solid ${T.border}14`,
    borderRadius: opts?.radius ?? 16,
    boxShadow: SHADOW_POPOVER,
    fontFamily: FONT,
    color: T.text,
  }
}

/** Context-menu container. */
export function menuSurface(): React.CSSProperties {
  return {
    background: `${T.surface}f0`,
    backdropFilter: 'blur(28px)',
    WebkitBackdropFilter: 'blur(28px)',
    border: `1px solid ${T.border}14`,
    borderRadius: 13,
    padding: '4px 0',
    boxShadow: '0 18px 48px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)',
    fontFamily: FONT,
  }
}

export const MENU_ITEM_HOVER = 'rgba(255,255,255,0.08)'

/** Text input / textarea well. */
export function inputWell(opts?: { radius?: number; mono?: boolean }): React.CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    padding: '7px 10px',
    borderRadius: opts?.radius ?? 10,
    border: `1px solid ${T.border}16`,
    background: `${T.well}cc`,
    color: T.text,
    fontSize: 12,
    outline: 'none',
    fontFamily: opts?.mono ? MONO : 'inherit',
  }
}

/** Solid accent button (primary action). */
export function btnPrimary(opts?: { radius?: number }): React.CSSProperties {
  return {
    padding: '7px 16px',
    borderRadius: opts?.radius ?? 10,
    border: 'none',
    background: T.accent,
    color: T.accentText,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  }
}

/** Quiet bordered button (secondary action). */
export function btnGhost(opts?: { radius?: number }): React.CSSProperties {
  return {
    padding: '7px 14px',
    borderRadius: opts?.radius ?? 10,
    border: `1px solid ${T.border}14`,
    background: 'rgba(255,255,255,0.04)',
    color: T.muted,
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
  }
}

/** Header close (✕) button. */
export function btnClose(): React.CSSProperties {
  return {
    background: 'none',
    border: 'none',
    color: T.faint,
    cursor: 'pointer',
    fontSize: 16,
    fontFamily: 'inherit',
  }
}

/** Popup header row (drag handle + title + close). */
export function popupHeader(): React.CSSProperties {
  return {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    cursor: 'grab',
  }
}

/** Thin divider between sections. */
export function divider(): React.CSSProperties {
  return { height: 1, background: `${T.border}12`, margin: '12px 0' }
}

/** Small status dot. */
export function statusDot(color: string, size = 8): React.CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }
}
