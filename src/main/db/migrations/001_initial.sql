-- Tmux sessions tracked by kitty-kitty
CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,
    tmux_name       TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    tool            TEXT NOT NULL DEFAULT 'claude',
    cwd             TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'running',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pet state (single row, updated in place)
CREATE TABLE IF NOT EXISTS pet_state (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    mood                TEXT NOT NULL DEFAULT 'neutral',
    mood_score          INTEGER NOT NULL DEFAULT 50,
    experience          INTEGER NOT NULL DEFAULT 0,
    level               INTEGER NOT NULL DEFAULT 1,
    total_interactions  INTEGER NOT NULL DEFAULT 0,
    last_interaction_at TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Initialize singleton pet state
INSERT OR IGNORE INTO pet_state (id) VALUES (1);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
);

INSERT OR IGNORE INTO schema_version (version) VALUES (1);
