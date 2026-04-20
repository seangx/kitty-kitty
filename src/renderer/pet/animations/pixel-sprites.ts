import type { AnimationState, SkinId } from '@shared/types/pet'

/**
 * Pixel cat — front-facing head on a sitting body, 16×16 grid.
 *
 * Character codes:
 *   . = transparent
 *   K = outline
 *   O = main body color
 *   D = shadow / stripes
 *   B = secondary body (calico patches)
 *   P = pink (inner ear / nose)
 *   g = open eye
 *   w = white / closed eye
 *   y = yellow (sleep Z)
 */

export type Palette = Record<string, string>

export const PIXEL_PALETTES: Record<SkinId, Palette> = {
  calico:  { K: '#2a2a2a', O: '#ffffff', D: '#1a1a1a', B: '#e8883c', P: '#ff9eb5', g: '#6ed068', w: '#ffffff', y: '#f7c82c' },
  sheep:   { K: '#2a2a2a', O: '#f5f5fa', D: '#d0d0dc', B: '#e8d0a8', P: '#ff9eb5', g: '#2a2a2a', w: '#ffffff', y: '#f7c82c' },
  chicken: { K: '#2a2a2a', O: '#fcd34d', D: '#fbbf24', B: '#f97316', P: '#ff9eb5', g: '#2a2a2a', w: '#ffffff', y: '#f7c82c' },
}

export interface PixelFrame { rows: string[] }
export interface PixelSpriteConfig { frames: PixelFrame[]; intervalMs: number }

// ─── Base: front-facing head + sitting body with tail and legs ─────────
// 16×16 grid. Upper half: round head (2 ears, 2 eyes, pink nose).
// Lower half: sitting body, tail curling up on the right, 2 front legs.

function face(eyeL: string, eyeR: string, mouthL: string = 'K', mouthR: string = 'K'): PixelFrame {
  return {
    rows: [
      '..KK........KK..',
      '.KOOK......KOOK.',
      '.KPOOK....KOOPK.',
      `KO${eyeL}OOKKKKKKOO${eyeR}OK`,
      'KOOOOOOOOOOOOOOK',
      'KOOOOOKPPKOOOOOK',
      `.KOOOO${mouthL}${mouthR}OOOOOK.`,
      '.KKOOOOOOOOOOKK.',
      '..KOOOOOOOOOOK..',
      '..KOOOOOOOOOOKK.',
      '..KOOOOOOOOOOOK.',
      '..KKOOOOOOOOOKK.',
      '...KKKOOOOOOKK..',
      '...KOKKKKKKOK...',
      '...KOK....KOK...',
      '...KKK....KKK...',
    ],
  }
}

const IDLE_OPEN = face('g', 'g')              // both eyes open
const IDLE_HALF = face('K', 'K')              // both eyes squinted (horizontal line via outline color)
const HAPPY_FRAME = face('w', 'w', 'w', 'w')  // ^ ^ eyes closed + smile
const SAD_FRAME = face('g', 'g', 'K', 'K')    // same base, frown added below via row override
const THINK_FRAME = face('g', 'g')            // + ? overlay
const LICK_FRAME = face('g', 'g', 'P', 'P')   // tongue out
const SLEEP_FRAME_FACE = face('w', 'w')       // closed eyes

// Modify SAD frame to have a downturned mouth on row 7
const SAD: PixelFrame = {
  rows: SAD_FRAME.rows.map((r, i) => {
    if (i === 7) return '.KKOOKKKKKKOOKK.'
    return r
  }),
}

// SLEEP: closed eyes, sleep Z drawn in pixels on the right
const SLEEP: PixelFrame = {
  rows: [
    '..KK........KK..',
    '.KOOK......KOOK.',
    '.KPOOK....KOOPK.',
    'KOwwOKKKKKKOwwOK',
    'KOOOOOOOOOOOOOOK',
    'KOOOOOKPPKOOOOOK',
    '.KOOOOOKKOOOOOK.',
    '.KKOOOOOOOOOOKK.',
    '..KOOOOOOOOOOK..',
    '..KOOOOOOOOOOKK.',
    '..KOOOOOOOOOOOK.',
    '..KKOOOOOOOOOKK.',
    '...KKKOOOOOOKK..',
    '...KOKKKKKKOK...',
    '...KOK....KOK...',
    '...KKK....KKK...',
  ],
}

// THINK — just half-open eyes (subtle)
const THINK: PixelFrame = {
  rows: [
    '..KK........KK..',
    '.KOOK......KOOK.',
    '.KPOOK....KOOPK.',
    'KOKOOKKKKKKOOKOK',
    'KOOOOOOOOOOOOOOK',
    'KOOOOOKPPKOOOOOK',
    '.KOOOOOKKOOOOOK.',
    '.KKOOOOOOOOOOKK.',
    '..KOOOOOOOOOOK..',
    '..KOOOOOOOOOOKK.',
    '..KOOOOOOOOOOOK.',
    '..KKOOOOOOOOOKK.',
    '...KKKOOOOOOKK..',
    '...KOKKKKKKOK...',
    '...KOK....KOK...',
    '...KKK....KKK...',
  ],
}

