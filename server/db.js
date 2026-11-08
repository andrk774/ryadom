import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { upgradeOperations } from './schema-v2.js';
import { distanceKm } from './location.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  city TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  price INTEGER NOT NULL,
  category TEXT NOT NULL,
  city TEXT NOT NULL,
  condition TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  photos TEXT NOT NULL DEFAULT '[]',
  search_text TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listings_feed ON listings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_user ON listings(user_id, status);
CREATE TABLE IF NOT EXISTS uploads (
  filename TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, listing_id)
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL,
  UNIQUE (listing_id, buyer_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (seller_id, author_id)
);
`;

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const previousVersion = db.prepare('PRAGMA user_version').get().user_version;
  const migrationBackup = `${path}.before-v${previousVersion + 1}.bak`;
  if (previousVersion < 2 &&
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get() &&
      !fs.existsSync(migrationBackup)) {
    // SQLite creates a consistent snapshot before upgrading an existing database.
    db.prepare('VACUUM INTO ?').run(migrationBackup);
  }
  db.exec(SCHEMA);
  migrate(db);
  upgradeOperations(db);
  db.function('distance_km', { deterministic: true }, distanceKm);
  return db;
}

function migrate(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const additions = {
      users: { about: "TEXT NOT NULL DEFAULT ''", avatar: "TEXT NOT NULL DEFAULT ''", email_verified: 'INTEGER NOT NULL DEFAULT 0', role: "TEXT NOT NULL DEFAULT 'user'", blocked: 'INTEGER NOT NULL DEFAULT 0' },
      listings: { attributes: "TEXT NOT NULL DEFAULT '{}'", moderation: "TEXT NOT NULL DEFAULT 'approved'", moderation_note: "TEXT NOT NULL DEFAULT ''" },
      messages: { attachments: "TEXT NOT NULL DEFAULT '[]'" },
      uploads: { private: 'INTEGER NOT NULL DEFAULT 0' },
    };
    for (const [table, columns] of Object.entries(additions)) {
      const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
      for (const [name, type] of Object.entries(columns)) if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS account_tokens (
        hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL, email TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES users(id),
        listing_id INTEGER REFERENCES listings(id), user_id INTEGER REFERENCES users(id),
        reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS moderation_log (
        id INTEGER PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES users(id),
        action TEXT NOT NULL, target_id INTEGER NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS saved_searches (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, filters TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        search_id INTEGER REFERENCES saved_searches(id) ON DELETE CASCADE,
        listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
        text TEXT NOT NULL, read_at INTEGER, created_at INTEGER NOT NULL,
        UNIQUE(search_id, listing_id)
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id);
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        listing_id INTEGER REFERENCES listings(id), payload TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
}

// SQLite's LIKE and LOWER() only fold ASCII, so Cyrillic search would be
// case-sensitive. We store a normalized copy and normalize queries the same way.
export function normalizeText(text) {
  return String(text).toLowerCase().replaceAll('ё', 'е');
}

export function searchText(title, description) {
  return normalizeText(`${title} ${description}`);
}
