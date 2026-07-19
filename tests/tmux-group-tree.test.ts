import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  groupDepthForTmuxSql,
  groupPathForTmuxSql,
  groupSubtreeCte,
  ROOT_GROUPS_SQL,
  rootGroupForTmuxSql,
} from '../src/main/tmux/group-tree-sql.ts'
import { statusLineCountForDepth } from '../src/main/tmux/status-scripts.ts'

test('tmux navigation renders root groups and rolls child sessions into their root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitty-tmux-groups-'))
  const dbPath = join(dir, 'test.db')
  const sqlite = (sql: string) => execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim()

  try {
    sqlite(`
    CREATE TABLE groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_group_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      tmux_name TEXT NOT NULL,
      group_id TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    INSERT INTO groups VALUES ('root', 'Root', NULL, '2026-01-01');
    INSERT INTO groups VALUES ('child', 'Child', 'root', '2026-01-02');
    INSERT INTO groups VALUES ('grandchild', 'Grandchild', 'child', '2026-01-03');
    INSERT INTO groups VALUES ('other', 'Other', NULL, '2026-01-04');
    INSERT INTO sessions VALUES ('root-session', 'tmux-root', 'root', 0, '2026-01-01');
    INSERT INTO sessions VALUES ('child-session', 'tmux-child', 'child', 0, '2026-01-03');
    INSERT INTO sessions VALUES ('grandchild-session', 'tmux-grandchild', 'grandchild', 0, '2026-01-04');
    INSERT INTO sessions VALUES ('hidden-child', 'tmux-hidden', 'child', 1, '2026-01-05');
    INSERT INTO sessions VALUES ('ungrouped', 'tmux-loose', NULL, 0, '2026-01-06');
    `)

    assert.deepEqual(sqlite(ROOT_GROUPS_SQL).split('\n').map((row) => row.split('|')[0]), ['root', 'other'])
    assert.equal(sqlite(rootGroupForTmuxSql("'tmux-child'")), 'root')
    assert.equal(sqlite(rootGroupForTmuxSql("'tmux-grandchild'")), 'root')
    assert.equal(sqlite(rootGroupForTmuxSql("'tmux-loose'")), '__ungrouped__')
    assert.deepEqual(sqlite(groupPathForTmuxSql("'tmux-grandchild'"))
      .split('\n').map((row) => row.split('|')[0]), ['root', 'child', 'grandchild'])
    assert.equal(sqlite(groupDepthForTmuxSql("'tmux-grandchild'")), '3')
    assert.equal(sqlite(groupDepthForTmuxSql("'tmux-loose'")), '0')
    assert.equal(statusLineCountForDepth(0), 1)
    assert.equal(statusLineCountForDepth(2), 3)
    assert.equal(statusLineCountForDepth(8), 5)

    const subtree = groupSubtreeCte("'root'")
    assert.equal(sqlite(`
      ${subtree}
      SELECT COUNT(*)
      FROM sessions
      WHERE group_id IN (SELECT id FROM subtree) AND COALESCE(hidden, 0) = 0;
    `), '3')
    assert.equal(sqlite(`
      ${subtree}
      SELECT tmux_name
      FROM sessions
      WHERE group_id IN (SELECT id FROM subtree) AND COALESCE(hidden, 0) = 0
      ORDER BY updated_at DESC
      LIMIT 1;
    `), 'tmux-grandchild')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
