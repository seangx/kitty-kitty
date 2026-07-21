import assert from 'node:assert/strict'
import test from 'node:test'
import { isPointerOutsideSafeCorridor } from '../src/renderer/pet/auto-close-geometry.ts'

test('pointer can cross the gap between an anchor button and its menu', () => {
  const menu = { left: 92, right: 268, top: 90, bottom: 186 }
  const button = { left: 288, right: 330, top: 116, bottom: 158 }

  assert.equal(isPointerOutsideSafeCorridor(278, 130, [menu, button], 8), false)
  assert.equal(isPointerOutsideSafeCorridor(310, 138, [menu, button], 8), false)
  assert.equal(isPointerOutsideSafeCorridor(180, 120, [menu, button], 8), false)
})

test('pointer still closes the menu after leaving the combined safe corridor', () => {
  const menu = { left: 92, right: 268, top: 90, bottom: 186 }
  const button = { left: 288, right: 330, top: 116, bottom: 158 }

  assert.equal(isPointerOutsideSafeCorridor(278, 70, [menu, button], 8), true)
  assert.equal(isPointerOutsideSafeCorridor(350, 130, [menu, button], 8), true)
})