// JUMP: body shifted up
const JUMP: PixelFrame = {
  rows: [
    '................',
    '..KK........KK..',
    '.KOOK......KOOK.',
    '.KPOOK....KOOPK.',
    'KOgOOKKKKKKOOgOK',
    'KOOOOOOOOOOOOOOK',
    'KOOOOOKPPKOOOOOK',
    '.KOOOOOKKOOOOOK.',
    '.KKOOOOOOOOOOKK.',
    '..KOOOOOOOOOOK..',
    '..KOOOOOOOOOOKK.',
    '..KKOOOOOOOOOKK.',
    '...KKOOOOOOOKK..',
    '....KKKKKKKKK...',
    '................',
    '................',
  ],
}

// STRETCH: body elongated forward
const STRETCH: PixelFrame = {
  rows: [
    '..KK........KK..',
    '.KOOK......KOOK.',
    '.KPOOK....KOOPK.',
    'KOgOOKKKKKKOOgOK',
    'KOOOOOOOOOOOOOOK',
    'KOOOOOKPPKOOOOOK',
    '.KOOOOOKKOOOOOK.',
    '.KKOOOOOOOOOOKK.',
    '..KKOOOOOOOOKK..',
    '...KOOOOOOOOK...',
    '...KKOOOOOOKK...',
    '....KOOOOOOK....',
    '....KKKKKKKK....',
    '.....K....K.....',
    '.....K....K.....',
    '.....K....K.....',
  ],
}

// ROLL: cat lying on back, belly up
const ROLL: PixelFrame = {
  rows: [
    '................',
    '.....KKKKKKKK...',
    '....KOOOOOOOOK..',
    '...KOOOOOOOOOOK.',
    '...KOOKKKKKKOOK.',
    '...KOKgKOOKgKOK.',
    '..KOOOOOKKOOOOOK',
    '..KOOOOKPPKOOOOK',
    '..KOOOOOOOOOOOOK',
    '..KKOOOOOOOOOOKK',
    'KOPPKOOOOOOKPPK.',
    'KOK.KOK....KOK.K',
    'KKK.KKK....KKK..',
    '................',
    '................',
    '................',
  ],
}

// WALK frames — standing cat (no more sitting) with legs alternating
const STAND_A: PixelFrame = {
  rows: [
    '..KK........KK..',
    '.KOOK......KOOK.',
    '.KPOOK....KOOPK.',
    'KOgOOKKKKKKOOgOK',
    'KOOOOOOOOOOOOOOK',
    'KOOOOOKPPKOOOOOK',
    '.KOOOOOKKOOOOOK.',
    '.KKOOOOOOOOOOKK.',
    '..KOOOOOOOOOOK..',
    '..KOOOOOOOOOOKK.',
    '..KKOOOOOOOOOKK.',
    '..KOKKKKKKKKKK..',
    '..KOK.KOK.KOK.KK',
    '..KOK.KOK.KOK.KO',
    '..KKK.KKK.KKK.KK',
    '................',
  ],
}

const STAND_B: PixelFrame = {
  rows: [
    '..KK........KK..',
    '.KOOK......KOOK.',
    '.KPOOK....KOOPK.',
    'KOgOOKKKKKKOOgOK',
    'KOOOOOOOOOOOOOOK',
    'KOOOOOKPPKOOOOOK',
    '.KOOOOOKKOOOOOK.',
    '.KKOOOOOOOOOOKK.',
    '..KOOOOOOOOOOK..',
    '..KOOOOOOOOOOKK.',
    '..KKOOOOOOOOOKK.',
    '..KKKOKKKKOKKKK.',
    '.KOK.KOK.KOK.KOK',
    '.KOK.KOK.KOK.KOK',
    '.KKK.KKK.KKK.KKK',
    '................',
  ],
}

const WALK_L_A: PixelFrame = { rows: STAND_A.rows.map((r) => r.split('').reverse().join('')) }
const WALK_L_B: PixelFrame = { rows: STAND_B.rows.map((r) => r.split('').reverse().join('')) }

