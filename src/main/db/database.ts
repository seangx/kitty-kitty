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
      database.exec("ALTER TABLE sessions ADD COLUMN group_id TEXT REFERENCES groups(id) ON DELETE SET NULL")
    } catch { /* column already exists */ }
    try {
      database.exec("ALTER TABLE sessions ADD COLUMN main_pane TEXT NOT NULL DEFAULT '0.0'")
    } catch { /* column already exists */ }

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
