import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'

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

test('approved calico animations keep a stable 2x canvas scale', async () => {
  const names = await readdir(SPRITES)
  const idle = names.filter((name) => /^idle-\d+\.png$/.test(name)).sort()
  const deckOpen = names.filter((name) => /^deck-open-\d+\.png$/.test(name)).sort()

  assert.equal(idle.length, 10)
  assert.equal(deckOpen.length, 12)
  for (const name of idle) assert.deepEqual(await pngSize(name), { width: 448, height: 256 })
  for (const name of deckOpen) assert.deepEqual(await pngSize(name), { width: 320, height: 512 })
})

test('deck opens only after the one-shot stretch animation', async () => {
  const [types, pngSprite, canvas, fallback] = await Promise.all([
    source('src/shared/types/pet.ts'),
    source('src/renderer/pet/PngSprite.tsx'),
    source('src/renderer/pet/PetCanvas.tsx'),
    source('src/renderer/pet/animations/pixel-sprites.ts'),
  ])

  assert.match(types, /\| 'deck-open'/)
  assert.match(pngSprite, /'calico\/idle': \{ width: 448, height: 256 \}/)
  assert.match(pngSprite, /'calico\/deck-open': \{ width: 320, height: 512 \}/)
  assert.match(pngSprite, /'deck-open': 90/)
  assert.match(pngSprite, /clock\.key === animationKey \? clock\.tick : 0/)
  assert.match(fallback, /'deck-open': \{ frames:/)
  assert.match(canvas, /const DECK_OPEN_TRANSITION_MS = 1080/)
  assert.match(canvas, /machine\.forceState\('deck-open'\)/)
  assert.match(canvas, /setTimeout\(\(\) => void finishOpenDeck\(\), DECK_OPEN_TRANSITION_MS\)/)
  assert.match(canvas, /machine\.forceState\('idle'\)[\s\S]*?setDeckOpen\(false\)/)
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
