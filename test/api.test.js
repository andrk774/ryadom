import sharp from 'sharp';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';

let app;
let base;
let dir;
const PNG = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer();

class Client {
  cookie = '';
  async call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
  }
  get(url) { return this.call('GET', url); }
  post(url, body = {}) { return this.call('POST', url, body); }
  patch(url, body) { return this.call('PATCH', url, body); }
  async upload(data, type) {
    const res = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'Content-Type': type, Cookie: this.cookie }, body: data });
    return { status: res.status, data: await res.json() };
  }
}

async function register(name) {
  const client = new Client();
  const res = await client.post('/api/auth/register', { name, email: `${name}@example.com`, password: 'password123', city: 'Казань' });
  assert.equal(res.status, 201);
  client.id = res.data.user.id;
  return client;
}

const listing = (over = {}) => ({
  title: 'Велосипед Stels', description: 'Хороший ЁЖИК на раме, катается отлично', price: 15000,
  category: 'hobby', city: 'Казань', condition: 'used', ...over,
});

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryadom-test-'));
  app = createApp({ abuseProtection: false, dataDir: dir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('auth: register, session, wrong password, duplicate email, logout', async () => {
  const c = await register('auth');
  assert.equal((await c.get('/api/me')).data.user.name, 'auth');
  const anon = new Client();
  assert.equal((await anon.post('/api/auth/login', { email: 'auth@example.com', password: 'wrong-password' })).status, 401);
  assert.equal((await anon.post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong-password' })).status, 401);
  assert.equal((await anon.post('/api/auth/login', { email: 'AUTH@example.com', password: 'password123' })).status, 200);
  assert.equal((await new Client().post('/api/auth/register', { name: 'x2', email: 'auth@example.com', password: 'password123' })).status, 409);
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/me')).data.user, null);
});

test('passwords and emails are not exposed publicly', async () => {
  const c = await register('private');
  const { data } = await new Client().get(`/api/users/${c.id}`);
  const text = JSON.stringify(data);
  assert.ok(!text.includes('password'));
  assert.ok(!text.includes('private@example.com'));
});

test('listings require login and valid data', async () => {
  assert.equal((await new Client().post('/api/listings', listing())).status, 401);
  const c = await register('validator');
  assert.equal((await c.post('/api/listings', listing({ title: 'x' }))).status, 400);
  assert.equal((await c.post('/api/listings', listing({ price: -5 }))).status, 400);
  assert.equal((await c.post('/api/listings', listing({ category: 'nope' }))).status, 400);
});

test('search is case-insensitive for Cyrillic, treats ё as е, and escapes wildcards', async () => {
  const c = await register('searcher');
  const { data } = await c.post('/api/listings', listing({ title: 'Уникальный Самокат' }));
  const find = async (qs) => (await c.get(`/api/listings?${qs}`)).data.items.map((i) => i.id);
  assert.ok((await find(`q=${encodeURIComponent('УНИКАЛЬНЫЙ самокат')}`)).includes(data.listing.id));
  assert.ok((await find(`q=${encodeURIComponent('ежик')}`)).includes(data.listing.id));
  assert.ok(!(await find(`q=${encodeURIComponent('уникальный%самокат')}`)).includes(data.listing.id));
  assert.ok(!(await find(`q=${encodeURIComponent("' OR 1=1 --")}`)).includes(data.listing.id));
});

test('filters and sorting work', async () => {
  const c = await register('filterer');
  await c.post('/api/listings', listing({ title: 'Фильтр дешёвый', price: 100, category: 'pets', city: 'Омск' }));
  await c.post('/api/listings', listing({ title: 'Фильтр дорогой', price: 900, category: 'pets', city: 'Омск' }));
  const items = (await c.get(`/api/listings?category=pets&city=${encodeURIComponent('Омск')}&sort=price_desc`)).data.items;
  assert.deepEqual(items.map((i) => i.price), [900, 100]);
  const cheap = (await c.get(`/api/listings?category=pets&city=${encodeURIComponent('Омск')}&max=500`)).data.items;
  assert.deepEqual(cheap.map((i) => i.price), [100]);
});

test('only the owner can edit or delete; sold and deleted leave the feed', async () => {
  const owner = await register('owner');
  const other = await register('other');
  const { id } = (await owner.post('/api/listings', listing({ title: 'Ownership test item' }))).data.listing;
  assert.equal((await other.patch(`/api/listings/${id}`, { price: 1 })).status, 403);
  assert.equal((await other.call('DELETE', `/api/listings/${id}`)).status, 403);
  assert.equal((await owner.patch(`/api/listings/${id}`, { price: 1 })).data.listing.price, 1);
  assert.equal((await owner.patch(`/api/listings/${id}`, { status: 'deleted' })).status, 400);

  const inFeed = async () => (await owner.get('/api/listings?q=ownership')).data.items.length;
  assert.equal(await inFeed(), 1);
  await owner.patch(`/api/listings/${id}`, { status: 'sold' });
  assert.equal(await inFeed(), 0);
  assert.equal((await owner.call('DELETE', `/api/listings/${id}`)).status, 200);
  assert.equal((await owner.get(`/api/listings/${id}`)).status, 404);
});

test('views count visitors but not the owner', async () => {
  const owner = await register('viewowner');
  const { id } = (await owner.post('/api/listings', listing())).data.listing;
  await owner.get(`/api/listings/${id}`);
  assert.equal((await new Client().get(`/api/listings/${id}`)).data.listing.views, 1);
});

test('favorites', async () => {
  const owner = await register('favowner');
  const fan = await register('fan');
  const { id } = (await owner.post('/api/listings', listing())).data.listing;
  await fan.call('PUT', `/api/favorites/${id}`);
  await fan.call('PUT', `/api/favorites/${id}`);
  assert.equal((await fan.get('/api/favorites')).data.items.length, 1);
  assert.equal((await fan.get(`/api/listings/${id}`)).data.listing.isFavorite, true);
  assert.equal((await owner.get(`/api/listings/${id}`)).data.listing.isFavorite, false);
  await fan.call('DELETE', `/api/favorites/${id}`);
  assert.equal((await fan.get('/api/favorites')).data.items.length, 0);
});

test('chat: unread counters, privacy, no self-messaging', async () => {
  const seller = await register('chatseller');
  const buyer = await register('chatbuyer');
  const stranger = await register('chatstranger');
  const { id } = (await seller.post('/api/listings', listing())).data.listing;
  assert.equal((await seller.post(`/api/listings/${id}/messages`, { text: 'hi' })).status, 400);
  assert.equal((await buyer.post(`/api/listings/${id}/messages`, { text: '  ' })).status, 400);
  assert.equal((await buyer.get('/api/conversations')).data.items.length, 0, 'rejected first message leaves no chat');

  const first = await buyer.post(`/api/listings/${id}/messages`, { text: 'Привет' });
  const second = await buyer.post(`/api/listings/${id}/messages`, { text: 'Ещё раз' });
  assert.equal(first.data.conversationId, second.data.conversationId);
  const conv = first.data.conversationId;

  assert.equal((await seller.get('/api/me')).data.unread, 2);
  assert.equal((await stranger.get(`/api/conversations/${conv}`)).status, 404);
  assert.equal((await stranger.post(`/api/conversations/${conv}/messages`, { text: 'x' })).status, 404);
  const read = await seller.get(`/api/conversations/${conv}`);
  assert.equal(read.data.messages.length, 2);
  await seller.post(`/api/conversations/${conv}/read`, { ids: read.data.messages.map(m => m.id) });
  assert.equal((await seller.get('/api/me')).data.unread, 0);
  assert.equal((await seller.post(`/api/conversations/${conv}/messages`, { text: 'Да' })).status, 201);
  assert.equal((await buyer.get('/api/me')).data.unread, 1);
});

test('reviews require a prior chat and update instead of duplicating', async () => {
  const seller = await register('revseller');
  const buyer = await register('revbuyer');
  const { id } = (await seller.post('/api/listings', listing())).data.listing;
  const url = `/api/users/${seller.id}/reviews`;
  assert.equal((await buyer.post(url, { rating: 5, text: 'x' })).status, 403);
  assert.equal((await seller.post(url, { rating: 5 })).status, 400);
  await buyer.post(`/api/listings/${id}/messages`, { text: 'Привет' });
  assert.equal((await buyer.post(url, { rating: 9 })).status, 400);
  assert.equal((await buyer.post(url, { rating: 5, text: 'Отлично' })).status, 201);
  assert.equal((await buyer.post(url, { rating: 3, text: 'Передумал' })).status, 201);
  const { data } = await buyer.get(`/api/users/${seller.id}`);
  assert.equal(data.reviews.length, 1);
  assert.equal(data.user.rating, 3);
});

test('uploads: only real images, only own photos can be attached', async () => {
  const c = await register('uploader');
  const other = await register('uploader2');
  assert.equal((await c.upload(Buffer.from('<svg onload="alert(1)"></svg>'), 'image/png')).status, 415);
  const ok = await c.upload(PNG, 'image/png');
  assert.equal(ok.status, 201);
  const file = await fetch(base + ok.data.url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/webp');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  await file.arrayBuffer();
  assert.equal((await c.post('/api/listings', listing({ photos: [ok.data.url] }))).status, 201);
  assert.equal((await other.post('/api/listings', listing({ photos: [ok.data.url] }))).status, 400);
  assert.equal((await c.post('/api/listings', listing({ photos: ['https://evil.example/x.png'] }))).status, 400);
  const big = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'Content-Type': 'image/png', Cookie: c.cookie }, body: Buffer.alloc(11 * 1024 * 1024) });
  assert.equal(big.status, 413);
});

test('cross-site writes are rejected', async () => {
  const c = await register('csrf');
  const res = await c.call('POST', '/api/listings', listing(), { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
});

test('static serving cannot escape the public folder', async () => {
  const statusOf = async (url) => {
    const res = await fetch(base + url);
    await res.arrayBuffer();
    return res.status;
  };
  assert.equal(await statusOf('/'), 200);
  assert.equal(await statusOf('/..%2fpackage.json'), 404);
  assert.equal(await statusOf('/..%5cpackage.json'), 404);
  assert.equal(await statusOf('/uploads/..%2f..%2fryadom.db'), 404);
  assert.equal(await statusOf('/%E0%A4%A'), 400);
});

test('session cookie is HttpOnly and SameSite', async () => {
  const c = new Client();
  const res = await c.post('/api/auth/register', { name: 'cookie', email: 'cookie@example.com', password: 'password123' });
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});
