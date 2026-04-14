ALTER TABLE sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
UPDATE schema_version SET version = 2;
