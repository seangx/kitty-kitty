import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ANIMATE_FLOATING_DECK_BOUNDS,
  getFloatingDeckLayout,
} from '../src/main/windows/deck-window-layout.ts'

const workArea = { x: 100, y: 24, width: 1400, height: 900 }

test('transparent floating Deck never asks macOS to animate native bounds', () => {
  assert.equal(ANIMATE_FLOATING_DECK_BOUNDS, false)
})

test('floating Deck chooses the side with outward space and stays on screen', () => {
  assert.deepEqual(
    getFloatingDeckLayout({ x: 130, y: 140, width: 450, height: 650 }, workArea),
    { edge: 'left', bounds: { x: 100, y: 140, width: 720, height: 650 } },
  )
  assert.deepEqual(
    getFloatingDeckLayout({ x: 1020, y: 140, width: 450, height: 650 }, workArea),
    { edge: 'right', bounds: { x: 780, y: 140, width: 720, height: 650 } },
  )
})

test('floating Deck clamps vertically into its display work area', () => {
  assert.equal(
    getFloatingDeckLayout({ x: 500, y: 800, width: 450, height: 650 }, workArea).bounds.y,
    274,
  )
})
