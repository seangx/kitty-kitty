import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildStatusNavigateScript, buildStatusRowScript } from '../src/main/tmux/status-scripts.ts'

const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']
  .find(existsSync) || 'tmux'

test('nested tmux rows anchor to their parent and collapse direct panes into ungrouped items', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitty-status-navigation-'))
  const socket = `kitty-status-${process.pid}-${Date.now()}`
  const tmux = (...args: string[]) => execFileSync(TMUX, ['-L', socket, ...args], { encoding: 'utf8' }).trim()
  const dbPath = join(dir, 'test.db')
  const sqlite = (sql: string) => execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim()
  const rowScript = join(dir, 'status-row.sh')
  const navigateScript = join(dir, 'status-navigate.sh')

  try {
    tmux('new-session', '-d', '-s', 'kitty_root', 'sleep', '120')
    tmux('new-session', '-d', '-s', 'kitty_child', 'sleep', '120')
    tmux('split-window', '-d', '-t', 'kitty_child', 'sleep', '120')
    tmux('new-session', '-d', '-s', 'kitty_loose1', 'sleep', '120')
    tmux('new-session', '-d', '-s', 'kitty_loose2', 'sleep', '120')

    const rootPane = tmux('list-panes', '-t', 'kitty_root', '-F', '#{pane_id}')
    const childPanes = tmux('list-panes', '-t', 'kitty_child', '-F', '#{pane_id}').split('\n')
    assert.equal(childPanes.length, 2)

    sqlite(`
      CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_group_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        tmux_name TEXT NOT NULL,
        cwd TEXT,
        group_id TEXT,
        pane_id TEXT,
        hidden INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO groups VALUES ('root', 'Root', NULL, '2026-01-01');
      INSERT INTO groups VALUES ('child', 'Child', 'root', '2026-01-02');
      INSERT INTO sessions VALUES ('master', 'Master', 'kitty_root', '/tmp', 'root', '${rootPane}', 0, '2026-01-01', '2026-01-01');
      INSERT INTO sessions VALUES ('reviewer', 'Reviewer', 'kitty_child', '/tmp', 'child', '${childPanes[0]}', 0, '2026-01-02', '2026-01-02');
      INSERT INTO sessions VALUES ('tester', 'Tester', 'kitty_child', '/tmp', 'child', '', 0, '2026-01-03', '2026-01-03');
      INSERT INTO sessions VALUES ('loose1', 'Loose 1', 'kitty_loose1', '/tmp', NULL, '', 0, '2026-01-04', '2026-01-04');
      INSERT INTO sessions VALUES ('loose2', 'Loose 2', 'kitty_loose2', '/tmp', NULL, '', 0, '2026-01-05', '2026-01-05');
    `)

    const scriptOptions = {
      tmuxBin: `${TMUX} -L ${socket}`,
      dbPath,
      sessionPrefix: 'kitty_',
    }
    writeFileSync(rowScript, buildStatusRowScript(scriptOptions))
    writeFileSync(navigateScript, buildStatusNavigateScript(scriptOptions))
    chmodSync(rowScript, '755')
    chmodSync(navigateScript, '755')

    const render = (row: number) => execFileSync(rowScript, [String(row), 'kitty_child', childPanes[0], '120'], { encoding: 'utf8' })
    const rootContentsRow = render(0)
    const rootRow = render(1)
    const hiddenLeafRow = render(2)

    assert.match(rootRow, /range=user\|kr:1/)
    assert.match(rootRow, /Root \(3\)/)
    assert.match(rootRow, /Loose 1/)
    assert.match(rootRow, /Loose 2/)
    assert.doesNotMatch(rootRow, /未分组 \(2\)/)
    assert.match(rootContentsRow, /未分组 \(1\)/)
    assert.match(rootContentsRow, /range=user\|kd:root/)
    assert.doesNotMatch(rootContentsRow, /Master/)
    assert.match(rootContentsRow, /range=user\|kg:child/)
    assert.equal(hiddenLeafRow, '')
    assert.doesNotMatch(`${rootRow}${rootContentsRow}`, /Reviewer|Tester|range=user\|kd:child/)
    assert.doesNotMatch(`${rootRow}${rootContentsRow}`, /range=user\|ks:/)

    const ranges = [...`${rootRow}${rootContentsRow}`.matchAll(/range=user\|([^\]]+)/g)]
      .map((match) => match[1])
    assert.ok(ranges.length > 0)
    for (const range of ranges) {
      assert.ok(Buffer.byteLength(range, 'utf8') <= 15, `tmux user range is too long: ${range}`)
    }

    const visibleText = (value: string) => value.replace(/#\[[^\]]*\]/g, '')
    const leadingCells = (value: string) => visibleText(value).match(/^ */)?.[0].length || 0
    assert.equal(leadingCells(rootContentsRow), leadingCells(rootRow))

    tmux('select-pane', '-t', childPanes[0])
    execFileSync(navigateScript, ['level-index', '1', 'kitty_child', ''], { encoding: 'utf8' })
    assert.equal(tmux('display-message', '-t', 'kitty_child', '-p', '#{pane_id}'), childPanes[0])
    assert.equal(sqlite("SELECT pane_id FROM sessions WHERE id='tester';"), '')
  } finally {
    try { tmux('kill-server') } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('app startup refreshes tmux status bars without waiting for the Deck to open', () => {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const ipcIndex = source.indexOf('registerIpcHandlers()')
  const refreshIndex = source.indexOf('refreshAllStatusBars()')

  assert.ok(ipcIndex >= 0)
  assert.ok(refreshIndex > ipcIndex)
})

test('status rows are rendered before an atomic session switch without async cache frames', () => {
  const source = readFileSync(new URL('../src/main/tmux/session-manager.ts', import.meta.url), 'utf8')
  const applyStart = source.indexOf('function applyStatusLineOptions')
  const applyEnd = source.indexOf('/**\n * Apply kitty-kitty status bar', applyStart)
  const block = source.slice(applyStart, applyEnd)

  assert.ok(applyStart >= 0)
  assert.ok(applyEnd > applyStart)
  assert.match(block, /execFileSync\(\s*rowScript/)
  assert.doesNotMatch(block, /#\(\$\{rowScript\}/)
  assert.ok(block.indexOf('status-format[') < block.lastIndexOf('status ${statusValue}'))

  const clickBinding = source.match(/bind-key -T root MouseDown1Status[^\n]+/)?.[0] || ''
  assert.match(clickBinding, /run-shell '/)
  assert.doesNotMatch(clickBinding, /run-shell -b/)
})
