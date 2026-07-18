import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ANIMATE_SIDE_DECK_BOUNDS,
  getSideDeckBounds,
} from '../src/main/windows/deck-window-layout.ts'

const workArea = { x: 100, y: 24, width: 1400, height: 900 }

test('transparent side Deck never asks macOS to animate native bounds', () => {
  assert.equal(ANIMATE_SIDE_DECK_BOUNDS, false)
})

test('left Deck keeps its left edge fixed while expanding inward', () => {
  assert.deepEqual(getSideDeckBounds('left', false, workArea, 140, 650), {
    x: 100, y: 140, width: 128, height: 650,
  })
  assert.deepEqual(getSideDeckBounds('left', true, workArea, 140, 650), {
    x: 100, y: 140, width: 720, height: 650,
  })
})

test('right Deck keeps its right edge fixed while expanding inward', () => {
  assert.deepEqual(getSideDeckBounds('right', false, workArea, 140, 650), {
    x: 1372, y: 140, width: 128, height: 650,
  })
  assert.deepEqual(getSideDeckBounds('right', true, workArea, 140, 650), {
    x: 780, y: 140, width: 720, height: 650,
  })
})

test('side Deck clamps vertically into its display work area', () => {
  assert.equal(getSideDeckBounds('left', true, workArea, 800, 650).y, 274)
  assert.equal(getSideDeckBounds('left', true, workArea, -40, 650).y, 24)
})
