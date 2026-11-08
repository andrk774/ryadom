import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file = path.join(process.env.DATA_DIR || path.join(root, 'data'), 'ryadom.db');
const email = process.argv[2]?.trim().toLowerCase();
if (!email || !fs.existsSync(file)) {
  console.error('Сначала запустите сервер и зарегистрируйте аккаунт. Затем: npm run admin -- email@example.com');
  process.exitCode = 1;
} else {
  const db = openDb(file);
  try {
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!user) throw new Error('Аккаунт не найден');
    db.prepare("UPDATE users SET role = 'admin', blocked = 0 WHERE id = ?").run(user.id);
    console.log('Аккаунту назначена роль модератора. Обновите страницу.');
  } finally { db.close(); }
}
