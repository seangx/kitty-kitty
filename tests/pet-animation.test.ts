import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'
import {
  getPetAnimationStageSize,
  getPngSpriteDisplaySize,
} from '../src/renderer/pet/sprite-layout.ts'

const ROOT = new URL('../', import.meta.url)
const SPRITES = new URL('../src/renderer/pet/sprites/calico/', import.meta.url)

async function source(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), 'utf8')
}

async function pngSize(name: string): Promise<{ width: number; height: number }> {
  const png = await readFile(new URL(name, SPRITES))
  assert.equal(png.toString('ascii', 1, 4), 'PNG')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

test('calico idle is normalized from the deck transition anchor', async () => {
  const names = await readdir(SPRITES)
  const idle = names.filter((name) => /^idle-\d+\.png$/.test(name)).sort()
  const deckOpen = names.filter((name) => /^deck-open-\d+\.png$/.test(name)).sort()
  const [pngSprite, layout, normalizer] = await Promise.all([
    source('src/renderer/pet/PngSprite.tsx'),
    source('src/renderer/pet/sprite-layout.ts'),
    source('tools/normalize-pet-idle-strip.py'),
  ])

  assert.equal(idle.length, 13)
  assert.equal(deckOpen.length, 12)
  for (const name of idle) assert.deepEqual(await pngSize(name), { width: 320, height: 256 })
  for (const name of deckOpen) assert.deepEqual(await pngSize(name), { width: 320, height: 512 })
  assert.match(layout, /'calico\/idle': \{ width: 320, height: 256 \}/)
  assert.match(pngSprite, /'idle': 80/)
  assert.match(normalizer, /shared_scale = anchor_width \/ first_width/)
  assert.match(normalizer, /anchor\.crop\(\(0, anchor\.height - height, width, anchor\.height\)\)/)
})

test('PNG pet animation crossfades state changes without changing its bottom anchor', async () => {
  const [pngSprite, css, interpolator] = await Promise.all([
    source('src/renderer/pet/PngSprite.tsx'),
    source('src/renderer/pet/PngSprite.css'),
    source('tools/interpolate-pet-animation.py'),
  ])

  assert.match(pngSprite, /previous\.animationKey === renderedFrame\.animationKey/)
  assert.match(pngSprite, /png-sprite__frame is-previous/)
  assert.match(css, /bottom: 0;/)
  assert.match(css, /png-sprite-state-fade-in 120ms/)
  assert.match(interpolator, /first_rgba\[\.\.\., :3\] \* first_alpha/)
})

test('deck opens only after the one-shot stretch animation', async () => {
  const [types, pngSprite, layout, canvas, fallback] = await Promise.all([
    source('src/shared/types/pet.ts'),
    source('src/renderer/pet/PngSprite.tsx'),
    source('src/renderer/pet/sprite-layout.ts'),
    source('src/renderer/pet/PetCanvas.tsx'),
    source('src/renderer/pet/animations/pixel-sprites.ts'),
  ])

  assert.match(types, /\| 'deck-open'/)
  assert.match(layout, /'calico\/idle': \{ width: 320, height: 256 \}/)
  assert.match(layout, /'calico\/deck-open': \{ width: 320, height: 512 \}/)
  assert.match(pngSprite, /'deck-open': 90/)
  assert.match(pngSprite, /clock\.key === animationKey \? clock\.tick : 0/)
  assert.match(fallback, /'deck-open': \{ frames:/)
  assert.match(canvas, /const DECK_OPEN_TRANSITION_MS = 1080/)
  assert.match(canvas, /machine\.forceState\('deck-open'\)/)
  assert.match(canvas, /setTimeout\(\(\) => void finishOpenDeck\(\), DECK_OPEN_TRANSITION_MS\)/)
  assert.match(canvas, /machine\.forceState\('idle'\)[\s\S]*?setDeckOpen\(false\)/)
})

test('tall deck animation overflows upward from the idle-sized stage', async () => {
  const canvas = await source('src/renderer/pet/PetCanvas.tsx')
  const stage = getPetAnimationStageSize('calico', 128)
  const idle = getPngSpriteDisplaySize('calico', 'idle', 128)
  const deckOpen = getPngSpriteDisplaySize('calico', 'deck-open', 128)

  assert.deepEqual(stage, { width: 160, height: 128 })
  assert.deepEqual(idle, { width: 160, height: 128 })
  assert.deepEqual(deckOpen, { width: 160, height: 256 })
  const idleTop = stage.height - idle.height
  const deckOpenTop = stage.height - deckOpen.height
  assert.equal(idleTop, 0)
  assert.equal(deckOpenTop, -128)
  assert.equal(idleTop + idle.height, stage.height)
  assert.equal(deckOpenTop + deckOpen.height, stage.height)
  assert.match(canvas, /const petStageSize = getPetAnimationStageSize\(bubble\.skin, 128\)/)
  assert.match(canvas, /width: petStageSize\.width, height: petStageSize\.height,[\s\S]*?overflow: 'visible'/)
  assert.doesNotMatch(canvas, /petDisplaySize/)
})

test('asset extractor can preserve anchor scale instead of shrinking the cat', async () => {
  const extractor = await source('tools/extract-pet-animation.py')
  assert.match(extractor, /--anchor-image/)
  assert.match(extractor, /--anchor-first-frame/)
  assert.match(extractor, /--first-frame-bottom-inset/)
  assert.match(extractor, /anchor_subject_width/)
  assert.match(extractor, /Anchored subject does not fit the requested canvas/)
  assert.match(extractor, /choices=\("center", "bottom"\), default="bottom"/)
})
