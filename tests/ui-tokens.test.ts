import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { COLOR_THEMES, DEFAULT_BUBBLE_CONFIG } from '../src/shared/types/config.ts'

// The UI rewrite (feat/neutral-ui) replaced the legacy "Aether Glass" purple
// palette with shared neutral tokens (src/renderer/pet/ui-tokens.ts). These
// hexes must never come back in renderer-facing code.
const LEGACY_PURPLE = [
  '#23233f',
  '#17172f',
  '#0c0c1f',
  '#0d0d1f',
  '#645efb',
  '#a7a5ff',
  '#46465c',
  '#e5e3ff',
  '#aaa8c3',
  '#8886a5',
  '#1a1a2e',
  '#1e1e36',
  '#2a2a45',
]

const SCAN_ROOTS = [
  'src/renderer',
  'src/shared/types',
  'src/main/tmux/pane-label.ts',
  'src/main/tmux/session-manager.ts',
]

async function collectFiles(root: string): Promise<string[]> {
  const stat = await readdir(root, { withFileTypes: true, recursive: true }).catch(() => null)
  if (stat) {
    return stat
      .filter((entry) => entry.isFile() && /\.(ts|tsx|css)$/.test(entry.name))
      .map((entry) => join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name))
  }
  // root is a file
  return [root]
}

test('legacy purple palette is gone from renderer-facing code', async () => {
  for (const root of SCAN_ROOTS) {
    const files = await collectFiles(root)
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const hex of LEGACY_PURPLE) {
        assert.ok(
          !source.toLowerCase().includes(hex),
          `${file} still references legacy purple ${hex}`,
        )
      }
    }
  }
})

test('all popups consume the shared neutral tokens module', async () => {
  const consumers = [
    'src/renderer/pet/ContextMenu.tsx',
    'src/renderer/pet/InputPopup.tsx',
    'src/renderer/pet/SessionPicker.tsx',
    'src/renderer/pet/SettingsPanel.tsx',
    'src/renderer/pet/SkillsPanel.tsx',
    'src/renderer/pet/SpeechBubble.tsx',
    'src/renderer/pet/AgentMetadataPopup.tsx',
    'src/renderer/pet/TagCloud.tsx',
    'src/renderer/pet/PetCanvas.tsx',
  ]
  for (const file of consumers) {
    const source = await readFile(file, 'utf8')
    assert.match(source, /ui-tokens/, `${file} must import shared ui-tokens`)
  }
})

test('bubble themes keep their storage keys but use neutral glass', () => {
  // Keys are persisted in user config — indigo/emerald/rose/amber must exist.
  for (const key of ['indigo', 'emerald', 'rose', 'amber']) {
    assert.ok(COLOR_THEMES[key], `COLOR_THEMES.${key} missing`)
    assert.equal(
      COLOR_THEMES[key].glass,
      '#191b27',
      `COLOR_THEMES.${key}.glass must be the shared neutral surface`,
    )
  }
  assert.notEqual(COLOR_THEMES.indigo.dim, '#645efb', 'default theme must not be legacy purple')
})

test('default deck accent stays the coordinated teal', () => {
  assert.equal(DEFAULT_BUBBLE_CONFIG.deckAccentColor, '#6fd7c8')
  assert.equal(DEFAULT_BUBBLE_CONFIG.colorTheme, 'indigo')
})
