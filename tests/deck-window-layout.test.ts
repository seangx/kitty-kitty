import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  ANIMATE_FLOATING_DECK_BOUNDS,
  applyFloatingDeckBounds,
  getFloatingDeckLayout,
} from '../src/main/windows/deck-window-layout.ts'
import {
  DECK_INTERACTIVE_SELECTOR,
  isDeckInteractiveTarget,
} from '../src/renderer/pet/deck-hit-test.ts'

const workArea = { x: 100, y: 24, width: 1400, height: 900 }

test('transparent floating Deck never asks macOS to animate native bounds', () => {
  assert.equal(ANIMATE_FLOATING_DECK_BOUNDS, false)
})

test('resizing the transparent Deck releases stale full-window mouse capture', () => {
  const calls: unknown[][] = []
  const win = {
    setBounds: (...args: unknown[]) => calls.push(['bounds', ...args]),
    setIgnoreMouseEvents: (...args: unknown[]) => calls.push(['ignore', ...args]),
  }
  const bounds = { x: 100, y: 140, width: 720, height: 650 }

  applyFloatingDeckBounds(win, bounds)

  assert.deepEqual(calls, [
    ['bounds', bounds, false],
    ['ignore', true, { forward: true }],
  ])
})

test('Deck render releases any late mouse capture from the replaced pet', async () => {
  const source = await readFile(new URL('../src/renderer/pet/PetCanvas.tsx', import.meta.url), 'utf8')

  assert.match(
    source,
    /useEffect\(\(\) => \{[\s\S]*?if \(deckOpen && !anyPopup && !isDraggingBubble\.current\)[\s\S]*?set-ignore-mouse', true[\s\S]*?\}, \[anyPopup, deckOpen\]\)/,
  )
})

test('Deck mouse capture is limited to its visible interaction islands', async () => {
  const source = await readFile(new URL('../src/renderer/pet/PetCanvas.tsx', import.meta.url), 'utf8')
  const target = (matchedSelector: string | null) => ({
    closest: (selectors: string) => selectors === DECK_INTERACTIVE_SELECTOR ? matchedSelector : null,
  })

  assert.equal(isDeckInteractiveTarget(target('.session-deck__rail') as unknown as EventTarget), true)
  assert.equal(isDeckInteractiveTarget(target('.session-deck__menu') as unknown as EventTarget), true)
  assert.equal(isDeckInteractiveTarget(target(null) as unknown as EventTarget), false)
  assert.equal(isDeckInteractiveTarget(null), false)
  assert.match(source, /document\.elementFromPoint\(e\.clientX, e\.clientY\)/)
  assert.match(source, /!isDeckInteractiveTarget/)
})

test('floating Deck chooses the side with outward space and stays on screen', () => {
  assert.deepEqual(
    getFloatingDeckLayout({ x: 130, y: 140, width: 450, height: 650 }, workArea),
    { edge: 'left', bounds: { x: 100, y: 24, width: 720, height: 900 } },
  )
  assert.deepEqual(
    getFloatingDeckLayout({ x: 1020, y: 140, width: 450, height: 650 }, workArea),
    { edge: 'right', bounds: { x: 780, y: 24, width: 720, height: 900 } },
  )
})

test('floating Deck uses the full height of its display work area', () => {
  assert.deepEqual(
    getFloatingDeckLayout({ x: 500, y: 800, width: 450, height: 650 }, workArea).bounds,
    { x: 365, y: 24, width: 720, height: 900 },
  )
})
