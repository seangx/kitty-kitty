import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PET_ANIMATION_HEADROOM,
  toPetAnchorPosition,
  toPetWindowPosition,
} from '../src/shared/pet-window-position.ts'

test('native pet window reserves transparent space above the persisted anchor', () => {
  const anchor = { x: -399, y: 796 }
  const windowPosition = toPetWindowPosition(anchor)

  assert.equal(PET_ANIMATION_HEADROOM, 128)
  assert.deepEqual(windowPosition, { x: -399, y: 668 })
  assert.deepEqual(toPetAnchorPosition(windowPosition), anchor)
})
