const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "clipsync.db"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clips (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('text','image','file')),
    content TEXT,
    file_path TEXT,
    thumbnail TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES devices(id)
  );

  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS clip_tags (
    clip_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (clip_id, tag_id),
    FOREIGN KEY (clip_id) REFERENCES clips(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_clips_device ON clips(device_id);
  CREATE INDEX IF NOT EXISTS idx_clips_type ON clips(type);
  CREATE INDEX IF NOT EXISTS idx_clips_created ON clips(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_clips_content ON clips(content);
`);

module.exports = db;
