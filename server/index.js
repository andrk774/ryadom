import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { seed } from './seed.js';
import { createMailer } from './mail.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const baseUrl = (process.env.APP_URL || `http://127.0.0.1:${port}`).replace(/\/$/, '');
if (production && (!process.env.APP_URL || !baseUrl.startsWith('https://'))) throw new Error('В production задайте APP_URL с HTTPS');
if (production && (!process.env.TURNSTILE_SITE_KEY || !process.env.TURNSTILE_SECRET_KEY)) throw new Error('В production задайте TURNSTILE_SITE_KEY и TURNSTILE_SECRET_KEY');
const listingDays = Number(process.env.LISTING_DAYS || 30);
if (!Number.isInteger(listingDays) || listingDays < 1 || listingDays > 365) throw new Error('LISTING_DAYS: целое число от 1 до 365');

const app = createApp({
  dataDir, baseUrl,
  sendMail: createMailer({ dataDir, production }),
  moderationRequired: process.env.MODERATION_REQUIRED !== '0',
  cookieSecure: production || process.env.COOKIE_SECURE === '1',
  trustProxy: process.env.TRUST_PROXY === '1',
  listingDays,
  backupDir: process.env.BACKUP_DIR || path.join(dataDir, 'backups'),
  captchaSiteKey: process.env.TURNSTILE_SITE_KEY || '',
  captchaSecretKey: process.env.TURNSTILE_SECRET_KEY || '',
});

// Demo accounts have a public password, so they never get created in production.
if (!production && !app.db.prepare('SELECT 1 AS ok FROM users LIMIT 1').get()) {
  await seed(app.db);
  console.log('Добавлены демо-данные. Вход: anna@example.com / demo12345');
}

app.server.listen(port, host, () => {
  console.log(`Рядом запущен: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
});
let stopping = false;
const maintain = () => app.maintenance().catch(() => console.error(JSON.stringify({event:'maintenance_failed'})));
await maintain();
const maintenanceTimer = setInterval(maintain, 60000);
maintenanceTimer.unref();
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(maintenanceTimer);
  await app.close();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
