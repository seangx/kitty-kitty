import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'
import { DB_NAME } from '@shared/constants'

let db: Database.Database | null = null

export function getDB(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDB() first.')
  }
  return db
}

export function initDB(): Database.Database {
  if (db) return db

  const dbPath = join(app.getPath('userData'), DB_NAME)
  db = new Database(dbPath)

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')

  // Run migrations
  runMigrations(db)

  return db
}

function runMigrations(database: Database.Database): void {
  const currentVersion = getSchemaVersion(database)

  // Inline migrations for schema changes
  if (currentVersion >= 1) {
    // Add cwd column if missing (v1 → v2)
    try {
      database.exec("ALTER TABLE sessions ADD COLUMN cwd TEXT NOT NULL DEFAULT ''")
    } catch { /* column already exists */ }

    // Add groups table and group_id to sessions (v2 → v3)
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS groups (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          color      TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
    } catch { /* already exists */ }
    try {
      database.exec("ALTER TABLE groups ADD COLUMN collab_enabled INTEGER NOT NULL DEFAULT 0")
    } catch { /* column already exists */ }
    try {
      database.exec("ALTER TABLE groups ADD COLUMN main_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL")
    } catch { /* column already exists */ }
    try {
      database.exec("ALTER TABLE sessions ADD COLUMN group_id TEXT REFERENCES groups(id) ON DELETE SET NULL")
    } catch { /* column already exists */ }
    try {
      database.exec("ALTER TABLE sessions ADD COLUMN main_pane TEXT NOT NULL DEFAULT '0.0'")
    } catch { /* column already exists */ }
    try {
      database.exec("ALTER TABLE sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0")
    } catch { /* column already exists */ }
    try {
      database.exec("ALTER TABLE sessions ADD COLUMN roles TEXT NOT NULL DEFAULT ''")
    } catch { /* column already exists */ }
    try {
      database.exec("ALTER TABLE sessions ADD COLUMN expertise TEXT NOT NULL DEFAULT ''")
    } catch { /* column already exists */ }
    try {
      database.exec("ALTER TABLE sessions ADD COLUMN pane_id TEXT DEFAULT ''")
    } catch { /* column already exists */ }
    try {
      database.exec("ALTER TABLE sessions ADD COLUMN claude_session_id TEXT DEFAULT ''")
    } catch { /* column already exists */ }

    // Remove UNIQUE constraint on tmux_name (pane mode allows shared tmux sessions)
    try {
      const hasUnique = database.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'"
      ).get() as { sql: string } | undefined
      if (hasUnique?.sql?.includes('UNIQUE')) {
        database.exec(`
          CREATE TABLE IF NOT EXISTS sessions_new (
            id         TEXT PRIMARY KEY,
            tmux_name  TEXT NOT NULL,
            title      TEXT NOT NULL,
            tool       TEXT NOT NULL DEFAULT 'claude',
            status     TEXT NOT NULL DEFAULT 'running',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            cwd        TEXT NOT NULL DEFAULT '',
            group_id   TEXT REFERENCES groups(id) ON DELETE SET NULL,
            main_pane  TEXT NOT NULL DEFAULT '0.0',
            hidden     INTEGER NOT NULL DEFAULT 0,
            roles      TEXT NOT NULL DEFAULT '',
            expertise  TEXT NOT NULL DEFAULT '',
            pane_id    TEXT DEFAULT ''
          );
          INSERT INTO sessions_new SELECT id, tmux_name, title, tool, status, created_at, updated_at, cwd, group_id, main_pane, hidden, roles, expertise, pane_id FROM sessions;
          DROP TABLE sessions;
          ALTER TABLE sessions_new RENAME TO sessions;
          CREATE INDEX IF NOT EXISTS idx_sessions_tmux ON sessions(tmux_name);
        `)
      }
    } catch { /* already migrated */ }

    // Add worktree_panes table
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS worktree_panes (
          id           TEXT PRIMARY KEY,
          session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          pane_id      TEXT NOT NULL,
          branch       TEXT NOT NULL,
          path         TEXT NOT NULL,
          base_branch  TEXT DEFAULT 'main',
          tool         TEXT DEFAULT 'claude',
          merge_state  TEXT DEFAULT 'unknown',
          status       TEXT DEFAULT 'active',
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(session_id, pane_id)
        )
      `)
    } catch { /* already exists */ }
  }

  // Migration files in order
  const migrations = [
    { version: 1, file: '001_initial.sql' }
  ]

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      // Try to load from the bundled path first, then from source
      let sqlPath = join(__dirname, 'migrations', migration.file)
      if (!existsSync(sqlPath)) {
        sqlPath = join(__dirname, '..', '..', 'src', 'main', 'db', 'migrations', migration.file)
      }

      if (existsSync(sqlPath)) {
        const sql = readFileSync(sqlPath, 'utf-8')
        database.exec(sql)
      }
    }
  }
}

function getSchemaVersion(database: Database.Database): number {
  try {
    const row = database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    ).get() as { name: string } | undefined

    if (!row) return 0

    const version = database.prepare(
      'SELECT MAX(version) as version FROM schema_version'
    ).get() as { version: number } | undefined

    return version?.version ?? 0
  } catch {
    return 0
  }
}

export function closeDB(): void {
  if (db) {
    db.close()
    db = null
  }
}
