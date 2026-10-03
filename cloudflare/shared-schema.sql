-- Run on a NEW shared database. Preserves this app's existing retention policy.
CREATE TABLE skill_deck_auth_attempts (ip_hash TEXT NOT NULL,bucket INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(ip_hash,bucket));
CREATE TABLE skill_deck_auth_config (app_id TEXT PRIMARY KEY CHECK(app_id='skill-deck'),key_sha256 TEXT NOT NULL);
CREATE TABLE skill_deck_auth_sessions (session_id TEXT PRIMARY KEY,app_id TEXT NOT NULL CHECK(app_id='skill-deck'),token_sha256 TEXT NOT NULL UNIQUE,device_name TEXT NOT NULL,created_at TEXT NOT NULL,last_used_at TEXT NOT NULL,revoked_at TEXT);
CREATE TABLE skill_deck_backup_chunks (operation_id TEXT NOT NULL REFERENCES skill_deck_backups(operation_id) ON DELETE CASCADE,chunk_index INTEGER NOT NULL,backup_json TEXT NOT NULL,PRIMARY KEY(operation_id,chunk_index));
CREATE TABLE skill_deck_backups (operation_id TEXT PRIMARY KEY,base_revision INTEGER NOT NULL,revision INTEGER UNIQUE,sha256 TEXT NOT NULL,saved_at TEXT NOT NULL,record_count INTEGER NOT NULL,version_count INTEGER NOT NULL,chunk_count INTEGER NOT NULL);
CREATE TABLE skill_deck_cloud_state (app_id TEXT PRIMARY KEY CHECK(app_id='skill-deck'),revision INTEGER NOT NULL DEFAULT 0,operation_id TEXT);
CREATE TABLE skill_deck_receipts (operation_id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,revision INTEGER NOT NULL);
CREATE INDEX skill_deck_auth_sessions_app ON skill_deck_auth_sessions(app_id,revoked_at);
CREATE TRIGGER skill_deck_backup_immutable BEFORE UPDATE ON skill_deck_backups WHEN OLD.revision IS NOT NULL BEGIN SELECT RAISE(ABORT,'immutable backup'); END;
CREATE TRIGGER skill_deck_backup_protected BEFORE DELETE ON skill_deck_backups WHEN OLD.revision IS NOT NULL AND OLD.operation_id NOT IN (SELECT operation_id FROM skill_deck_backups WHERE revision IS NOT NULL ORDER BY revision DESC LIMIT -1 OFFSET 3) BEGIN SELECT RAISE(ABORT,'protected backup'); END;
INSERT OR IGNORE INTO skill_deck_cloud_state(app_id,revision) VALUES ('skill-deck',0);
