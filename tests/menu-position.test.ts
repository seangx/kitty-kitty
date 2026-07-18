import assert from 'node:assert/strict'
import test from 'node:test'
import { clampMenuPosition } from '../src/renderer/pet/menu-position.ts'

test('keeps a context menu at its click point when it already fits', () => {
  assert.deepEqual(clampMenuPosition(120, 80, 160, 220, 600, 500), {
    left: 120,
    top: 80,
  })
})

test('clamps a context menu opened near the right and bottom viewport edges', () => {
  assert.deepEqual(clampMenuPosition(560, 470, 160, 220, 600, 500), {
    left: 436,
    top: 276,
  })
})

test('pins an oversized context menu to the viewport margin', () => {
  assert.deepEqual(clampMenuPosition(-20, -10, 800, 700, 600, 500), {
    left: 4,
    top: 4,
  })
})