// DANCE: slight left/right wiggle
const DANCE_A: PixelFrame = {
  rows: [
    '..KK........KK..',
    '.KOOK......KOOK.',
    '.KPOOK....KOOPK.',
    'KOwOOKKKKKKOOwOK',
    'KOOOOOOOOOOOOOOK',
    'KOOOOOKPPKOOOOOK',
    '.KOOOwwwwOOOOOK.',
    '.KKOOOOOOOOOOKK.',
    '..KOOOOOOOOOOK..',
    '..KOOOOOOOOOOKK.',
    '..KOOOOOOOOOOOK.',
    '..KKOOOOOOOOOKK.',
    '...KKKOOOOOOKK..',
    '...KOKKKKKKOK...',
    '....KOK..KOK....',
    '....KKK..KKK....',
  ],
}

const DANCE_B: PixelFrame = {
  rows: [
    '..KK........KK..',
    '.KOOK......KOOK.',
    '.KPOOK....KOOPK.',
    'KOwOOKKKKKKOOwOK',
    'KOOOOOOOOOOOOOOK',
    'KOOOOOKPPKOOOOOK',
    '.KOOOwwwwOOOOOK.',
    '.KKOOOOOOOOOOKK.',
    '..KOOOOOOOOOOK..',
    '..KOOOOOOOOOOKK.',
    '..KOOOOOOOOOOOK.',
    '..KKOOOOOOOOOKK.',
    '...KKKOOOOOOKK..',
    '....KKKKKKKK....',
    '...KOK......KOK.',
    '...KKK......KKK.',
  ],
}

// ─── Pattern Overlay ───────────────────────────────────────────────────

function applyPattern(frame: PixelFrame, pattern: 'tabby' | 'calico' | 'none'): PixelFrame {
  if (pattern === 'none') return frame
  const rows = frame.rows.map((r) => r.split(''))

  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]
    if (!row) continue
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== 'O') continue
      if (pattern === 'tabby') {
        // forehead stripes
        if (y === 3 && (x === 6 || x === 9)) row[x] = 'D'
        else if (y === 4 && (x === 5 || x === 10)) row[x] = 'D'
        // body stripes
        else if (y >= 8 && y <= 11 && (x + y) % 3 === 0) row[x] = 'D'
      } else if (pattern === 'calico') {
        // black patch around one eye + upper back
        if (y === 3 && x >= 1 && x <= 3) row[x] = 'D'
        else if (y === 4 && x >= 1 && x <= 2) row[x] = 'D'
        else if (y >= 9 && y <= 10 && x >= 8 && x <= 12) row[x] = 'D'
        // orange patch on lower body
        else if (y >= 10 && y <= 11 && x >= 2 && x <= 6) row[x] = 'B'
      }
    }
  }
  return { rows: rows.map((r) => r.join('')) }
}

function buildSpriteSet(pattern: 'tabby' | 'calico' | 'none'): Record<AnimationState, PixelSpriteConfig> {
  const apply = (f: PixelFrame) => applyPattern(f, pattern)
  return {
    'idle': { frames: [apply(IDLE_OPEN), apply(IDLE_OPEN), apply(IDLE_HALF)], intervalMs: 900 },
    'walk-left': { frames: [apply(WALK_L_A), apply(WALK_L_B)], intervalMs: 400 },
    'walk-right': { frames: [apply(STAND_A), apply(STAND_B)], intervalMs: 400 },
    'sleep': { frames: [apply(SLEEP)], intervalMs: 1200 },
    'happy': { frames: [apply(HAPPY_FRAME), apply(IDLE_OPEN)], intervalMs: 400 },
    'think': { frames: [apply(THINK), apply(IDLE_HALF)], intervalMs: 700 },
    'talk': { frames: [apply(IDLE_OPEN), apply(IDLE_HALF)], intervalMs: 300 },
    'sad': { frames: [apply(SAD)], intervalMs: 1000 },
    'stretch': { frames: [apply(STRETCH), apply(IDLE_OPEN)], intervalMs: 600 },
    'dance': { frames: [apply(DANCE_A), apply(DANCE_B)], intervalMs: 250 },
    'roll': { frames: [apply(IDLE_OPEN), apply(ROLL)], intervalMs: 400 },
    'lick': { frames: [apply(LICK_FRAME), apply(IDLE_OPEN)], intervalMs: 400 },
    'jump': { frames: [apply(IDLE_OPEN), apply(JUMP)], intervalMs: 250 },
    'sneak': { frames: [apply(IDLE_HALF), apply(IDLE_OPEN)], intervalMs: 500 },
  }
}

// All skins use real PNG sprites now; fallback sprite data kept for type consistency
export const PIXEL_SPRITES: Record<SkinId, Record<AnimationState, PixelSpriteConfig>> = {
  calico: buildSpriteSet('calico'),
  sheep: buildSpriteSet('none'),
  chicken: buildSpriteSet('none'),
}

export const SKIN_META: Record<SkinId, { name: string }> = {
  calico:  { name: '三花' },
  sheep:   { name: '绵悠悠' },
  chicken: { name: '皮皮鸡' },
}
