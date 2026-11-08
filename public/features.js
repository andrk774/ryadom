import { createOperationsUI } from './operations.js';
export function createFeaturesUI(ctx) {
  const { api, esc, options, bindForm, toast, view, requireLogin, formatDate, formatPrice, gridHtml, buildHash, refreshNav, render } = ctx;
  const operations = createOperationsUI({ ...ctx, state: ctx.state });
  const fields = category => ctx.state.meta.fields[category] || [];
  const avatarHtml = user => user.avatar ? `<img class="avatar" src="${esc(user.avatar)}" alt="">` : `<span class="avatar">${esc(user.name?.charAt(0) || '?')}</span>`;
  function fieldsHTML(category, values = {}, filter = false) {
    return fields(category).map(f => {
      if (filter && f.type === 'number') return `<div class="field">${esc(f.name)}<div class="range">${['min', 'max'].map((side, i) => `<input type="number" step="${f.step || 1}" name="attr_${f.id}_${side}" placeholder="${i ? 'до' : 'от'}" aria-label="${esc(f.name)} ${i ? 'до' : 'от'}" value="${esc(values[`attr_${f.id}_${side}`])}">`).join('')}</div></div>`;
      const key = `attr_${f.id}`, value = filter ? values[key] : values[f.id];
      return `<label class="field">${esc(f.name)}${f.options
        ? `<select name="${key}"><option value="">${filter ? 'Любое' : 'Не указано'}</option>${options(f.options, value)}</select>`
        : `<input name="${key}" type="${f.type}" ${f.type === 'number' ? `min="${f.min}" max="${f.max}" step="${f.step || 1}"` : `maxlength="${f.maxLength}"`} value="${esc(value)}">`}</label>`;
    }).join('');
  }
  const detailsHTML = listing => fields(listing.category).filter(f => listing.attributes?.[f.id] !== undefined).map(f => `<dt>${esc(f.name)}</dt><dd>${esc(listing.attributes[f.id])}</dd>`).join('');
  async function report(target) {
    if (!ctx.state.user) return requireLogin();
    const reason = prompt('Опишите причину жалобы (от 5 до 1000 символов):');
    if (!reason) return;
    try { await api('/api/reports', { method: 'POST', body: { ...target, reason } }); toast('Жалоба передана модератору'); }
    catch (err) { toast(err.message); }
  }
  async function saveSearch(filters) {
    if (!ctx.state.user) return requireLogin();
    const name = prompt('Название сохранённого поиска:', filters.q || 'Мой поиск');
    if (!name) return;
    try { await api('/api/searches', { method: 'POST', body: { name, filters } }); toast('Поиск сохранён. Новые объявления появятся в уведомлениях.'); }
    catch (err) { toast(err.message); }
  }
  async function searchesPage(_, __, isCurrent) {
    if (!ctx.state.user) return requireLogin();
    const { items } = await api('/api/searches');
    if (!isCurrent()) return;
    view.innerHTML = `<h1>Сохранённые поиски</h1><p class="muted">О новых подходящих объявлениях сообщим в уведомлениях на сайте.</p>${items.map(s => `<div class="row-item"><a class="row-main" href="${esc(buildHash(s.filters))}">${esc(s.name)}</a><button class="btn btn-small" data-delete-search="${s.id}">Удалить</button></div>`).join('') || '<p>Сохраните первый поиск на странице объявлений.</p>'}`;
    view.querySelectorAll('[data-delete-search]').forEach(button => button.addEventListener('click', async () => {
      try { await api(`/api/searches/${button.dataset.deleteSearch}`, { method: 'DELETE' }); render(); } catch (e) { toast(e.message); }
    }));
  }
  async function notificationsPage(_, query, isCurrent) {
    if (!ctx.state.user) return requireLogin();
    const data = await api('/api/notifications?' + query);
    if (!isCurrent()) return;
    view.innerHTML = `<h1>Уведомления</h1>${data.items.map(n => `<a class="row-item" href="${n.kind === 'message' ? '#/messages/' + n.conversation_id : '#/listing/' + n.listing_id}"><span class="row-main">${n.read_at ? '' : '● '}${esc(n.text)}</span><span class="small muted">${esc(formatDate(n.created_at))}</span></a>`).join('') || '<p>Новых уведомлений пока нет.</p>'}${data.nextBefore ? `<a class="btn" href="#/notifications?before=${data.nextBefore}">Ранее</a>` : ''}`;
    await api('/api/notifications/read', { method: 'POST', body: { ids: data.items.map(n => n.id) } });
    refreshNav();
  }
  function forgotPage() {
    view.innerHTML = `<div class="auth-wrap panel"><h1>Восстановление пароля</h1><form id="forgot"><label class="field">Email<input type="email" name="email" required autocomplete="email"></label><button class="btn btn-primary" type="submit">Получить ссылку</button></form><p><a href="#/login">Вернуться ко входу</a></p><p id="result" role="status"></p></div>`;
    bindForm(view.querySelector('form'), async body => { const data = await api('/api/auth/forgot', { method: 'POST', body }); view.querySelector('#result').textContent = data.message; });
  }
  function resetPage(_, query) {
    const token = query.get('token');
    view.innerHTML = `<div class="auth-wrap panel"><h1>Новый пароль</h1><form><label class="field">Пароль (8–200 символов)<input type="password" name="password" minlength="8" maxlength="200" required autocomplete="new-password"></label><button type="submit" class="btn btn-primary">Сохранить пароль</button></form></div>`;
    bindForm(view.querySelector('form'), async body => {
      await api('/api/auth/reset', { method: 'POST', body: { ...body, token } });
      ctx.state.user = null; await refreshNav(); toast('Пароль изменён. Войдите заново.'); location.hash = '#/login';
    });
  }
  function verifyPage(_, query) {
    view.innerHTML = `<div class="auth-wrap panel"><h1>Подтверждение почты</h1><form><p>Подтвердите адрес кнопкой ниже.</p><button class="btn btn-primary" type="submit">Подтвердить email</button></form></div>`;
    bindForm(view.querySelector('form'), async () => {
      await api('/api/auth/verify', { method: 'POST', body: { token: query.get('token') } });
      await refreshNav(); toast('Адрес подтверждён'); location.hash = ctx.state.user ? '#/settings' : '#/login';
    });
  }
  async function settingsPage(_, __, isCurrent) {
    if (!ctx.state.user) return requireLogin();
    const { user } = await api('/api/me');
    if (!isCurrent()) return;
    if (!user) return requireLogin();
    let avatar = user.avatar || '', uploading = false;
    view.innerHTML = `<div class="form-wrap"><h1>Настройки профиля</h1>
      <div class="panel"><form id="profile"><div id="avatar-preview">${avatarHtml(user)}</div>
        <label class="field">Аватар<input id="avatar-file" type="file" accept="image/jpeg,image/png,image/webp"></label><button class="btn btn-small" type="button" id="avatar-remove">Убрать аватар</button>
        <label class="field">Имя<input name="name" value="${esc(user.name)}" minlength="2" maxlength="40" required></label>
        <label class="field">Город<select name="city">${options(ctx.state.meta.cities, user.city)}</select></label>
        <label class="field">О себе<textarea name="about" maxlength="1000">${esc(user.about)}</textarea></label>
        <button class="btn btn-primary" type="submit">Сохранить профиль</button></form></div>
      <div class="panel"><h2>Email</h2><p>${esc(user.email)} — ${user.emailVerified ? 'подтверждён' : 'не подтверждён'}</p>
        ${user.emailVerified ? '' : '<form id="verify-mail"><button class="btn" type="submit">Отправить подтверждение</button></form>'}
        <form id="email-form"><label class="field">Новый email<input type="email" name="email" required></label><label class="field">Текущий пароль<input type="password" name="currentPassword" required autocomplete="current-password"></label><button class="btn" type="submit">Подтвердить новый адрес</button></form></div>
      <div class="panel"><h2>Уведомления</h2><form id="preferences"><label class="field">Письма о сообщениях и сроке объявлений<select name="emailNotifications"><option value="false"${user.emailNotifications ? '' : ' selected'}>Выключены</option><option value="true"${user.emailNotifications ? ' selected' : ''}>Включены</option></select></label><p class="hint">Для включения подтвердите email. Письмо не отправляется, если сообщение уже прочитано.</p><button class="btn" type="submit">Сохранить уведомления</button></form><p><a href="#/blocks">Заблокированные собеседники</a></p></div><div class="panel"><h2>Смена пароля</h2><form id="password-form"><label class="field">Текущий пароль<input type="password" name="currentPassword" required autocomplete="current-password"></label><label class="field">Новый пароль<input type="password" name="password" minlength="8" maxlength="200" required autocomplete="new-password"></label><button class="btn" type="submit">Изменить пароль</button></form></div></div>`;
    view.querySelector('#avatar-file').addEventListener('change', async event => {
      const file = event.target.files[0]; if (!file) return;
      uploading = true; const button = view.querySelector('#profile button[type=submit]'); button.disabled = true;
      try { const result = await api('/api/uploads', { method: 'POST', file }); avatar = result.url; if (isCurrent()) view.querySelector('#avatar-preview').innerHTML = avatarHtml({ ...user, avatar }); }
      catch (e) { toast(e.message); } finally { uploading = false; button.disabled = false; }
    });
    view.querySelector('#avatar-remove').addEventListener('click', () => { avatar = ''; view.querySelector('#avatar-preview').innerHTML = avatarHtml({ ...user, avatar }); });
    bindForm(view.querySelector('#profile'), async body => { if (uploading) throw new Error('Дождитесь загрузки фото'); const data = await api('/api/me/profile', { method: 'PATCH', body: { ...body, avatar } }); ctx.state.user = data.user; refreshNav(); toast('Профиль сохранён'); });
    if (!user.emailVerified) bindForm(view.querySelector('#verify-mail'), async () => { await api('/api/auth/verification', { method: 'POST' }); toast('Письмо отправлено'); });
    bindForm(view.querySelector('#email-form'), async body => { await api('/api/me/email', { method: 'POST', body }); toast('Подтвердите новый адрес по ссылке из письма'); });
    bindForm(view.querySelector('#preferences'), async body => { await api('/api/me/preferences', { method: 'PATCH', body: { emailNotifications: body.emailNotifications === 'true' } }); refreshNav(); toast('Настройка сохранена'); });
    bindForm(view.querySelector('#password-form'), async body => { await api('/api/me/password', { method: 'POST', body }); view.querySelector('#password-form').reset(); toast('Пароль изменён, другие сеансы завершены'); });
  }

  async function draftsPage(_, __, isCurrent) {
    if (!ctx.state.user) return requireLogin();
    const { items } = await api('/api/drafts');
    if (!isCurrent()) return;
    view.innerHTML = `<h1>Черновики</h1><p><a class="btn" href="#/new">Новое объявление</a></p>${items.map(d => `<div class="row-item"><a class="row-main" href="#/draft/${d.id}">${esc(d.payload.title || 'Без названия')}<div class="muted small">${esc(formatDate(d.updated_at))}</div></a><button class="btn btn-small" data-draft-delete="${d.id}">Удалить</button></div>`).join('') || '<p>Здесь появятся автоматически сохранённые объявления.</p>'}`;
    view.querySelectorAll('[data-draft-delete]').forEach(b => b.addEventListener('click', async () => { try { await api(`/api/drafts/${b.dataset.draftDelete}`, { method: 'DELETE' }); render(); } catch (e) { toast(e.message); } }));
  }

  async function editorPage([id], query, isCurrent, fromDraft = false) {
    if (!ctx.state.user) return requireLogin();
    let draftId = fromDraft ? Number(id) : null;
    const draft = fromDraft ? await api(`/api/drafts/${id}`) : null;
    const listingId = draft ? draft.listing_id : id;
    const existing = listingId ? (await api(`/api/listings/${listingId}`)).listing : null;
    if (!isCurrent()) return;
    if (existing && existing.userId !== ctx.state.user.id) throw new Error('Это не ваше объявление');
    const l = draft?.payload || existing || { title: '', description: '', price: '', category: '', city: ctx.state.user.city, condition: 'used', photos: [], attributes: {} };
    let photos = [...(l.photos || [])], busy = false, timer, dirty = false, publishing = false, pendingSaves = 0, saveQueue = Promise.resolve();
    view.innerHTML = `<div class="form-wrap"><div class="panel"><h1>${existing ? 'Редактирование' : 'Новое объявление'}</h1>
      <p class="small muted" id="draft-state" role="status">${draft ? 'Черновик восстановлен' : 'Изменения сохраняются в черновик автоматически'}</p>
      <form id="editor"><label class="field">Название<input name="title" required minlength="3" maxlength="100" value="${esc(l.title)}"></label>
        <div class="two"><label class="field">Категория<select name="category" required><option value="">Выберите…</option>${options(ctx.state.meta.categories, l.category)}</select></label>
        <label class="field">Цена, ₽<input name="price" type="number" min="0" max="100000000000" step="1" required value="${esc(l.price)}"><span class="hint">0 — отдам даром</span></label>
        <label class="field">Город<select name="city">${options(ctx.state.meta.cities, l.city)}</select></label>
        <label class="field">Состояние<select name="condition">${options(ctx.state.meta.conditions, l.condition)}</select></label></div>
        ${operations.locationHTML(l)}<div class="two" id="category-fields">${fieldsHTML(l.category, l.attributes)}</div>
        <label class="field">Описание<textarea name="description" required minlength="10" maxlength="5000" rows="7">${esc(l.description)}</textarea></label>
        <div class="field">Фотографии <span class="hint">до 10, JPEG/PNG/WebP до 10 МБ; первая — главная</span><div class="photo-grid" id="photos"></div></div>
        <div class="row-actions"><button class="btn" type="button" id="preview-button">Предпросмотр</button><button class="btn" type="button" id="save-draft">Сохранить черновик</button><button class="btn btn-primary" type="submit">${existing ? 'Сохранить объявление' : 'Опубликовать'}</button></div>
        ${ctx.state.meta.moderationRequired ? '<p class="hint">После публикации и изменения объявление проверяет модератор.</p>' : ''}
      </form><section id="preview" class="panel preview" hidden aria-label="Предпросмотр объявления"></section></div></div>`;
    const form = view.querySelector('#editor'), grid = view.querySelector('#photos'), status = view.querySelector('#draft-state');
    function values() {
      const data = Object.fromEntries(new FormData(form)), attributes = {};
      for (const f of fields(data.category)) if (data[`attr_${f.id}`] !== '') attributes[f.id] = data[`attr_${f.id}`];
      return { title: data.title, price: data.price, category: data.category, city: data.city, condition: data.condition, description: data.description, attributes, photos: [...photos], district: data.district, latitude: data.latitude, longitude: data.longitude };
    }
    function save() {
      clearTimeout(timer);
      if (publishing || busy || !dirty) return saveQueue;
      const payload = values(); dirty = false;
      pendingSaves++;
      saveQueue = saveQueue.catch(() => {}).then(async () => {
        try {
          const data = await api(draftId ? `/api/drafts/${draftId}` : '/api/drafts', { method: draftId ? 'PUT' : 'POST', body: { payload, listingId: existing?.id } });
          draftId = data.id;
          if (isCurrent()) { status.textContent = 'Черновик сохранён'; history.replaceState(null, '', `#/draft/${draftId}`); }
        } catch (e) { dirty = true; if (isCurrent()) status.textContent = `Не сохранено: ${e.message}`; throw e; }
        finally { pendingSaves--; }
      });
      return saveQueue;
    }
    function changed() { dirty = true; status.textContent = 'Есть несохранённые изменения'; clearTimeout(timer); timer = setTimeout(() => save().catch(() => {}), 800); }
    ctx.setStopPolling(() => { clearTimeout(timer); if (!publishing) save().catch(() => {}); });
    const unload = e => { if (dirty || busy || pendingSaves) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', unload, { signal: ctx.getSignal() });
    operations.bindLocation(form, changed);
    form.addEventListener('input', changed);
    form.addEventListener('change', changed);
    form.elements.category.addEventListener('change', () => { view.querySelector('#category-fields').innerHTML = fieldsHTML(form.elements.category.value); changed(); });
    function setBusy(value) { busy = value; form.querySelector('button[type=submit]').disabled = value; drawPhotos(); }
    function drawPhotos() {
      grid.innerHTML = photos.map((url, i) => `<div class="photo-item"><img src="${esc(url)}" alt="Фото ${i + 1}"><div class="photo-tools"><button type="button" data-photo-action="main" data-index="${i}" ${busy ? 'disabled' : ''} aria-label="Сделать главным">${i ? '☆' : '★'}</button><button type="button" data-photo-action="left" data-index="${i}" ${busy || !i ? 'disabled' : ''} aria-label="Переместить влево">←</button><button type="button" data-photo-action="rotate" data-index="${i}" ${busy ? 'disabled' : ''} aria-label="Повернуть">↻</button><button type="button" data-photo-action="delete" data-index="${i}" ${busy ? 'disabled' : ''} aria-label="Удалить">×</button></div></div>`).join('') + (photos.length < 10 ? `<label class="photo-add">${busy ? 'Обработка…' : '+ Добавить фото'}<input type="file" accept="image/jpeg,image/png,image/webp" multiple ${busy ? 'disabled' : ''}></label>` : '');
      grid.querySelector('input')?.addEventListener('change', async event => {
        const files = [...event.target.files].slice(0, 10 - photos.length); setBusy(true);
        try { for (const file of files) {
          if (file.size > 10 * 1024 * 1024) { toast(`${file.name}: больше 10 МБ`); continue; }
          try { const { url } = await api('/api/uploads', { method: 'POST', file }); photos.push(url); dirty = true; } catch (e) { toast(e.message); }
        } } finally { setBusy(false); changed(); if (!isCurrent()) save().catch(() => {}); }
      });
    }
    grid.addEventListener('click', async event => {
      const button = event.target.closest('[data-photo-action]'); if (!button || busy) return;
      const i = Number(button.dataset.index), action = button.dataset.photoAction;
      if (action === 'delete') photos.splice(i, 1);
      if (action === 'main') photos.unshift(...photos.splice(i, 1));
      if (action === 'left' && i) [photos[i - 1], photos[i]] = [photos[i], photos[i - 1]];
      if (action === 'rotate') {
        setBusy(true);
        try {
          const img = new Image(); img.src = photos[i]; await img.decode();
          const canvas = document.createElement('canvas'); canvas.width = img.naturalHeight; canvas.height = img.naturalWidth;
          const c = canvas.getContext('2d'); c.translate(canvas.width, 0); c.rotate(Math.PI / 2); c.drawImage(img, 0, 0);
          const file = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.9));
          if (!file) throw new Error('Не удалось повернуть фото');
          photos[i] = (await api('/api/uploads', { method: 'POST', file })).url;
        } catch (e) { toast(e.message); } finally { setBusy(false); }
      }
      drawPhotos(); changed();
    });
    drawPhotos();
    view.querySelector('#save-draft').addEventListener('click', () => { dirty = true; save().catch(e => toast(e.message)); });
    view.querySelector('#preview-button').addEventListener('click', () => {
      const v = values(), preview = view.querySelector('#preview'); preview.hidden = false;
      preview.innerHTML = `<h2>${esc(v.title || 'Без названия')}</h2><p class="price-big">${formatPrice(Number(v.price) || 0)}</p>${v.photos.map(url => `<img class="preview-photo" src="${esc(url)}" alt="Фото объявления">`).join('')}<dl class="facts">${detailsHTML(v)}</dl><p class="desc">${esc(v.description)}</p><p class="muted">${esc(v.city)} · Предпросмотр — пока не опубликовано</p>`;
      preview.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    bindForm(form, async () => {
      if (busy || publishing) throw new Error('Дождитесь загрузки фотографий');
      const body = values(); body.price = Number(body.price);
      dirty = true; const pending = save(); publishing = true; clearTimeout(timer);
      form.querySelectorAll('input,select,textarea,button').forEach(el => { el.disabled = true; });
      try {
        await pending;
        const { listing } = await api(existing ? `/api/listings/${existing.id}` : '/api/listings', { method: existing ? 'PATCH' : 'POST', body });
        if (draftId) await api(`/api/drafts/${draftId}`, { method: 'DELETE' }).catch(() => toast('Объявление сохранено, но черновик не удалён'));
        toast(listing.moderation === 'pending' ? 'Объявление отправлено на проверку' : 'Объявление сохранено'); location.hash = `#/listing/${listing.id}`;
      } catch (e) { publishing = false; form.querySelectorAll('input,select,textarea,button').forEach(el => { el.disabled = false; }); drawPhotos(); throw e; }
    });
  }

  async function chatPage([id], _, isCurrent) {
    if (!ctx.state.user) return requireLogin();
    let chat = await api(`/api/conversations/${id}`);
    if (!isCurrent()) return;
    let messages = new Map(chat.messages.map(m => [m.id, m])), nextBefore = chat.nextBefore, attachments = [], uploading = false, polling = false;
    view.innerHTML = `<div class="form-wrap"><div class="chat-head"><button class="btn btn-small" id="block-chat" type="button">${chat.blockedByMe ? 'Разблокировать' : 'Заблокировать'}</button><div><a href="#/user/${chat.other.id}">${esc(chat.other.name)}</a><div>${esc(chat.listing.title)}</div></div></div>
      <button class="btn btn-small" id="older" ${nextBefore ? '' : 'hidden'}>Загрузить предыдущие сообщения</button><div class="chat-log" id="log" aria-live="polite"></div>
      ${chat.blocked ? '<p class="notice">Отправка сообщений недоступна: участник заблокирован.</p>' : ''}<form id="send" class="chat-form"><textarea name="text" maxlength="2000" placeholder="Сообщение" aria-label="Сообщение"></textarea><button class="btn btn-primary" type="submit">Отправить</button></form>
      <label class="field">Фото в переписку (до 3)<input id="chat-files" type="file" accept="image/jpeg,image/png,image/webp" multiple></label><div id="attachments" class="row-actions"></div></div>`;
    const log = view.querySelector('#log'), older = view.querySelector('#older'), form = view.querySelector('#send'), files = view.querySelector('#chat-files');
    view.querySelector('#block-chat').addEventListener('click', () => operations.block(chat.other.id, !chat.blockedByMe));
    function applyBlock() { form.querySelectorAll('textarea,button').forEach(el => { el.disabled = chat.blocked || uploading; }); files.disabled = chat.blocked || uploading; }
    applyBlock();
    function draw(keep = false) {
      const oldHeight = log.scrollHeight, oldTop = log.scrollTop, nearBottom = oldHeight - oldTop - log.clientHeight < 80;
      log.innerHTML = [...messages.values()].sort((a,b) => a.id - b.id).map(m => `<div class="msg${m.mine ? ' mine' : ''}" data-message="${m.id}">${esc(m.text)}${(m.attachments || []).map(url => `<a href="${esc(url)}" target="_blank" rel="noopener"><img class="chat-photo" src="${esc(url)}" alt="Фото в переписке"></a>`).join('')}<time>${esc(formatDate(m.createdAt))}${m.mine ? (m.readAt ? ' · Прочитано' : ' · Отправлено') : ''}</time></div>`).join('');
      log.scrollTop = keep ? oldTop + log.scrollHeight - oldHeight : nearBottom ? log.scrollHeight : oldTop;
      older.hidden = !nextBefore;
      markVisible();
    }
    async function markVisible() {
      if (document.hidden || !isCurrent()) return;
      const box = log.getBoundingClientRect();
      const ids = [...log.querySelectorAll('[data-message]')].filter(el => { const r = el.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom; }).map(el => Number(el.dataset.message)).filter(key => !messages.get(key).mine && !messages.get(key).readAt).slice(0, 200);
      if (!ids.length) return;
      try { await api(`/api/conversations/${id}/read`, { method: 'POST', body: { ids } }); ids.forEach(key => { const m = messages.get(key); if (m) m.readAt = Date.now(); }); refreshNav(); } catch { /* next scroll/poll retries */ }
    }
    async function refresh() {
      if (polling || document.hidden || !isCurrent()) return;
      polling = true;
      try {
        const previousNewest = Math.max(0, ...messages.keys());
        let next = await api(`/api/conversations/${id}`);
        if (!isCurrent()) return;
        chat.blocked = next.blocked; chat.blockedByMe = next.blockedByMe; applyBlock();
        const incoming = [...next.messages];
        // Fill gaps after a sleeping tab rather than silently dropping messages between polls.
        while (next.nextBefore && next.messages[0]?.id > previousNewest) {
          next = await api(`/api/conversations/${id}?before=${next.nextBefore}`);
          if (!isCurrent()) return;
          incoming.push(...next.messages);
        }
        incoming.forEach(m => messages.set(m.id, m)); draw();
      }
      finally { polling = false; }
    }
    older.addEventListener('click', async () => {
      older.disabled = true;
      try { const next = await api(`/api/conversations/${id}?before=${nextBefore}`); if (!isCurrent()) return; next.messages.forEach(m => messages.set(m.id, m)); nextBefore = next.nextBefore; draw(true); }
      catch (e) { toast(e.message); } finally { older.disabled = false; }
    });
    log.addEventListener('scroll', markVisible);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { markVisible(); refresh().catch(() => {}); } }, { signal: ctx.getSignal() });
    function drawAttachments() {
      const holder = view.querySelector('#attachments'); if (!holder) return;
      holder.innerHTML = attachments.map((url,i) => `<button class="btn btn-small" type="button" data-remove-attachment="${i}">Фото ${i+1} ×</button>`).join('');
      holder.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { attachments.splice(Number(b.dataset.removeAttachment),1); drawAttachments(); }));
    }
    files.addEventListener('change', async event => {
      uploading = true; form.querySelector('button').disabled = true; files.disabled = true;
      try { for (const file of [...event.target.files].slice(0,3-attachments.length)) { const {url} = await api('/api/uploads?scope=chat', {method:'POST',file}); attachments.push(url); } }
      catch (e) { toast(e.message); } finally { uploading = false; form.querySelector('button').disabled = false; files.disabled = false; files.value = ''; if (isCurrent()) drawAttachments(); }
    });
    bindForm(form, async ({ text }) => {
      if (chat.blocked) throw new Error('Собеседник заблокирован');
      if (uploading) throw new Error('Дождитесь загрузки фото');
      await api(`/api/conversations/${id}/messages`, { method: 'POST', body: { text, attachments } });
      form.reset(); attachments = []; if (isCurrent()) drawAttachments(); await refresh();
    });
    form.elements.text.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!form.querySelector('button').disabled) form.requestSubmit(); } });
    draw(); log.scrollTop = log.scrollHeight; markVisible();
    const interval = setInterval(() => refresh().catch(() => {}), 4000); ctx.setStopPolling(() => clearInterval(interval));
  }

  async function adminPage(_, query, isCurrent) {
    if (!ctx.state.user) return requireLogin();
    const data = await api('/api/admin?' + query);
    if (!isCurrent()) return;
    view.innerHTML = `<h1>Модерация</h1><p><a class="btn" href="#/operations">Состояние сервиса</a></p><h2>Объявления на проверке</h2>${data.listings.map(l => `<div class="panel moderation-item"><a href="#/listing/${l.id}"><strong>${esc(l.title)}</strong></a><p class="desc">${esc(l.description)}</p><p>${formatPrice(l.price)} · ${esc(l.city)}</p><div class="thumbs">${l.photos.map(url => `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="Фото объявления"></a>`).join('')}</div><div class="row-actions"><button class="btn btn-primary" data-moderate="approved" data-id="${l.id}">Одобрить</button><button class="btn btn-danger" data-moderate="rejected" data-id="${l.id}">Отклонить</button></div></div>`).join('') || '<p>Очередь пуста.</p>'}
      <h2 class="section-gap">Жалобы</h2>${data.reports.map(r => `<div class="panel moderation-item"><a href="#/${r.listing_id ? 'listing/' + r.listing_id : 'user/' + r.user_id}">Открыть ${r.listing_id ? 'объявление' : 'профиль'}</a><p>${esc(r.reason)}</p><div class="row-actions">${r.listing_id ? `<button class="btn btn-danger" data-moderate="rejected" data-id="${r.listing_id}">Снять объявление</button>` : `<button class="btn btn-danger" data-block="${r.user_id}" data-value="true">Заблокировать</button>`}<button class="btn" data-close-report="${r.id}">Закрыть жалобу</button></div></div>`).join('') || '<p>Открытых жалоб нет.</p>'}
      <h2 class="section-gap">Пользователи</h2>${data.users.map(u => `<div class="row-item"><a class="row-main" href="#/user/${u.id}">${esc(u.name)}<span class="small muted"> · ${esc(u.email)}</span></a>${u.role === 'admin' ? '<span class="tag">Модератор</span>' : `<button class="btn btn-small" data-block="${u.id}" data-value="${!u.blocked}">${u.blocked ? 'Разблокировать' : 'Заблокировать'}</button>`}</div>`).join('')}
      <details><summary>Журнал действий</summary>${data.log.map(l => `<p class="small">${esc(formatDate(l.created_at))}: ${esc(l.action)} #${l.target_id} — ${esc(l.note)}</p>`).join('')}</details>
      <div class="pager">${data.page > 1 ? `<a class="btn" href="#/admin?page=${data.page-1}">Назад</a>` : ''}<span>Страница ${data.page}</span>${['listings','reports','users','log'].some(k => data[k].length === 50) ? `<a class="btn" href="#/admin?page=${data.page+1}">Далее</a>` : ''}</div>`;
    view.querySelectorAll('[data-moderate],[data-block],[data-close-report]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        if (button.dataset.moderate) {
          const note = button.dataset.moderate === 'rejected' ? prompt('Причина отклонения:') : '';
          if (note === null) return;
          await api(`/api/admin/listings/${button.dataset.id}`, { method: 'PATCH', body: { moderation: button.dataset.moderate, note } });
        } else if (button.dataset.block) await api(`/api/admin/users/${button.dataset.block}`, { method: 'PATCH', body: { blocked: button.dataset.value === 'true' } });
        else await api(`/api/admin/reports/${button.dataset.closeReport}`, { method: 'PATCH', body: {} });
        render();
      } catch (e) { toast(e.message); } finally { button.disabled = false; }
    }));
  }
  return { ...operations, fieldsHTML, detailsHTML, avatarHtml, report, saveSearch, searchesPage, notificationsPage, forgotPage, resetPage, verifyPage, settingsPage, draftsPage, editorPage, chatPage, adminPage,
    draftEditorPage: (params, query, current) => editorPage(params, query, current, true) };
}
