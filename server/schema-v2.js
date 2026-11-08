export function upgradeOperations(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = {
      users: { email_notifications: 'INTEGER NOT NULL DEFAULT 0' },
      listings: { district: "TEXT NOT NULL DEFAULT ''", latitude: 'REAL', longitude: 'REAL', expires_at: 'INTEGER NOT NULL DEFAULT 0' },
      notifications: { kind: "TEXT NOT NULL DEFAULT 'listing'", conversation_id: 'INTEGER REFERENCES conversations(id)', dedupe_key: 'TEXT' },
    };
    for (const [table, fields] of Object.entries(columns)) {
      const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
      for (const [name, type] of Object.entries(fields)) if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
    db.prepare('UPDATE listings SET expires_at = ? WHERE expires_at = 0').run(Date.now() + 30 * 86400000);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_dedupe ON notifications(dedupe_key);
      CREATE TABLE IF NOT EXISTS user_blocks (user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, blocked_id INTEGER REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, PRIMARY KEY(user_id,blocked_id));
      CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS captcha_tokens (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS view_events (listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE, day TEXT NOT NULL, viewer TEXT NOT NULL, PRIMARY KEY(listing_id,day,viewer));
      CREATE TABLE IF NOT EXISTS listing_stats (listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE, day TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0, favorites INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(listing_id,day));
      CREATE TABLE IF NOT EXISTS mail_jobs (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, conversation_id INTEGER REFERENCES conversations(id), dedupe_key TEXT UNIQUE, subject TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS maintenance_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS error_events (id INTEGER PRIMARY KEY, request_id TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, code TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_mail_due ON mail_jobs(status,due_at);
      PRAGMA user_version = 2;
    `);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
