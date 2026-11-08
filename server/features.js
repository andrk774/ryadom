import crypto from 'node:crypto';
import { listingFilters } from './fields.js';

export function installFeatures({ route, q, db, fail, requireUser, publicUser, hashPassword, verifyPassword,
  startSession, limit, clientIp, sendMail, baseUrl, validatePhotos, serialize, getOwnListing, notifyListing, listingDays }) {
  const str = value => typeof value === 'string' ? value.trim() : '';
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const emailValue = value => {
    const email = str(value).toLowerCase();
    if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Некорректный email');
    return email;
  };
  const passwordValue = value => {
    if (typeof value !== 'string' || value.length < 8 || value.length > 200) fail(400, 'Пароль: от 8 до 200 символов');
    return value;
  };
  const admin = ctx => {
    const user = requireUser(ctx);
    if (user.role !== 'admin') fail(403, 'Доступ только для модератора');
    return user;
  };
  const audit = (user, action, id, note = '') => q('INSERT INTO moderation_log (admin_id,action,target_id,note,created_at) VALUES (?,?,?,?,?)').run(user.id, action, id, note, Date.now());
  async function issueToken(user, purpose, email = user.email) {
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = digest(token);
    q('DELETE FROM account_tokens WHERE expires_at < ?').run(Date.now());
    q('INSERT INTO account_tokens (hash,user_id,purpose,email,expires_at) VALUES (?,?,?,?,?)')
      .run(hash, user.id, purpose, email, Date.now() + (purpose === 'reset' ? 3600000 : 86400000));
    try {
      await sendMail({ to: email, subject: purpose === 'reset' ? 'Рядом — восстановление пароля' : 'Рядом — подтверждение почты',
        text: `Откройте ссылку: ${baseUrl}/#/${purpose === 'reset' ? 'reset' : 'verify'}?token=${token}\nСсылка одноразовая. Если вы не запрашивали это действие, проигнорируйте письмо.` });
    } catch (err) { q('DELETE FROM account_tokens WHERE hash = ?').run(hash); throw err; }
    q('DELETE FROM account_tokens WHERE user_id = ? AND purpose = ? AND hash != ?').run(user.id, purpose, hash);
  }
  function tokenFor(body, purposes) {
    const token = q('SELECT * FROM account_tokens WHERE hash = ? AND expires_at > ?').get(digest(str(body.token)), Date.now());
    if (!token || !purposes.includes(token.purpose)) fail(400, 'Ссылка недействительна или истекла. Запросите новую.');
    const user = q('SELECT * FROM users WHERE id = ?').get(token.user_id);
    if (!user || user.blocked) fail(400, 'Ссылка недействительна');
    return { token, user };
  }
  route('POST', '/api/auth/forgot', async ({ req, body }) => {
    limit(`recover:${clientIp(req)}`, 10, 3600000);
    const user = q('SELECT * FROM users WHERE email = ? AND blocked = 0').get(str(body.email).toLowerCase());
    if (user) {
      try { await issueToken(user, 'reset'); } catch { console.error('Не удалось отправить письмо восстановления'); }
    }
    return { ok: true, message: 'Если аккаунт существует, письмо с инструкцией отправлено.' };
  });
  route('POST', '/api/auth/reset', async ctx => {
    limit(`reset:${clientIp(ctx.req)}`, 20, 3600000);
    const password = passwordValue(ctx.body.password);
    const { token } = tokenFor(ctx.body, ['reset']);
    const hash = await hashPassword(password);
    // Recheck after asynchronous hashing: a token must only be consumed once.
    tokenFor(ctx.body, ['reset']);
    db.exec('BEGIN IMMEDIATE');
    try {
      q('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, token.user_id);
      q('DELETE FROM sessions WHERE user_id = ?').run(token.user_id);
      q('DELETE FROM account_tokens WHERE user_id = ?').run(token.user_id);
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    return { ok: true };
  });
  route('POST', '/api/auth/verification', async ctx => {
    const user = requireUser(ctx);
    limit(`verify:${user.id}`, 5, 3600000);
    if (!user.email_verified) {
      try { await issueToken(user, 'verify'); } catch { fail(503, 'Почта временно недоступна. Повторите позже.'); }
    }
    return { ok: true };
  });
  route('POST', '/api/auth/verify', ctx => {
    limit(`token:${clientIp(ctx.req)}`, 30, 3600000);
    const { token, user } = tokenFor(ctx.body, ['verify', 'email']);
    if (token.purpose === 'verify' && token.email !== user.email) fail(400, 'Email уже изменился');
    if (q('SELECT 1 FROM users WHERE email = ? AND id != ?').get(token.email, user.id)) fail(409, 'Email уже занят');
    q('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?').run(token.email, user.id);
    q('DELETE FROM account_tokens WHERE user_id = ?').run(user.id);
    if (token.purpose === 'email') q('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    return { ok: true };
  });
  route('PATCH', '/api/me/profile', ctx => {
    const user = requireUser(ctx);
    const name = str(ctx.body.name), about = str(ctx.body.about), avatar = str(ctx.body.avatar);
    if (name.length < 2 || name.length > 40 || about.length > 1000) fail(400, 'Проверьте имя (2–40) и описание (до 1000 символов)');
    if (!ctx.catalogCities.includes(ctx.body.city)) fail(400, 'Выберите город');
    if (avatar) validatePhotos([avatar], user, false);
    q('UPDATE users SET name = ?, city = ?, about = ?, avatar = ? WHERE id = ?').run(name, ctx.body.city, about, avatar, user.id);
    return { user: publicUser(q('SELECT * FROM users WHERE id = ?').get(user.id)) };
  });
  async function checkPassword(ctx) {
    const user = requireUser(ctx);
    limit(`security:${user.id}`, 10, 3600000);
    const row = q('SELECT * FROM users WHERE id = ?').get(user.id);
    if (typeof ctx.body.currentPassword !== 'string' || ctx.body.currentPassword.length > 200 || !await verifyPassword(ctx.body.currentPassword, row.password_hash)) fail(400, 'Текущий пароль неверен');
    // A simultaneous reset/block must invalidate an in-flight security operation.
    const latest = q('SELECT * FROM users WHERE id = ?').get(user.id);
    if (latest.blocked || latest.password_hash !== row.password_hash) fail(409, 'Аккаунт изменился. Войдите снова.');
    return row;
  }
  route('POST', '/api/me/password', async ctx => {
    const row = await checkPassword(ctx);
    const hash = await hashPassword(passwordValue(ctx.body.password));
    const result = q('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ? AND blocked = 0').run(hash, row.id, row.password_hash);
    if (!result.changes) fail(409, 'Аккаунт изменился. Войдите снова.');
    q('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    q('DELETE FROM account_tokens WHERE user_id = ?').run(row.id);
    startSession(ctx.res, row.id);
    return { ok: true };
  });
  route('POST', '/api/me/email', async ctx => {
    const user = await checkPassword(ctx);
    const email = emailValue(ctx.body.email);
    if (q('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'Email уже занят');
    try { await issueToken(user, 'email', email); } catch { fail(503, 'Почта временно недоступна'); }
    return { ok: true };
  });

  route('POST', '/api/reports', ctx => {
    const user = requireUser(ctx);
    limit(`report:${user.id}`, 10, 3600000);
    const listingId = Number(ctx.body.listingId) || null, userId = Number(ctx.body.userId) || null;
    if (Boolean(listingId) === Boolean(userId)) fail(400, 'Выберите объявление или пользователя');
    if (listingId && !q("SELECT 1 FROM listings WHERE id = ? AND status != 'deleted'").get(listingId)) fail(404, 'Объявление не найдено');
    if (userId && !q('SELECT 1 FROM users WHERE id = ?').get(userId)) fail(404, 'Пользователь не найден');
    const reason = str(ctx.body.reason);
    if (reason.length < 5 || reason.length > 1000) fail(400, 'Причина: от 5 до 1000 символов');
    q('INSERT INTO reports (author_id,listing_id,user_id,reason,created_at) VALUES (?,?,?,?,?)').run(user.id, listingId, userId, reason, Date.now());
    return { ok: true };
  }, { status: 201 });
  route('GET', '/api/admin', ctx => {
    admin(ctx);
    const page = Math.max(1, Math.min(1000000, Number(ctx.query.get('page')) || 1));
    const offset = (Math.floor(page) - 1) * 50;
    return {
      listings: q("SELECT * FROM listings WHERE moderation = 'pending' AND status = 'active' ORDER BY updated_at, id LIMIT 50 OFFSET ?").all(offset).map(serialize),
      reports: q("SELECT * FROM reports WHERE status = 'open' ORDER BY id LIMIT 50 OFFSET ?").all(offset),
      users: q('SELECT id,name,email,role,blocked,email_verified FROM users ORDER BY id DESC LIMIT 50 OFFSET ?').all(offset),
      log: q('SELECT * FROM moderation_log ORDER BY id DESC LIMIT 50 OFFSET ?').all(offset), page,
    };
  });
  route('PATCH', '/api/admin/listings/:id', ctx => {
    const user = admin(ctx);
    if (!['approved', 'rejected'].includes(ctx.body.moderation)) fail(400, 'Неверное решение');
    const row = q("SELECT * FROM listings WHERE id = ? AND status != 'deleted'").get(ctx.params.id);
    if (!row) fail(404, 'Объявление не найдено');
    const note = str(ctx.body.note).slice(0, 1000);
    q('UPDATE listings SET moderation = ?, moderation_note = ?, expires_at = ? WHERE id = ?').run(ctx.body.moderation, note, row.moderation !== 'approved' && ctx.body.moderation === 'approved' ? Date.now() + listingDays * 86400000 : row.expires_at, row.id);
    audit(user, ctx.body.moderation, row.id, note);
    q('INSERT INTO notifications (user_id,listing_id,text,created_at) VALUES (?,?,?,?)').run(row.user_id, row.id, ctx.body.moderation === 'approved' ? 'Объявление одобрено' : `Объявление отклонено: ${note}`, Date.now());
    notifyListing(row.id);
    return { ok: true };
  });
  route('PATCH', '/api/admin/users/:id', ctx => {
    const user = admin(ctx);
    if (typeof ctx.body.blocked !== 'boolean') fail(400, 'Укажите блокировку');
    const target = q('SELECT * FROM users WHERE id = ?').get(ctx.params.id);
    if (!target) fail(404, 'Пользователь не найден');
    if (target.id === user.id || target.role === 'admin') fail(400, 'Нельзя заблокировать администратора');
    q('UPDATE users SET blocked = ? WHERE id = ?').run(Number(ctx.body.blocked), target.id);
    if (ctx.body.blocked) {
      q('DELETE FROM sessions WHERE user_id = ?').run(target.id);
      q('DELETE FROM account_tokens WHERE user_id = ?').run(target.id);
    }
    audit(user, ctx.body.blocked ? 'block' : 'unblock', target.id);
    return { ok: true };
  });
  route('PATCH', '/api/admin/reports/:id', ctx => {
    const user = admin(ctx);
    if (!q("UPDATE reports SET status = 'closed' WHERE id = ?").run(ctx.params.id).changes) fail(404, 'Жалоба не найдена');
    audit(user, 'close-report', ctx.params.id);
    return { ok: true };
  });

  route('GET', '/api/searches', ctx => ({ items: q('SELECT * FROM saved_searches WHERE user_id = ? ORDER BY id DESC').all(requireUser(ctx).id).map(r => ({ ...r, filters: JSON.parse(r.filters) })) }));
  route('POST', '/api/searches', ctx => {
    const user = requireUser(ctx), name = str(ctx.body.name);
    if (!name || name.length > 100) fail(400, 'Название поиска: до 100 символов');
    if (q('SELECT COUNT(*) AS n FROM saved_searches WHERE user_id = ?').get(user.id).n >= 30) fail(400, 'Можно сохранить до 30 поисков');
    const filters = ctx.body.filters;
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) fail(400, 'Некорректные фильтры');
    const clean = Object.fromEntries(Object.entries(filters).filter(([k,v]) => /^(q|category|city|condition|min|max|seller|district|lat|lon|radius|attr_[a-z_]+)$/.test(k) && typeof v === 'string' && v.length <= 200));
    const { lastInsertRowid } = q('INSERT INTO saved_searches (user_id,name,filters,created_at) VALUES (?,?,?,?)').run(user.id, name, JSON.stringify(clean), Date.now());
    return { id: Number(lastInsertRowid) };
  }, { status: 201 });
  route('DELETE', '/api/searches/:id', ctx => {
    q('DELETE FROM saved_searches WHERE id = ? AND user_id = ?').run(ctx.params.id, requireUser(ctx).id);
    return { ok: true };
  });
  route('GET', '/api/notifications', ctx => {
    const user = requireUser(ctx), before = Number(ctx.query.get('before')) || Number.MAX_SAFE_INTEGER;
    const items = q('SELECT * FROM notifications WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT 50').all(user.id, before);
    return { items, nextBefore: items.length === 50 ? items.at(-1).id : null, unread: q('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(user.id).n };
  });
  route('POST', '/api/notifications/read', ctx => {
    const user = requireUser(ctx);
    for (const id of Array.isArray(ctx.body.ids) ? ctx.body.ids.slice(0, 50) : []) if (Number.isSafeInteger(id)) q('UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ?').run(Date.now(), user.id, id);
    return { ok: true };
  });

  const ownDraft = ctx => {
    const draft = q('SELECT * FROM drafts WHERE id = ? AND user_id = ?').get(ctx.params.id, requireUser(ctx).id);
    if (!draft) fail(404, 'Черновик не найден');
    return draft;
  };
  const draftPayload = (body, user) => {
    const payload = body.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || JSON.stringify(payload).length > 20000) fail(400, 'Некорректный черновик');
    validatePhotos(payload.photos || [], user, false);
    return JSON.stringify(payload);
  };
  route('GET', '/api/drafts', ctx => ({ items: q('SELECT * FROM drafts WHERE user_id = ? ORDER BY updated_at DESC').all(requireUser(ctx).id).map(r => ({ ...r, payload: JSON.parse(r.payload) })) }));
  route('GET', '/api/drafts/:id', ctx => { const r = ownDraft(ctx); return { ...r, payload: JSON.parse(r.payload) }; });
  route('POST', '/api/drafts', ctx => {
    const user = requireUser(ctx);
    if (q('SELECT COUNT(*) AS n FROM drafts WHERE user_id = ?').get(user.id).n >= 100) fail(400, 'Можно сохранить до 100 черновиков');
    const listingId = Number(ctx.body.listingId) || null;
    if (listingId) getOwnListing(listingId, user);
    const result = q('INSERT INTO drafts (user_id,listing_id,payload,updated_at) VALUES (?,?,?,?)').run(user.id, listingId, draftPayload(ctx.body, user), Date.now());
    return { id: Number(result.lastInsertRowid) };
  }, { status: 201 });
  route('PUT', '/api/drafts/:id', ctx => {
    const draft = ownDraft(ctx);
    q('UPDATE drafts SET payload = ?, updated_at = ? WHERE id = ?').run(draftPayload(ctx.body, ctx.user), Date.now(), draft.id);
    return { id: draft.id };
  });
  route('DELETE', '/api/drafts/:id', ctx => { const d = ownDraft(ctx); q('DELETE FROM drafts WHERE id = ?').run(d.id); return { ok: true }; });
  return { issueToken };
}

export function notifyMatches(q, id) {
  const listing = q("SELECT l.* FROM listings l JOIN users u ON u.id = l.user_id WHERE l.id = ? AND l.status = 'active' AND l.moderation = 'approved' AND u.blocked = 0 AND l.expires_at > ?").get(id, Date.now());
  if (!listing) return;
  for (const search of q('SELECT s.* FROM saved_searches s JOIN users u ON u.id = s.user_id WHERE u.blocked = 0 AND s.user_id != ? AND s.created_at <= ?').all(listing.user_id, listing.created_at)) {
    const { where, args } = listingFilters(new URLSearchParams(JSON.parse(search.filters)));
    if (q(`SELECT 1 FROM listings l WHERE l.id = ?${where.length ? ' AND ' + where.join(' AND ') : ''}`).get(id, ...args)) {
      q('INSERT OR IGNORE INTO notifications (user_id,search_id,listing_id,text,created_at) VALUES (?,?,?,?,?)').run(search.user_id, search.id, id, `${search.name}: ${listing.title}`, Date.now());
    }
  }
}
