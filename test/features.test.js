import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { DatabaseSync } from 'node:sqlite';

async function fixture(t, options = {}) {
  const tempRoot = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempRoot, 'ryadom-features-'));
  const mail = [];
  const app = createApp({ abuseProtection: false, dataDir: dir, sendMail: async message => { mail.push(message); }, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(path.resolve(dir)), tempRoot);
    assert.ok(path.basename(dir).startsWith('ryadom-features-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  class Client {
    cookie = '';
    async call(method, url, body) {
      const res = await fetch(base + url, { method, headers: { Cookie: this.cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (res.headers.get('set-cookie')) this.cookie = res.headers.get('set-cookie').split(';')[0];
      return { status: res.status, data: await res.json() };
    }
    get(url) { return this.call('GET', url); }
    post(url, body = {}) { return this.call('POST', url, body); }
    patch(url, body) { return this.call('PATCH', url, body); }
    async upload(data, scope = '') {
      const res = await fetch(base + '/api/uploads' + scope, { method: 'POST', headers: { Cookie: this.cookie }, body: data });
      return { status: res.status, data: await res.json() };
    }
  }
  async function register(name) {
    const c = new Client();
    const response = await c.post('/api/auth/register', { name, email: `${name}@example.test`, password: 'password123', city: 'Казань' });
    assert.equal(response.status, 201);
    c.id = response.data.user.id; return c;
  }
  const token = (email, index = -1) => mail.filter(m => m.to === email).at(index).text.match(/token=([A-Za-z0-9_-]+)/)[1];
  return { app, dir, base, mail, token, register, anon: new Client(), Client };
}
const listing = (over = {}) => ({ title: 'Тестовый автомобиль', description: 'Полное описание автомобиля', price: 15000, category: 'transport', city: 'Казань', condition: 'used', ...over });

test('verification and reset tokens expire, are single-use and revoke sessions', async t => {
  const f = await fixture(t), owner = await f.register('owner');
  const verify = f.token('owner@example.test');
  assert.equal((await owner.get('/api/me')).data.user.emailVerified, false);
  assert.equal((await f.anon.post('/api/auth/verify', { token: verify })).status, 200);
  assert.equal((await f.anon.post('/api/auth/verify', { token: verify })).status, 400);
  assert.equal((await owner.get('/api/me')).data.user.emailVerified, true);
  const unknown = await f.anon.post('/api/auth/forgot', { email: 'missing@example.test' });
  const known = await f.anon.post('/api/auth/forgot', { email: 'owner@example.test' });
  assert.deepEqual(unknown, known);
  const expired = f.token('owner@example.test');
  f.app.db.prepare('UPDATE account_tokens SET expires_at = 0').run();
  assert.equal((await f.anon.post('/api/auth/reset', { token: expired, password: 'new-password' })).status, 400);
  await f.anon.post('/api/auth/forgot', { email: 'owner@example.test' });
  const reset = f.token('owner@example.test');
  const race = await Promise.all([1,2].map(() => f.anon.post('/api/auth/reset', { token: reset, password: 'new-password' })));
  assert.deepEqual(race.map(r => r.status).sort(), [200,400]);
  assert.equal((await owner.get('/api/me')).data.user, null);
  assert.equal((await owner.post('/api/auth/login', { email: 'owner@example.test', password: 'password123' })).status, 401);
  assert.equal((await owner.post('/api/auth/login', { email: 'owner@example.test', password: 'new-password' })).status, 200);
  assert.equal(JSON.stringify((await f.anon.get(`/api/users/${owner.id}`)).data).includes('token'), false);
});

test('profile settings validate ownership; email change requires password and confirmation', async t => {
  const f = await fixture(t), owner = await f.register('owner'), other = await f.register('other');
  const image = await sharp({ create: { width: 8, height: 6, channels: 3, background: 'red' } }).png().toBuffer();
  const photo = (await owner.upload(image)).data.url;
  const profile = { name: 'Новое имя', city: 'Омск', about: 'Описание', avatar: photo, role: 'admin', emailVerified: true };
  assert.equal((await other.patch('/api/me/profile', profile)).status, 400);
  const updated = await owner.patch('/api/me/profile', profile);
  assert.equal(updated.status, 200); assert.equal(updated.data.user.role, 'user'); assert.equal(updated.data.user.emailVerified, false);
  assert.equal((await f.anon.get(`/api/users/${owner.id}`)).data.user.about, 'Описание');
  assert.equal((await owner.post('/api/me/email', { email: 'new@example.test', currentPassword: 'wrong' })).status, 400);
  assert.equal((await owner.post('/api/me/email', { email: 'new@example.test', currentPassword: 'password123' })).status, 200);
  assert.equal((await owner.get('/api/me')).data.user.email, 'owner@example.test');
  assert.equal((await f.anon.post('/api/auth/verify', { token: f.token('new@example.test') })).status, 200);
  assert.equal((await owner.get('/api/me')).data.user, null);
  assert.equal((await owner.post('/api/auth/login', { email: 'new@example.test', password: 'password123' })).status, 200);
  const otherSession = new f.Client(); await otherSession.post('/api/auth/login', { email: 'new@example.test', password: 'password123' });
  assert.equal((await owner.post('/api/me/password', { currentPassword: 'password123', password: 'changed-password' })).status, 200);
  assert.equal((await otherSession.get('/api/me')).data.user, null);
  assert.ok((await owner.get('/api/me')).data.user);
});

test('moderation gates all public listing paths and blocks users, with an audit trail', async t => {
  const f = await fixture(t, { moderationRequired: true }), seller = await f.register('seller'), buyer = await f.register('buyer'), mod = await f.register('moderator');
  f.app.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(mod.id);
  const { id } = (await seller.post('/api/listings', listing())).data.listing;
  assert.equal((await buyer.get('/api/admin')).status, 403);
  assert.equal((await buyer.patch(`/api/admin/listings/${id}`, { moderation: 'approved' })).status, 403);
  assert.equal((await buyer.get(`/api/listings/${id}`)).status, 404);
  assert.equal((await f.anon.get('/api/listings')).data.total, 0);
  assert.equal((await seller.get(`/api/listings/${id}`)).status, 200);
  assert.equal((await mod.get('/api/admin')).data.listings.length, 1);
  assert.equal((await mod.patch(`/api/admin/listings/${id}`, { moderation: 'approved' })).status, 200);
  assert.equal((await f.anon.get('/api/listings')).data.total, 1);
  await buyer.call('PUT', `/api/favorites/${id}`);
  assert.equal((await buyer.post('/api/reports', { listingId: id, reason: 'Неверные сведения' })).status, 201);
  const report = (await mod.get('/api/admin')).data.reports[0];
  await mod.patch(`/api/admin/listings/${id}`, { moderation: 'rejected', note: 'Исправьте описание' });
  assert.equal((await buyer.get('/api/favorites')).data.items.length, 0);
  assert.equal((await buyer.post(`/api/listings/${id}/messages`, { text: 'test' })).status, 404);
  await seller.patch(`/api/listings/${id}`, { description: 'Исправленное описание товара' });
  assert.equal((await seller.get(`/api/listings/${id}`)).data.listing.moderation, 'pending');
  await mod.patch(`/api/admin/reports/${report.id}`, {});
  assert.equal((await mod.get('/api/admin')).data.reports.length, 0);
  await mod.patch(`/api/admin/listings/${id}`, { moderation: 'approved' });
  await mod.patch(`/api/admin/users/${seller.id}`, { blocked: true });
  assert.equal((await seller.get('/api/me')).data.user, null);
  assert.equal((await seller.post('/api/auth/login', { email: 'seller@example.test', password: 'password123' })).status, 403);
  assert.equal((await f.anon.get('/api/listings')).data.total, 0);
  assert.equal((await buyer.get(`/api/listings/${id}`)).status, 404);
  assert.equal((await mod.patch(`/api/admin/users/${mod.id}`, { blocked: true })).status, 400);
  assert.ok((await mod.get('/api/admin')).data.log.length >= 4);
});

test('category filters and saved searches share matching; notifications are private and deduplicated', async t => {
  const f = await fixture(t, { moderationRequired: true }), seller = await f.register('seller'), buyer = await f.register('buyer'), mod = await f.register('moderator');
  f.app.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(mod.id);
  await buyer.post('/api/searches', { name: 'Автомобиль', filters: { category: 'transport', min: '10000', max: '20000', attr_year_min: '2020', attr_brand: 'Lada' } });
  const { id } = (await seller.post('/api/listings', listing({ attributes: { brand: 'Lada', year: 2022, mileage: 1000, rooms: '3' } }))).data.listing;
  assert.equal((await buyer.get('/api/notifications')).data.items.length, 0);
  await mod.patch(`/api/admin/listings/${id}`, { moderation: 'approved' });
  const notifications = (await buyer.get('/api/notifications')).data.items;
  assert.equal(notifications.length, 1); assert.equal(notifications[0].listing_id, id);
  await mod.patch(`/api/admin/listings/${id}`, { moderation: 'approved' });
  assert.equal((await buyer.get('/api/notifications')).data.items.length, 1);
  assert.equal((await seller.get('/api/searches')).data.items.length, 0);
  await seller.post('/api/notifications/read', { ids: notifications.map(n => n.id) });
  assert.equal((await buyer.get('/api/notifications')).data.unread, 1);
  await buyer.post('/api/notifications/read', { ids: notifications.map(n => n.id) });
  assert.equal((await buyer.get('/api/notifications')).data.unread, 0);
  assert.equal((await buyer.get('/api/listings?category=transport&attr_year_min=2020&attr_brand=Lada')).data.total, 1);
  assert.equal((await buyer.get('/api/listings?category=transport&attr_year_min=2023')).data.total, 0);
  assert.equal((await buyer.get('/api/listings?sort=constructor')).status, 200);
  assert.equal((await seller.get(`/api/listings/${id}`)).data.listing.attributes.rooms, undefined);
  assert.equal((await seller.post('/api/listings', listing({ attributes: { year: 1800 } }))).status, 400);
  assert.equal((await seller.post('/api/listings', listing({ attributes: { year: true } }))).status, 400);
});

test('chat history pagination, explicit read receipts, image validation and private attachment access', async t => {
  const f = await fixture(t), seller = await f.register('seller'), buyer = await f.register('buyer'), stranger = await f.register('stranger');
  const { id } = (await seller.post('/api/listings', listing())).data.listing;
  const conv = (await buyer.post(`/api/listings/${id}/messages`, { text: 'start' })).data.conversationId;
  const insert = f.app.db.prepare('INSERT INTO messages (conversation_id,sender_id,text,created_at) VALUES (?,?,?,?)');
  for (let i = 0; i < 201; i++) insert.run(conv, seller.id, 'Message ' + i, Date.now());
  let page = (await buyer.get(`/api/conversations/${conv}`)).data, ids = page.messages.map(m => m.id);
  assert.equal(page.messages.length, 50);
  assert.equal((await buyer.get('/api/me')).data.unread, 201);
  await stranger.post(`/api/conversations/${conv}/read`, { ids });
  assert.equal((await buyer.get('/api/me')).data.unread, 201);
  await buyer.post(`/api/conversations/${conv}/read`, { ids });
  assert.equal((await buyer.get('/api/me')).data.unread, 151);
  while (page.nextBefore) { page = (await buyer.get(`/api/conversations/${conv}?before=${page.nextBefore}`)).data; ids.push(...page.messages.map(m => m.id)); }
  assert.equal(new Set(ids).size, 202);
  assert.equal((await buyer.upload(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0]))).status, 415);
  const image = await sharp({create:{width:2400,height:1200,channels:3,background:'red'}}).png().toBuffer();
  const uploaded = await buyer.upload(image, '?scope=chat');
  assert.equal(uploaded.status, 201);
  const url = uploaded.data.url;
  assert.equal((await fetch(f.base + url)).status, 404);
  assert.equal((await fetch(f.base + url, {headers:{Cookie:seller.cookie}})).status, 404);
  assert.equal((await buyer.post('/api/listings', listing({photos:[url]}))).status, 400);
  assert.equal((await stranger.post(`/api/conversations/${conv}/messages`, {attachments:[url]})).status, 404);
  assert.equal((await buyer.post(`/api/conversations/${conv}/messages`, {attachments:[url]})).status, 201);
  const photo = await fetch(f.base + url, {headers:{Cookie:seller.cookie}});
  assert.equal(photo.status, 200); assert.equal(photo.headers.get('cache-control'), 'private, no-store');
  const meta = await sharp(Buffer.from(await photo.arrayBuffer())).metadata();
  assert.equal(meta.width, 1920); assert.equal(meta.format, 'webp');
  assert.equal((await fetch(f.base + url, {headers:{Cookie:stranger.cookie}})).status, 404);
});

test('drafts accept incomplete listings, preserve changes and enforce ownership', async t => {
  const f = await fixture(t), owner = await f.register('owner'), other = await f.register('other');
  const payload = { title: 'Незаконченное', photos: [], price: '', attributes: {} };
  const draft = await owner.post('/api/drafts', { payload });
  assert.equal(draft.status, 201); const id = draft.data.id;
  assert.equal((await other.get(`/api/drafts/${id}`)).status, 404);
  assert.equal((await other.call('PUT', `/api/drafts/${id}`, { payload })).status, 404);
  assert.equal((await other.call('DELETE', `/api/drafts/${id}`)).status, 404);
  await owner.call('PUT', `/api/drafts/${id}`, { payload: { ...payload, description: 'Продолжение' } });
  assert.equal((await owner.get('/api/drafts')).data.items[0].payload.description, 'Продолжение');
  assert.equal((await f.anon.get('/api/listings')).data.total, 0);
  const published = await owner.post('/api/listings', listing());
  assert.equal(published.status, 201);
  await owner.patch(`/api/listings/${published.data.listing.id}`, { status: 'archived' });
  assert.equal((await f.anon.get('/api/listings')).data.total, 0);
  await owner.patch(`/api/listings/${published.data.listing.id}`, { status: 'active' });
  assert.equal((await f.anon.get('/api/listings')).data.total, 1);
  assert.equal((await other.post('/api/drafts', { listingId: published.data.listing.id, payload })).status, 403);
  await owner.call('DELETE', `/api/drafts/${id}`);
  assert.equal((await owner.get('/api/drafts')).data.items.length, 0);
});

test('database migration is repeatable and preserves records', async t => {
  const f = await fixture(t), user = await f.register('owner');
  await user.post('/api/listings', listing());
  const file = path.join(f.dir, 'ryadom.db');
  const second = openDb(file);
  assert.equal(second.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(second.prepare('SELECT COUNT(*) AS n FROM listings').get().n, 1);
  assert.equal(second.prepare('PRAGMA user_version').get().user_version, 2);
  second.close();
});

test('legacy database is backed up and upgraded without losing accounts or listings', async t => {
  const f = await fixture(t), file = path.join(f.dir, 'legacy.db');
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, city TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE listings (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL, description TEXT NOT NULL, price INTEGER NOT NULL, category TEXT NOT NULL,
    city TEXT NOT NULL, condition TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', photos TEXT NOT NULL DEFAULT '[]',
    search_text TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO users VALUES (1,'Legacy','old@example.test','hash','City',123);
    INSERT INTO listings VALUES (1,1,'Title','Description',500,'hobby','City','used','active','[]','title',42,123,123);`);
  legacy.close();
  const migrated = openDb(file);
  try {
    assert.equal(migrated.prepare('SELECT views FROM listings WHERE id = 1').get().views, 42);
    assert.equal(migrated.prepare('SELECT moderation FROM listings WHERE id = 1').get().moderation, 'approved');
    assert.equal(migrated.prepare('SELECT email FROM users WHERE id = 1').get().email, 'old@example.test');
    assert.equal(migrated.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.ok(fs.existsSync(file + '.before-v1.bak'));
    const backup = new DatabaseSync(file + '.before-v1.bak', { readOnly: true });
    assert.equal(backup.prepare('SELECT views FROM listings WHERE id = 1').get().views, 42);
    assert.equal(backup.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'role'), false);
    backup.close();
  } finally { migrated.close(); }
});
