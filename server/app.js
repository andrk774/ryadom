import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openDb, normalizeText, searchText } from './db.js';
import { CATEGORIES, CITIES, CONDITIONS } from './catalog.js';
import sharp from 'sharp';
import { FIELDS, validateAttributes, listingFilters } from './fields.js';
import { installFeatures, notifyMatches } from './features.js';
import { createMailer } from './mail.js';
import { createAbuse } from './abuse.js';
import { installOperations } from './operations.js';
import { locationFields } from './location.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const scrypt = promisify(crypto.scrypt);

const SESSION_TTL = 30 * 24 * 3600 * 1000;
const MAX_JSON = 64 * 1024;
const MAX_UPLOAD = 10 * 1024 * 1024;
const MAX_PHOTOS = 10;
const PAGE_SIZE = 24;
const UPLOAD_NAME = /^[a-f0-9]{32}\.(jpg|png|webp)$/;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};
const SORTS = {
  new: 'l.created_at DESC, l.id DESC',
  price_asc: 'l.price ASC, l.id DESC',
  price_desc: 'l.price DESC, l.id DESC',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const actual = await scrypt(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

function detectImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        reject(new HttpError(413, 'Слишком большой запрос'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const str = (value) => (typeof value === 'string' ? value.trim() : '');
const toInt = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

export function createApp({ dataDir, cookieSecure = false, trustProxy = false, moderationRequired = false,
  baseUrl = 'http://127.0.0.1:3000', sendMail = createMailer({ dataDir }), listingDays = 30, backupDir,
  abuseProtection = true, captchaSiteKey = '', captchaSecretKey = '', verifyCaptcha }) {
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const db = openDb(path.join(dataDir, 'ryadom.db'));
  const q = (sql) => db.prepare(sql);

  const abuse = createAbuse({ db, fail, siteKey: captchaSiteKey, secretKey: captchaSecretKey, hostname: new URL(baseUrl).hostname, verifyCaptcha });
  const limit = abuse.limit;
  function clientIp(req) {
    if (trustProxy) {
      const forwarded = str(req.headers['x-forwarded-for']).split(',').pop().trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress;
  }

  // --- sessions ---
  const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
  function sessionCookie(value, maxAge) {
    return `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieSecure ? '; Secure' : ''}`;
  }
  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    q('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash(token), userId, Date.now() + SESSION_TTL);
    res.setHeader('Set-Cookie', sessionCookie(token, SESSION_TTL / 1000));
  }
  function sessionToken(req) {
    const match = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
    return match ? match[1] : null;
  }
  function currentUser(req) {
    const token = sessionToken(req);
    if (!token) return null;
    return q(`SELECT u.* FROM sessions s
              JOIN users u ON u.id = s.user_id
              WHERE s.token_hash = ? AND s.expires_at > ? AND u.blocked = 0`).get(tokenHash(token), Date.now()) || null;
  }
  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, city: u.city, createdAt: u.created_at,
    about: u.about, avatar: u.avatar, emailVerified: Boolean(u.email_verified), role: u.role, emailNotifications: Boolean(u.email_notifications) });

  // --- serializers ---
  function sellerSummary(userId) {
    const u = q('SELECT id, name, city, created_at, about, avatar, email_verified, blocked FROM users WHERE id = ?').get(userId);
    const r = q('SELECT AVG(rating) AS avg, COUNT(*) AS n FROM reviews WHERE seller_id = ?').get(userId);
    return {
      id: u.id, name: u.name, city: u.city, createdAt: u.created_at, about: u.about, avatar: u.avatar, emailVerified: Boolean(u.email_verified), blocked: Boolean(u.blocked),
      rating: r.n ? Math.round(r.avg * 10) / 10 : null, reviewCount: r.n,
    };
  }
  const serialize = (l) => ({
    id: l.id, title: l.title, description: l.description, price: l.price,
    category: l.category, city: l.city, condition: l.condition, status: l.status,
    photos: JSON.parse(l.photos), views: l.views, userId: l.user_id,
    createdAt: l.created_at, updatedAt: l.updated_at, isFavorite: Boolean(l.is_favorite),
    attributes: JSON.parse(l.attributes || '{}'), moderation: l.moderation, moderationNote: l.moderation_note, district: l.district, latitude: l.latitude, longitude: l.longitude, expiresAt: l.expires_at,
  });
  const SELECT_LISTING = `SELECT l.*, EXISTS(
      SELECT 1 FROM favorites f WHERE f.listing_id = l.id AND f.user_id = ?
    ) AS is_favorite FROM listings l`;

  function getListing(id, viewer) {
    const row = q(`${SELECT_LISTING} WHERE l.id = ? AND l.status != 'deleted'`).get(viewer?.id ?? 0, id);
    if (!row) fail(404, 'Объявление не найдено');
    if (viewer?.id !== row.user_id && viewer?.role !== 'admin' &&
      (row.moderation !== 'approved' || q('SELECT blocked FROM users WHERE id = ?').get(row.user_id).blocked)) fail(404, 'Объявление не найдено');
    return row;
  }
  function getOwnListing(id, user) {
    const row = getListing(id, user);
    if (row.user_id !== user.id) fail(403, 'Это не ваше объявление');
    return row;
  }

  function validateListing(input, user) {
    const title = str(input.title);
    const description = str(input.description);
    const price = toInt(input.price);
    const { category, city, condition } = input;
    if (title.length < 3 || title.length > 100) fail(400, 'Название: от 3 до 100 символов');
    if (description.length < 10 || description.length > 5000) fail(400, 'Описание: от 10 до 5000 символов');
    if (price === null || price > 100_000_000_000) fail(400, 'Укажите корректную цену');
    if (!CATEGORIES.some((c) => c.id === category)) fail(400, 'Выберите категорию');
    if (!CITIES.includes(city)) fail(400, 'Выберите город');
    if (!CONDITIONS.some((c) => c.id === condition)) fail(400, 'Выберите состояние');
    const photos = input.photos ?? [];
    validatePhotos(photos, user, false);
    return { title, description, price, category, city, condition, photos: [...new Set(photos)], attributes: validateAttributes(category, input.attributes, fail), ...locationFields(input, fail) };
  }

  function validatePhotos(photos, user, privatePhotos = false) {
    if (!Array.isArray(photos)) fail(400, 'Некорректные фотографии');
    if (photos.length > MAX_PHOTOS) fail(400, `Не больше ${MAX_PHOTOS} фотографий`);
    for (const url of photos) {
      const name = typeof url === 'string' && url.startsWith('/uploads/') ? url.slice(9) : '';
      const owned = UPLOAD_NAME.test(name)
        && q('SELECT 1 AS ok FROM uploads WHERE filename = ? AND user_id = ? AND private = ?').get(name, user.id, Number(privatePhotos));
      if (!owned) fail(400, 'Некорректная фотография');
    }
    return photos;
  }

  function requireUser(ctx) {
    if (!ctx.user) fail(401, 'Войдите в аккаунт');
    if (ctx.user.blocked) fail(403, 'Аккаунт заблокирован');
    return ctx.user;
  }

  function addMessage(conversationId, senderId, rawText, attachments = []) {
    const text = str(rawText);
    if ((!text && !attachments.length) || text.length > 2000) fail(400, 'Добавьте текст или фотографию (до 2000 символов)');
    validatePhotos(attachments, { id: senderId }, true);
    if (attachments.length > 3) fail(400, 'До 3 фотографий в сообщении');
    const conv = q('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    if (operations.isBlocked(conv.buyer_id, conv.seller_id)) fail(403, 'Переписка недоступна: один из участников заблокирован');
    if (q('SELECT 1 FROM users WHERE id IN (?,?) AND blocked = 1').get(conv.buyer_id, conv.seller_id)) fail(403, 'Участник переписки заблокирован');
    limit(`msg:${senderId}`, 60, 60_000);
    const now = Date.now();
    q('INSERT INTO messages (conversation_id, sender_id, text, attachments, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(conversationId, senderId, text, JSON.stringify(attachments), now);
    q('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
    operations.messageSent(conv, senderId);
  }

  // --- routes ---
  const routes = [];
  function route(method, pattern, handler, options = {}) {
    const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>\\d+)')}$`);
    routes.push({ method, regex, handler, options });
  }

  route('GET', '/api/meta', () => ({ categories: CATEGORIES, cities: CITIES, conditions: CONDITIONS, fields: FIELDS, moderationRequired, listingDays, captchaSiteKey }));

  route('GET', '/api/me', ({ user }) => {
    if (!user) return { user: null, unread: 0 };
    const { n } = q(`SELECT COUNT(*) AS n FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE (c.buyer_id = ? OR c.seller_id = ?) AND m.sender_id != ? AND m.read_at IS NULL`)
      .get(user.id, user.id, user.id);
    return { user: publicUser(user), unread: n, notifications: q('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(user.id).n };
  });

  route('POST', '/api/auth/register', async ({ req, res, body }) => {
    limit(`auth:${clientIp(req)}`, 30, 600_000);
    const name = str(body.name);
    const email = str(body.email).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const city = CITIES.includes(body.city) ? body.city : CITIES[0];
    if (name.length < 2 || name.length > 40) fail(400, 'Имя: от 2 до 40 символов');
    if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Некорректный email');
    if (password.length < 8 || password.length > 200) fail(400, 'Пароль: минимум 8 символов');
    const hash = await hashPassword(password);
    if (q('SELECT 1 AS ok FROM users WHERE email = ?').get(email)) fail(409, 'Этот email уже зарегистрирован');
    const { lastInsertRowid } = q('INSERT INTO users (name, email, password_hash, city, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, email, hash, city, Date.now());
    const id = Number(lastInsertRowid);
    startSession(res, id);
    try { await features.issueToken(q('SELECT * FROM users WHERE id = ?').get(id), 'verify'); }
    catch { console.error('Не удалось отправить подтверждение почты'); }
    return { user: publicUser(q('SELECT * FROM users WHERE id = ?').get(id)) };
  }, { status: 201 });

  // Verifying against a dummy hash keeps response time the same for unknown emails.
  const dummyHash = `${'0'.repeat(32)}:${crypto.scryptSync('x', '0'.repeat(32), 64).toString('hex')}`;
  route('POST', '/api/auth/login', async ({ req, res, body }) => {
    limit(`auth:${clientIp(req)}`, 30, 600_000);
    const email = str(body.email).toLowerCase();
    const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    const row = q('SELECT * FROM users WHERE email = ?').get(email);
    const ok = await verifyPassword(password, row ? row.password_hash : dummyHash);
    if (!row || !ok) fail(401, 'Неверный email или пароль');
    const latest = q('SELECT * FROM users WHERE id = ?').get(row.id);
    if (latest.blocked) fail(403, 'Аккаунт заблокирован');
    if (latest.password_hash !== row.password_hash) fail(401, 'Пароль изменился. Войдите снова.');
    startSession(res, row.id);
    return { user: publicUser(row) };
  });

  route('POST', '/api/auth/logout', ({ req, res }) => {
    const token = sessionToken(req);
    if (token) q('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    return { ok: true };
  });

  route('GET', '/api/listings', ({ query, user }) => {
    const filters = listingFilters(query);
    const where = ["l.status = 'active'", "l.moderation = 'approved'", 'EXISTS (SELECT 1 FROM users u WHERE u.id = l.user_id AND u.blocked = 0)', ...filters.where];
    where.push('l.expires_at > ?');
    const args = [...filters.args, Date.now()];

    const clause = where.join(' AND ');
    const total = q(`SELECT COUNT(*) AS n FROM listings l WHERE ${clause}`).get(...args).n;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(Math.max(1, toInt(query.get('page')) ?? 1), pages);
    const order = Object.hasOwn(SORTS, query.get('sort')) ? SORTS[query.get('sort')] : SORTS.new;
    const rows = q(`${SELECT_LISTING} WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(user?.id ?? 0, ...args, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    return { items: rows.map(serialize), total, page, pages };
  });

  route('GET', '/api/me/listings', (ctx) => {
    const user = requireUser(ctx);
    const rows = q(`${SELECT_LISTING} WHERE l.user_id = ? AND l.status != 'deleted' ORDER BY l.created_at DESC`)
      .all(user.id, user.id);
    return { items: rows.map(serialize) };
  });

  route('GET', '/api/listings/:id', ({ params, user, req }) => {
    const row = getListing(params.id, user);
    if (row.user_id !== user?.id) {
      if (operations.recordView(row.id, user ? `user:${user.id}` : `ip:${clientIp(req)}`)) row.views += 1;
    }
    return { listing: serialize(row), seller: sellerSummary(row.user_id) };
  });

  route('POST', '/api/listings', (ctx) => {
    const user = requireUser(ctx);
    limit(`listing:${user.id}`, 30, 3600_000);
    const v = validateListing(ctx.body, user);
    const now = Date.now();
    const { lastInsertRowid } = q(`INSERT INTO listings
      (user_id, title, description, price, category, city, condition, photos, search_text, created_at, updated_at, attributes, moderation, district, latitude, longitude, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      user.id, v.title, v.description, v.price, v.category, v.city, v.condition,
      JSON.stringify(v.photos), searchText(v.title, v.description), now, now, JSON.stringify(v.attributes), moderationRequired ? 'pending' : 'approved', v.district, v.latitude, v.longitude, now + listingDays * 86400000,
    );
    notifyListing(Number(lastInsertRowid));
    return { listing: serialize(getListing(Number(lastInsertRowid), user)) };
  }, { status: 201 });

  route('PATCH', '/api/listings/:id', (ctx) => {
    const user = requireUser(ctx);
    const row = getOwnListing(ctx.params.id, user);
    const v = validateListing({ ...serialize(row), ...ctx.body }, user);
    const status = ctx.body.status ?? row.status;
    if (!['active', 'sold', 'archived'].includes(status)) fail(400, 'Некорректный статус');
    const contentChanged = ['title','description','price','category','city','condition','photos','attributes','district','latitude','longitude'].some(key => Object.hasOwn(ctx.body, key));
    const republishing = status === 'active' && row.status !== 'active';
    const moderation = moderationRequired && (contentChanged || republishing) ? 'pending' : row.moderation;
    q(`UPDATE listings SET title = ?, description = ?, price = ?, category = ?, city = ?, condition = ?,
       photos = ?, search_text = ?, status = ?, updated_at = ?, attributes = ?, moderation = ?, moderation_note = ?, created_at = ?, district = ?, latitude = ?, longitude = ?, expires_at = ? WHERE id = ?`).run(
      v.title, v.description, v.price, v.category, v.city, v.condition, JSON.stringify(v.photos),
      searchText(v.title, v.description), status, Date.now(), JSON.stringify(v.attributes), moderation, moderation === 'pending' ? '' : row.moderation_note, republishing ? Date.now() : row.created_at, v.district, v.latitude, v.longitude, republishing ? Date.now() + listingDays * 86400000 : row.expires_at, row.id,
    );
    if (republishing) notifyListing(row.id);
    return { listing: serialize(getListing(row.id, user)) };
  });

  // Soft delete: existing chats about the listing stay readable.
  route('DELETE', '/api/listings/:id', (ctx) => {
    const row = getOwnListing(ctx.params.id, requireUser(ctx));
    q("UPDATE listings SET status = 'deleted', updated_at = ? WHERE id = ?").run(Date.now(), row.id);
    q('DELETE FROM favorites WHERE listing_id = ?').run(row.id);
    return { ok: true };
  });

  route('POST', '/api/uploads', async (ctx) => {
    const user = requireUser(ctx);
    limit(`upload:${user.id}`, 100, 3600_000);
    const data = await readBody(ctx.req, MAX_UPLOAD);
    if (!detectImage(data)) fail(415, 'Поддерживаются только JPEG, PNG и WebP');
    let normalized;
    try {
      normalized = await sharp(data, { limitInputPixels: 40000000, failOn: 'warning' })
        .rotate().resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    } catch { fail(415, 'Фотография повреждена или превышает 40 мегапикселей'); }
    const filename = `${crypto.randomBytes(16).toString('hex')}.webp`;
    await fs.promises.writeFile(path.join(uploadsDir, filename), normalized);
    q('INSERT INTO uploads (filename, user_id, created_at, private) VALUES (?, ?, ?, ?)').run(filename, user.id, Date.now(), ctx.query.get('scope') === 'chat' ? 1 : 0);
    return { url: `/uploads/${filename}` };
  }, { status: 201, rawBody: true });

  route('GET', '/api/favorites', (ctx) => {
    const user = requireUser(ctx);
    const rows = q(`${SELECT_LISTING} JOIN favorites fav ON fav.listing_id = l.id AND fav.user_id = ?
      WHERE l.status != 'deleted' AND l.moderation = 'approved' AND EXISTS (SELECT 1 FROM users u WHERE u.id = l.user_id AND u.blocked = 0) ORDER BY fav.created_at DESC`).all(user.id, user.id);
    return { items: rows.map(serialize) };
  });
  route('PUT', '/api/favorites/:id', (ctx) => {
    const user = requireUser(ctx);
    const row = getListing(ctx.params.id, user);
    if (q('INSERT OR IGNORE INTO favorites (user_id, listing_id, created_at) VALUES (?, ?, ?)').run(user.id, row.id, Date.now()).changes) operations.recordFavorite(row.id);
    return { ok: true };
  });
  route('DELETE', '/api/favorites/:id', (ctx) => {
    q('DELETE FROM favorites WHERE user_id = ? AND listing_id = ?').run(requireUser(ctx).id, ctx.params.id);
    return { ok: true };
  });

  // --- chat ---
  route('POST', '/api/listings/:id/messages', (ctx) => {
    const user = requireUser(ctx);
    const row = getListing(ctx.params.id, user);
    if (operations.isBlocked(user.id, row.user_id)) fail(403, 'Переписка недоступна');
    if (row.user_id === user.id) fail(400, 'Нельзя написать самому себе');
    let conv = q('SELECT id FROM conversations WHERE listing_id = ? AND buyer_id = ?').get(row.id, user.id);
    if (!conv) {
      if (row.status !== 'active' || row.expires_at <= Date.now()) fail(400, 'Объявление уже неактивно');
      const { lastInsertRowid } = q('INSERT INTO conversations (listing_id, buyer_id, seller_id, updated_at) VALUES (?, ?, ?, ?)')
        .run(row.id, user.id, row.user_id, Date.now());
      conv = { id: Number(lastInsertRowid) };
    }
    try {
      addMessage(conv.id, user.id, ctx.body.text, ctx.body.attachments || []);
    } catch (err) {
      // Do not leave an empty chat behind if the first message was rejected.
      q('DELETE FROM conversations WHERE id = ? AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = ?)').run(conv.id, conv.id);
      throw err;
    }
    return { conversationId: conv.id };
  }, { status: 201 });

  route('GET', '/api/conversations', (ctx) => {
    const user = requireUser(ctx);
    const rows = q(`SELECT c.*, l.title, l.price, l.photos, l.status, l.category,
        other.id AS other_id, other.name AS other_name,
        (SELECT text FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_text,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_id != ? AND read_at IS NULL) AS unread
      FROM conversations c
      JOIN listings l ON l.id = c.listing_id
      JOIN users other ON other.id = CASE WHEN c.buyer_id = ? THEN c.seller_id ELSE c.buyer_id END
      WHERE c.buyer_id = ? OR c.seller_id = ?
      ORDER BY c.updated_at DESC`).all(user.id, user.id, user.id, user.id);
    return {
      items: rows.map((r) => ({
        id: r.id, updatedAt: r.updated_at, lastText: r.last_text, unread: r.unread,
        other: { id: r.other_id, name: r.other_name },
        listing: { id: r.listing_id, title: r.title, price: r.price, status: r.status, category: r.category, photos: JSON.parse(r.photos) },
      })),
    };
  });

  function getConversation(id, user) {
    const conv = q('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!conv || (conv.buyer_id !== user.id && conv.seller_id !== user.id)) fail(404, 'Диалог не найден');
    return conv;
  }

  route('GET', '/api/conversations/:id', (ctx) => {
    const user = requireUser(ctx);
    const conv = getConversation(ctx.params.id, user);
    const before = toInt(ctx.query.get('before')) || Number.MAX_SAFE_INTEGER;
    const messages = q(`SELECT * FROM (SELECT id, sender_id, text, attachments, created_at, read_at FROM messages
      WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT 50) ORDER BY id`).all(conv.id, before);
    // Read receipts are explicit: polling a background tab must not read messages.
    const nextBefore = messages.length && q('SELECT 1 FROM messages WHERE conversation_id = ? AND id < ?').get(conv.id, messages[0].id) ? messages[0].id : null;
    const listing = q('SELECT id, title, price, status, category, photos FROM listings WHERE id = ?').get(conv.listing_id);
    const otherId = conv.buyer_id === user.id ? conv.seller_id : conv.buyer_id;
    return {
      id: conv.id, nextBefore, blocked: operations.isBlocked(conv.buyer_id, conv.seller_id), blockedByMe: Boolean(q('SELECT 1 FROM user_blocks WHERE user_id=? AND blocked_id=?').get(user.id, otherId)),
      listing: { ...listing, photos: JSON.parse(listing.photos) },
      other: { id: otherId, name: q('SELECT name FROM users WHERE id = ?').get(otherId).name },
      messages: messages.map((m) => ({ id: m.id, senderId: m.sender_id, text: m.text, attachments: JSON.parse(m.attachments), readAt: m.read_at, createdAt: m.created_at, mine: m.sender_id === user.id })),
    };
  });

  route('POST', '/api/conversations/:id/read', ctx => {
    const user = requireUser(ctx), conv = getConversation(ctx.params.id, user);
    for (const id of Array.isArray(ctx.body.ids) ? ctx.body.ids.slice(0, 200) : []) {
      if (Number.isSafeInteger(id)) q('UPDATE messages SET read_at = ? WHERE id = ? AND conversation_id = ? AND sender_id != ? AND read_at IS NULL').run(Date.now(), id, conv.id, user.id);
    }
    if (!q('SELECT 1 FROM messages WHERE conversation_id=? AND sender_id!=? AND read_at IS NULL').get(conv.id,user.id)) {
      q("UPDATE notifications SET read_at=? WHERE user_id=? AND conversation_id=? AND kind='message'").run(Date.now(),user.id,conv.id);
    }
    return { ok: true };
  });

  route('POST', '/api/conversations/:id/messages', (ctx) => {
    const user = requireUser(ctx);
    const conv = getConversation(ctx.params.id, user);
    addMessage(conv.id, user.id, ctx.body.text, ctx.body.attachments || []);
    return { ok: true };
  }, { status: 201 });

  // --- profiles and reviews ---
  // A review needs a real chat with the seller, which limits drive-by fake ratings.
  const hasDealt = (authorId, sellerId) => Boolean(q(`SELECT 1 AS ok FROM conversations c
    WHERE c.buyer_id = ? AND c.seller_id = ?
      AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id) LIMIT 1`).get(authorId, sellerId));

  route('GET', '/api/users/:id', ({ params, user }) => {
    if (!q('SELECT 1 AS ok FROM users WHERE id = ?').get(params.id)) fail(404, 'Пользователь не найден');
    const reviews = q(`SELECT r.id, r.rating, r.text, r.created_at, u.id AS author_id, u.name AS author_name
      FROM reviews r JOIN users u ON u.id = r.author_id
      WHERE r.seller_id = ? ORDER BY r.created_at DESC LIMIT 50`).all(params.id);
    return {
      user: sellerSummary(params.id),
      canReview: Boolean(user) && hasDealt(user.id, params.id),
      reviews: reviews.map((r) => ({
        id: r.id, rating: r.rating, text: r.text, createdAt: r.created_at,
        author: { id: r.author_id, name: r.author_name },
      })),
    };
  });

  route('POST', '/api/users/:id/reviews', (ctx) => {
    const user = requireUser(ctx);
    const sellerId = ctx.params.id;
    if (!q('SELECT 1 AS ok FROM users WHERE id = ?').get(sellerId)) fail(404, 'Пользователь не найден');
    if (sellerId === user.id) fail(400, 'Нельзя оставить отзыв самому себе');
    if (!hasDealt(user.id, sellerId)) fail(403, 'Отзыв можно оставить только после переписки с продавцом');
    const rating = toInt(ctx.body.rating);
    const text = str(ctx.body.text);
    if (rating === null || rating < 1 || rating > 5) fail(400, 'Оценка: от 1 до 5');
    if (text.length > 1000) fail(400, 'Отзыв: не длиннее 1000 символов');
    q(`INSERT INTO reviews (seller_id, author_id, rating, text, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (seller_id, author_id) DO UPDATE SET rating = excluded.rating, text = excluded.text, created_at = excluded.created_at`)
      .run(sellerId, user.id, rating, text, Date.now());
    return { ok: true };
  }, { status: 201 });

  const operations = installOperations({ route, q, db, fail, requireUser, getOwnListing, sendMail, baseUrl, dataDir, backupDir, listingDays, limit });
  const notifyListing = id => notifyMatches(q, id);
  const features = installFeatures({ route, q, db, fail, requireUser, publicUser, hashPassword, verifyPassword,
    startSession, limit, clientIp, sendMail, baseUrl, validatePhotos, serialize, getOwnListing, notifyListing, listingDays });

  // --- http plumbing ---
  function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  async function handleApi(req, res, url) {
    const origin = req.headers.origin;
    if (!['GET', 'HEAD'].includes(req.method) && origin) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* malformed origin is rejected below */ }
      if (host !== req.headers.host) fail(403, 'Запрос с другого сайта отклонён');
    }
    const matches = routes.map((r) => ({ r, m: r.regex.exec(url.pathname) })).filter((x) => x.m);
    if (!matches.length) fail(404, 'Не найдено');
    const found = matches.find((x) => x.r.method === req.method);
    if (!found) fail(405, 'Метод не поддерживается');

    let body = {};
    if (!found.r.options.rawBody && !['GET', 'HEAD'].includes(req.method)) {
      const raw = await readBody(req, MAX_JSON);
      if (raw.length) {
        if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'Ожидается JSON');
        try { body = JSON.parse(raw.toString('utf8')); } catch { fail(400, 'Некорректный JSON'); }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) fail(400, 'Некорректный JSON');
      }
    }
    const params = Object.fromEntries(Object.entries(found.m.groups || {}).map(([k, v]) => [k, Number(v)]));
    if (abuseProtection) await abuse.guard({ req, body, user: currentUser(req), ip: clientIp(req) });
    const data = await found.r.handler({ req, res, url, query: url.searchParams, params, body, user: currentUser(req), catalogCities: CITIES });
    sendJson(res, found.r.options.status || 200, data);
  }

  function sendFile(req, res, file, cacheControl) {
    const stream = fs.createReadStream(file);
    stream.on('open', () => {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': cacheControl,
      });
      if (req.method === 'HEAD') { stream.destroy(); res.end(); } else stream.pipe(res);
    });
    stream.on('error', () => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Не найдено');
    });
  }

  function handleStatic(req, res, url) {
    if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'Метод не поддерживается');
    if (url.pathname.startsWith('/uploads/')) {
      const name = url.pathname.slice(9);
      if (!UPLOAD_NAME.test(name)) fail(404, 'Не найдено');
      const upload = q('SELECT * FROM uploads WHERE filename = ?').get(name);
      if (!upload) fail(404, 'Файл не найден');
      if (upload.private) {
        const user = currentUser(req);
        if (!user || (upload.user_id !== user.id && !q(`SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE (c.buyer_id = ? OR c.seller_id = ?) AND EXISTS (SELECT 1 FROM json_each(m.attachments) WHERE value = ?)`).get(user.id, user.id, '/uploads/' + name))) fail(404, 'Файл не найден');
      }
      return sendFile(req, res, path.join(uploadsDir, name), upload.private ? 'private, no-store' : 'public, max-age=31536000, immutable');
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || rel.includes('\0')) fail(404, 'Не найдено');
    return sendFile(req, res, file, 'no-cache');
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else handleStatic(req, res, url);
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      if (err.code === 'CAPTCHA_REQUIRED') return sendJson(res, 428, { error: err.message, code: err.code, siteKey: err.siteKey });
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      if (err instanceof URIError || err.code === 'ERR_INVALID_URL') return sendJson(res, 400, { error: 'Некорректный адрес' });
      const requestId = operations.recordError(req, err);
      sendJson(res, 500, { error: 'Ошибка сервера', requestId });
    }
  });

  return {
    server,
    db,
    maintenance: operations.run,
    close: () => new Promise((resolve) => {
      server.close(async () => { await operations.wait().catch(() => {}); db.close(); resolve(); });
      server.closeAllConnections();
    }),
  };
}
