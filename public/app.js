import { solveCaptcha } from './captcha.js';
import { createFeaturesUI } from './features.js';
const view = document.getElementById('view');
const nav = document.getElementById('nav');
const toastEl = document.getElementById('toast');
const searchForm = document.getElementById('search');

const state = { user: null, unread: 0, notifications: 0, meta: null, returnTo: null };
let renderToken = 0;
let stopPolling = null;
let pageController = null;

// ---------- helpers ----------
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = new Intl.NumberFormat('ru-RU');
const formatPrice = (p) => (p === 0 ? 'Даром' : `${money.format(p)} ₽`);
const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

function formatDate(ts) {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (date.toDateString() === today.toDateString()) return `сегодня, ${timeFmt.format(date)}`;
  if (date.toDateString() === yesterday.toDateString()) return `вчера, ${timeFmt.format(date)}`;
  return date.getFullYear() === today.getFullYear()
    ? dayFmt.format(date)
    : date.toLocaleDateString('ru-RU');
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
}

const category = (id) => state.meta.categories.find((c) => c.id === id);
const conditionName = (id) => state.meta.conditions.find((c) => c.id === id)?.name;
const options = (items, selected) => items.map((item) => {
  const [value, label] = typeof item === 'string' ? [item, item] : [item.id, item.name];
  return `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
}).join('');

function stars(rating) {
  const full = Math.round(rating);
  return `<span class="stars" aria-label="Оценка ${rating} из 5">${'★'.repeat(full)}${'☆'.repeat(5 - full)}</span>`;
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { toastEl.hidden = true; }, 3000);
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(path, { method = 'GET', body, file, retryCaptcha = true } = {}) {
  const init = { method, headers: {} };
  if (file) {
    init.body = file;
    init.headers['Content-Type'] = file.type || 'application/octet-stream';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'Нет связи с сервером');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 428 && data.code === 'CAPTCHA_REQUIRED' && retryCaptcha) {
    const captchaToken = await solveCaptcha(data.siteKey);
    return api(path, { method, body: { ...body, captchaToken }, retryCaptcha: false });
  }
  if (!res.ok) throw new ApiError(res.status, data.error || 'Что-то пошло не так');
  return data;
}

function requireLogin() {
  state.returnTo = location.hash;
  location.hash = '#/login';
}

// Only an expired session triggers the redirect. A 401 for an anonymous visitor
// is a wrong password on the login form, which the form itself should display.
function isAuthError(err) {
  if (err.status !== 401 || !state.user) return false;
  state.user = null;
  renderNav();
  requireLogin();
  return true;
}

// ---------- shared pieces ----------
function photoOrPlaceholder(listing, className) {
  if (listing.photos.length) {
    return `<img class="${className}" src="${esc(listing.photos[0])}" alt="" loading="lazy">`;
  }
  const c = category(listing.category);
  return `<div class="${className} ph ph-${esc(listing.category)}" aria-hidden="true">${c?.icon ?? '📦'}</div>`;
}

function favButton(l) {
  if (state.user && l.userId === state.user.id) return '';
  const label = l.isFavorite ? 'Убрать из избранного' : 'В избранное';
  return `<button class="fav${l.isFavorite ? ' on' : ''}" type="button" data-fav="${l.id}" aria-pressed="${l.isFavorite}" aria-label="${label}" title="${label}">${l.isFavorite ? '♥' : '♡'}</button>`;
}

function cardHtml(l) {
  return `<article class="card">
    <a class="card-link" href="#/listing/${l.id}">
      ${photoOrPlaceholder(l, 'thumb')}
      <div class="card-body">
        <div class="card-price">${formatPrice(l.price)}</div>
        <div class="card-title">${esc(l.title)}</div>
        <div class="card-meta">${esc(l.city)} · ${esc(formatDate(l.createdAt))}</div>
        ${l.status === 'sold' ? '<div class="tag tag-sold">Продано</div>' : ''}
      </div>
    </a>
    ${favButton(l)}
  </article>`;
}

const gridHtml = (items) => `<div class="grid">${items.map(cardHtml).join('')}</div>`;
const emptyHtml = (icon, text, action = '') => `<div class="empty"><div class="empty-icon" aria-hidden="true">${icon}</div><p>${esc(text)}</p>${action}</div>`;
const initial = (name) => esc(String(name).trim().charAt(0).toUpperCase());

function formError(form, message) {
  let box = form.querySelector('.error');
  if (!box) {
    box = document.createElement('div');
    box.className = 'error';
    box.setAttribute('role', 'alert');
    form.prepend(box);
  }
  box.textContent = message;
  box.scrollIntoView({ block: 'nearest' });
}

function bindForm(form, submit) {
  let submitting = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    const button = form.querySelector('button[type=submit]');
    if (button) button.disabled = true;
    form.querySelector('.error')?.remove();
    try {
      await submit(Object.fromEntries(new FormData(form)));
    } catch (err) {
      if (!isAuthError(err)) formError(form, err.message);
    } finally {
      submitting = false;
      if (button) button.disabled = false;
    }
  });
}

// ---------- home / search ----------
function buildHash(params) {
  const clean = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) clean.set(k, v);
  const text = clean.toString();
  return text ? `#/?${text}` : '#/';
}

async function homePage(_, query, isCurrent) {
  const params = Object.fromEntries(query);
  searchForm.q.value = params.q || '';
  const data = await api(`/api/listings?${query}`);
  if (!isCurrent()) return;
  const active = category(params.category);
  const filtering = ['city', 'min', 'max', 'condition'].some((k) => params[k]);
  const heading = params.q ? `«${esc(params.q)}»` : active ? esc(active.name) : 'Свежие объявления';
  const isWide = matchMedia('(min-width: 961px)').matches;

  view.innerHTML = `
    <div class="cats">
      ${state.meta.categories.map((c) => `
        <a class="cat${c.id === params.category ? ' active' : ''}" href="${esc(buildHash({ ...params, category: c.id === params.category ? '' : c.id, page: '' }))}">
          <span class="cat-icon" aria-hidden="true">${c.icon}</span>${esc(c.name)}
        </a>`).join('')}
    </div>
    <div class="layout">
      <details class="filters"${isWide || filtering ? ' open' : ''}>
        <summary>Фильтры</summary>
        <form id="filters">
          <label class="field">Город
            <select name="city"><option value="">Все города</option>${options(state.meta.cities, params.city)}</select>
          </label>
          <div class="field">Цена, ₽
            <div class="range">
              <input name="min" type="number" min="0" inputmode="numeric" placeholder="от" aria-label="Цена от" value="${esc(params.min)}">
              <input name="max" type="number" min="0" inputmode="numeric" placeholder="до" aria-label="Цена до" value="${esc(params.max)}">
            </div>
          </div>
          <label class="field">Состояние
            <select name="condition"><option value="">Любое</option>${options(state.meta.conditions.slice(0, 2), params.condition)}</select>
          </label>
          <label class="field">Сортировка
            <select name="sort">${options([
              { id: 'new', name: 'Сначала новые' },
              { id: 'price_asc', name: 'Сначала дешевле' },
              { id: 'price_desc', name: 'Сначала дороже' },
            ], params.sort || 'new')}</select>
          </label>
          ${extras.fieldsHTML(params.category, params, true)}${extras.filterHTML(params)}
          <div class="stack">
            <button class="btn btn-primary btn-block" type="submit">Показать</button>
            <a class="btn btn-block" href="#/">Сбросить</a>
          </div>
        </form>
      </details>
      <section>
        <div class="result-head">
          <h1>${heading}</h1><button class="btn btn-small" id="save-search" type="button">Сохранить поиск</button>
          <span class="muted small">${data.total} ${plural(data.total, 'объявление', 'объявления', 'объявлений')}</span>
        </div>
        ${data.items.length ? gridHtml(data.items) : emptyHtml('🔍', 'Ничего не нашлось. Попробуйте изменить запрос или фильтры.')}
        ${data.pages > 1 ? `<div class="pager">
          ${data.page > 1 ? `<a class="btn" href="${esc(buildHash({ ...params, page: data.page - 1 }))}">← Назад</a>` : ''}
          <span class="muted">Страница ${data.page} из ${data.pages}</span>
          ${data.page < data.pages ? `<a class="btn" href="${esc(buildHash({ ...params, page: data.page + 1 }))}">Дальше →</a>` : ''}
        </div>` : ''}
      </section>
    </div>`;

  document.getElementById('save-search').addEventListener('click', () => extras.saveSearch(params));
  extras.bindFilter(document.getElementById('filters'));
  document.getElementById('filters').addEventListener('submit', (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    if (values.radius && (!values.lat || !values.lon)) { toast('Сначала выберите местоположение'); return; }
    if (values.sort === 'new') values.sort = '';
    location.hash = buildHash({ q: params.q, category: params.category, ...values });
  });
}

// ---------- listing ----------
async function listingPage([id], _, isCurrent) {
  const { listing: l, seller } = await api(`/api/listings/${id}`);
  if (!isCurrent()) return;
  const mine = state.user?.id === l.userId;
  const statusTag = { sold: '<span class="tag tag-sold">Продано</span>', archived: '<span class="tag">Снято с публикации</span>' }[l.status] || '';
  document.title = `${l.title} — Рядом`;

  const contact = mine ? `
      <div class="stack">
        <a class="btn btn-block" href="#/edit/${l.id}">Редактировать</a>
        <a class="btn btn-block" href="#/me">Все мои объявления</a>
      </div>`
    : l.status !== 'active' || l.expiresAt <= Date.now() || l.moderation !== 'approved' ? '<p class="muted">Объявление неактивно.</p>'
    : state.user ? `
      <form id="contact">
        <label class="field">Сообщение продавцу
          <textarea name="text" maxlength="2000" required>Здравствуйте! Ещё актуально?</textarea>
        </label>
        <button class="btn btn-primary btn-block" type="submit">Написать</button>
      </form>`
    : '<a class="btn btn-primary btn-block" id="login-to-write" href="#/login">Войти, чтобы написать</a>';

  view.innerHTML = `
    <div class="small muted crumb">
      <a href="${esc(buildHash({ category: l.category }))}">${esc(category(l.category)?.name)}</a> · ${esc(l.city)}
    </div>
    <h1>${esc(l.title)} ${statusTag}</h1>${mine && l.moderation !== 'approved' ? `<p class="notice">${l.moderation === 'pending' ? 'На проверке у модератора' : 'Отклонено: ' + esc(l.moderationNote)}</p>` : ''}
    <div class="detail">
      <div>
        <div class="panel">
          ${l.photos.length
            ? `<img id="main-photo" class="gallery-main" src="${esc(l.photos[0])}" alt="${esc(l.title)}">
               ${l.photos.length > 1 ? `<div class="thumbs">${l.photos.map((p, i) => `
                 <button type="button" data-photo="${esc(p)}" class="${i === 0 ? 'on' : ''}" aria-label="Фото ${i + 1}"><img src="${esc(p)}" alt=""></button>`).join('')}</div>` : ''}`
            : `<div class="gallery-main ph ph-${esc(l.category)}" aria-hidden="true">${category(l.category)?.icon ?? '📦'}</div>`}
        </div>
        <div class="panel">
          <h2>Описание</h2>
          <div class="desc">${esc(l.description)}</div>
        </div>
      </div>
      <aside>
        <div class="panel">
          <div class="price-big">${formatPrice(l.price)}</div>
          <dl class="facts">
            <dt>Город</dt><dd>${esc(l.city)}</dd>${extras.detailsHTML(l)}${l.district ? `<dt>Район</dt><dd>${esc(l.district)}</dd>` : ''}<dt>Опубликовано до</dt><dd>${esc(formatDate(l.expiresAt))}</dd>
            ${l.condition !== 'na' ? `<dt>Состояние</dt><dd>${esc(conditionName(l.condition))}</dd>` : ''}
            <dt>Размещено</dt><dd>${esc(formatDate(l.createdAt))}</dd>
            <dt>Просмотры</dt><dd>${l.views}</dd>
          </dl>
          ${contact}
          ${mine ? '' : `<button class="btn btn-block" id="report-listing" type="button">Пожаловаться</button><button class="btn btn-block" id="fav-big" type="button" data-on="${l.isFavorite}">${l.isFavorite ? '♥ В избранном' : '♡ В избранное'}</button>`}
        </div>
        <div class="panel">
          <a class="seller" href="#/user/${seller.id}">
            ${extras.avatarHtml(seller)}
            <span>
              <strong>${esc(seller.name)}</strong><br>
              <span class="small muted">${seller.rating ? `${stars(seller.rating)} ${seller.rating} · ${seller.reviewCount} ${plural(seller.reviewCount, 'отзыв', 'отзыва', 'отзывов')}` : 'Пока нет отзывов'}</span>
            </span>
          </a>
          <div class="small muted">На сервисе с ${esc(new Date(seller.createdAt).toLocaleDateString('ru-RU'))}</div>
        </div>
      </aside>
    </div>`;

  document.getElementById('login-to-write')?.addEventListener('click', () => { state.returnTo = location.hash; });
  const contactForm = document.getElementById('contact');
  if (contactForm) {
    bindForm(contactForm, async ({ text }) => {
      const { conversationId } = await api(`/api/listings/${l.id}/messages`, { method: 'POST', body: { text } });
      location.hash = `#/messages/${conversationId}`;
    });
  }
  view.querySelector('.thumbs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-photo]');
    if (!button) return;
    document.getElementById('main-photo').src = button.dataset.photo;
    view.querySelectorAll('.thumbs button').forEach((b) => b.classList.toggle('on', b === button));
  });
  document.getElementById('report-listing')?.addEventListener('click', () => extras.report({ listingId: l.id }));
  const favBig = document.getElementById('fav-big');
  favBig?.addEventListener('click', async () => {
    if (!state.user) return requireLogin();
    const on = favBig.dataset.on !== 'true';
    try {
      await api(`/api/favorites/${l.id}`, { method: on ? 'PUT' : 'DELETE' });
      favBig.dataset.on = String(on);
      favBig.textContent = on ? '♥ В избранном' : '♡ В избранное';
    } catch (err) { if (!isAuthError(err)) toast(err.message); }
  });
}

// ---------- create / edit ----------
// ---------- my listings ----------
async function myPage(_, __, isCurrent) {
  if (!state.user) return requireLogin();
  const { items } = await api('/api/me/listings');
  if (!isCurrent()) return;
  const statusLabel = { active: 'Активно', sold: 'Продано', archived: 'Снято' };
  view.innerHTML = `
    <div class="result-head">
      <h1>Мои объявления</h1><a class="btn btn-small" href="#/drafts">Черновики</a><a class="btn btn-small" href="#/stats">Статистика</a>
      <a href="#/user/${state.user.id}" class="small">Как меня видят другие</a>
    </div>
    ${items.length ? items.map((l) => `
      <div class="row-item">
        ${photoOrPlaceholder(l, 'row-thumb')}
        <div class="row-main">
          <a class="row-title" href="#/listing/${l.id}">${esc(l.title)}</a>
          <div class="small"><strong>${formatPrice(l.price)}</strong> · <span class="muted">${l.views} ${plural(l.views, 'просмотр', 'просмотра', 'просмотров')}</span> · <span class="tag${l.status === 'sold' ? ' tag-sold' : ''}">${statusLabel[l.status]}</span>${l.moderation !== 'approved' ? `<span class="tag">${l.moderation === 'pending' ? 'На проверке' : 'Отклонено'}</span>` : ''}</div>
          <div class="row-actions">
            <a class="btn btn-small" href="#/edit/${l.id}">Изменить</a>
            ${l.status === 'active'
              ? `<button class="btn btn-small" type="button" data-status="sold" data-id="${l.id}">Продано</button>
                 <button class="btn btn-small" type="button" data-status="archived" data-id="${l.id}">Снять</button>`
              : `<button class="btn btn-small" type="button" data-status="active" data-id="${l.id}">Опубликовать снова</button>`}
            <button class="btn btn-small btn-danger" type="button" data-delete="${l.id}">Удалить</button>${l.status === 'active' && l.moderation === 'approved' && l.expiresAt <= Date.now() + 3*86400000 ? `<button class="btn btn-small" type="button" data-renew="${l.id}">Продлить</button>` : ''}<span class="hint">До ${esc(formatDate(l.expiresAt))}</span>
          </div>
        </div>
      </div>`).join('')
    : emptyHtml('📦', 'У вас пока нет объявлений.', '<a class="btn btn-primary" href="#/new">Разместить объявление</a>')}`;

  view.querySelectorAll('[data-renew]').forEach(button => button.addEventListener('click', async () => { try { await api(`/api/listings/${button.dataset.renew}/renew`, { method: 'POST' }); toast('Публикация продлена'); render(); } catch(e) { toast(e.message); } }));
  view.addEventListener('click', async (event) => {
    const statusBtn = event.target.closest('[data-status]');
    const deleteBtn = event.target.closest('[data-delete]');
    if (!statusBtn && !deleteBtn) return;
    try {
      if (statusBtn) {
        await api(`/api/listings/${statusBtn.dataset.id}`, { method: 'PATCH', body: { status: statusBtn.dataset.status } });
      } else {
        if (!confirm('Удалить объявление? Вернуть его будет нельзя.')) return;
        await api(`/api/listings/${deleteBtn.dataset.delete}`, { method: 'DELETE' });
        toast('Объявление удалено');
      }
      render();
    } catch (err) { if (!isAuthError(err)) toast(err.message); }
  }, { signal: pageController.signal });
}

// ---------- favorites ----------
async function favoritesPage(_, __, isCurrent) {
  if (!state.user) return requireLogin();
  const { items } = await api('/api/favorites');
  if (!isCurrent()) return;
  view.innerHTML = `<h1>Избранное</h1>${items.length ? gridHtml(items)
    : emptyHtml('♡', 'Нажмите на сердечко в объявлении, чтобы сохранить его здесь.')}`;
}

// ---------- messages ----------
async function inboxPage(_, __, isCurrent) {
  if (!state.user) return requireLogin();
  const { items } = await api('/api/conversations');
  if (!isCurrent()) return;
  view.innerHTML = `<h1>Сообщения</h1>${items.length ? items.map((c) => `
    <a class="row-item" href="#/messages/${c.id}">
      ${photoOrPlaceholder(c.listing, 'row-thumb')}
      <div class="row-main">
        <div class="row-title">${esc(c.other.name)}${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</div>
        <div class="small ellipsis">${esc(c.listing.title)}</div>
        <div class="small muted ellipsis">${esc(c.lastText)}</div>
      </div>
      <div class="small muted">${esc(formatDate(c.updatedAt))}</div>
    </a>`).join('') : emptyHtml('💬', 'Здесь появятся ваши переписки с покупателями и продавцами.')}`;
}

// ---------- profile ----------
async function userPage([id], query, isCurrent) {
  const [profile, listings] = await Promise.all([
    api(`/api/users/${id}`),
    api(`/api/listings?seller=${id}&page=${encodeURIComponent(query.get('page') || '1')}`),
  ]);
  if (!isCurrent()) return;
  const { user: u, reviews, canReview } = profile;
  view.innerHTML = `
    <div class="panel">
      <div class="seller">
        ${extras.avatarHtml(u)}
        <div>
          <h1 class="profile-name">${esc(u.name)}</h1>${u.emailVerified ? '<span class="tag">Email подтверждён</span>' : ''}${u.blocked ? '<span class="tag">Аккаунт заблокирован</span>' : ''}<p class="desc">${esc(u.about)}</p><button class="link-btn" id="report-user">Пожаловаться</button>${state.user?.id !== u.id ? `<button class="btn btn-small" id="block-user" type="button">Заблокировать сообщения</button>` : ''}
          <div class="small muted">${esc(u.city)} · на сервисе с ${esc(new Date(u.createdAt).toLocaleDateString('ru-RU'))}</div>
          <div class="small">${u.rating ? `${stars(u.rating)} ${u.rating} · ${u.reviewCount} ${plural(u.reviewCount, 'отзыв', 'отзыва', 'отзывов')}` : '<span class="muted">Пока нет отзывов</span>'}</div>
        </div>
      </div>
    </div>
    <h2 class="section-gap">Объявления (${listings.total})</h2>
    ${listings.items.length ? gridHtml(listings.items) : emptyHtml('📦', 'Сейчас нет активных объявлений.')}
    ${listings.pages > 1 ? `<div class="pager">${listings.page > 1 ? `<a class="btn" href="#/user/${id}?page=${listings.page-1}">Назад</a>` : ''}<span>${listings.page} / ${listings.pages}</span>${listings.page < listings.pages ? `<a class="btn" href="#/user/${id}?page=${listings.page+1}">Далее</a>` : ''}</div>` : ''}
    <h2 class="section-gap">Отзывы</h2>
    <div class="panel">
      ${canReview ? `<form id="review" class="section-form">
        <div class="two">
          <label class="field">Ваша оценка
            <select name="rating">${options([5, 4, 3, 2, 1].map((n) => ({ id: String(n), name: '★'.repeat(n) })), '5')}</select>
          </label>
        </div>
        <label class="field">Комментарий
          <textarea name="text" maxlength="1000" placeholder="Как прошла сделка?"></textarea>
        </label>
        <button class="btn btn-primary" type="submit">Оставить отзыв</button>
      </form>` : ''}
      ${reviews.map((r) => `<div class="review">
        ${stars(r.rating)} <a href="#/user/${r.author.id}"><strong>${esc(r.author.name)}</strong></a>
        <span class="small muted">· ${esc(formatDate(r.createdAt))}</span>
        ${r.text ? `<div class="desc">${esc(r.text)}</div>` : ''}
      </div>`).join('') || (canReview ? '' : '<p class="muted">Отзывов пока нет. Оставить отзыв можно после переписки с продавцом.</p>')}
    </div>`;
  document.getElementById('block-user')?.addEventListener('click', () => extras.block(u.id, true));
  document.getElementById('report-user').addEventListener('click', () => extras.report({ userId: u.id }));
  const form = document.getElementById('review');
  if (form) {
    bindForm(form, async ({ rating, text }) => {
      await api(`/api/users/${id}/reviews`, { method: 'POST', body: { rating: Number(rating), text } });
      toast('Спасибо за отзыв!');
      render();
    });
  }
}

// ---------- auth ----------
function finishAuth(user) {
  state.user = user;
  const target = state.returnTo || '#/';
  state.returnTo = null;
  refreshNav();
  location.hash = target;
}

function loginPage() {
  if (state.user) { location.hash = '#/'; return; }
  view.innerHTML = `<div class="auth-wrap panel">
    <h1>Вход</h1>
    <form id="login">
      <label class="field">Email <input name="email" type="email" required autocomplete="email"></label>
      <label class="field">Пароль <input name="password" type="password" required autocomplete="current-password"></label>
      <button class="btn btn-primary btn-block" type="submit">Войти</button>
    </form>
    <p class="small"><a href="#/forgot">Забыли пароль?</a></p><p class="small">Ещё нет аккаунта? <a href="#/register">Зарегистрироваться</a></p>
  </div>`;
  bindForm(document.getElementById('login'), async (values) => {
    const { user } = await api('/api/auth/login', { method: 'POST', body: values });
    finishAuth(user);
  });
}

function registerPage() {
  if (state.user) { location.hash = '#/'; return; }
  view.innerHTML = `<div class="auth-wrap panel">
    <h1>Регистрация</h1>
    <form id="register">
      <label class="field">Имя <input name="name" required minlength="2" maxlength="40" autocomplete="name"></label>
      <label class="field">Email <input name="email" type="email" required autocomplete="email"></label>
      <label class="field">Город <select name="city">${options(state.meta.cities)}</select></label>
      <label class="field">Пароль <span class="hint">минимум 8 символов</span>
        <input name="password" type="password" required minlength="8" autocomplete="new-password">
      </label>
      <button class="btn btn-primary btn-block" type="submit">Создать аккаунт</button>
    </form>
    <p class="small">Уже есть аккаунт? <a href="#/login">Войти</a></p>
  </div>`;
  bindForm(document.getElementById('register'), async (values) => {
    const { user } = await api('/api/auth/register', { method: 'POST', body: values });
    finishAuth(user);
  });
}

// ---------- nav ----------
function renderNav() {
  nav.innerHTML = state.user ? `
    <a class="nav-link" href="#/favorites" title="Избранное" aria-label="Избранное">♡<span class="nav-text"> Избранное</span></a>
    <a class="nav-link" href="#/messages" title="Сообщения" aria-label="Сообщения">💬<span class="nav-text"> Сообщения</span>${state.unread ? `<span class="badge">${state.unread}</span>` : ''}</a>
    <a class="nav-link" href="#/me" title="Мои объявления" aria-label="Мои объявления">📦<span class="nav-text"> Мои</span></a>
    <a class="nav-link" href="#/settings" title="Профиль" aria-label="Настройки профиля">⚙<span class="nav-text"> Профиль</span></a><a class="nav-link" href="#/searches" title="Сохранённые поиски" aria-label="Сохранённые поиски">⌕</a><a class="nav-link" href="#/notifications" aria-label="Уведомления">🔔${state.notifications ? `<span class="badge">${state.notifications}</span>` : ''}</a>${state.user.role === 'admin' ? '<a class="nav-link" href="#/admin">Модерация</a>' : ''}
    <button class="link-btn small" id="logout" type="button">Выйти</button>
    <a class="btn btn-primary btn-small" href="#/new" aria-label="Разместить объявление">+<span class="nav-text"> Объявление</span></a>`
    : `<a class="nav-link" href="#/login">Войти</a>
       <a class="btn btn-primary btn-small" href="#/new" aria-label="Разместить объявление">+<span class="nav-text"> Объявление</span></a>`;
  document.getElementById('logout')?.addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { toast(e.message); return; }
    state.user = null;
    state.unread = 0;
    renderNav();
    location.hash = '#/';
    render();
  });
}

async function refreshNav() {
  try {
    const me = await api('/api/me');
    state.user = me.user;
    state.unread = me.unread;
    state.notifications = me.notifications || 0;
    renderNav();
  } catch { /* offline: keep the current header */ }
}

// ---------- router ----------
const extras = createFeaturesUI({ api, esc, options, bindForm, toast, view, requireLogin, formatDate, formatPrice, gridHtml, buildHash, refreshNav, render,
  get state() { return state; }, getSignal: () => pageController.signal, setStopPolling: fn => { stopPolling = fn; } });

const routes = [
  [/^\/blocks$/, extras.blocksPage],
  [/^\/stats$/, extras.statsPage],
  [/^\/operations$/, extras.operationsPage],
  [/^\/forgot$/, extras.forgotPage],
  [/^\/reset$/, extras.resetPage],
  [/^\/verify$/, extras.verifyPage],
  [/^\/settings$/, extras.settingsPage],
  [/^\/searches$/, extras.searchesPage],
  [/^\/notifications$/, extras.notificationsPage],
  [/^\/drafts$/, extras.draftsPage],
  [/^\/draft\/(\d+)$/, extras.draftEditorPage],
  [/^\/admin$/, extras.adminPage],
  [/^\/$/, homePage],
  [/^\/listing\/(\d+)$/, listingPage],
  [/^\/new$/, extras.editorPage],
  [/^\/edit\/(\d+)$/, extras.editorPage],
  [/^\/me$/, myPage],
  [/^\/favorites$/, favoritesPage],
  [/^\/messages$/, inboxPage],
  [/^\/messages\/(\d+)$/, extras.chatPage],
  [/^\/user\/(\d+)$/, userPage],
  [/^\/login$/, loginPage],
  [/^\/register$/, registerPage],
];

async function render() {
  const token = ++renderToken;
  const isCurrent = () => token === renderToken;
  stopPolling?.();
  stopPolling = null;
  pageController?.abort();
  pageController = new AbortController();
  document.title = 'Рядом — объявления от людей поблизости';

  const [rawPath, rawQuery = ''] = (location.hash.slice(1) || '/').split('?');
  const found = routes.map(([regex, page]) => ({ match: regex.exec(rawPath), page })).find((r) => r.match);
  window.scrollTo(0, 0);
  if (!found) {
    view.innerHTML = emptyHtml('🧭', 'Такой страницы нет.', '<a class="btn" href="#/">На главную</a>');
    return;
  }
  try {
    await found.page(found.match.slice(1), new URLSearchParams(rawQuery), isCurrent);
  } catch (err) {
    if (!isCurrent() || isAuthError(err)) return;
    view.innerHTML = emptyHtml(err.status === 404 ? '🧭' : '⚠️', err.message, '<a class="btn" href="#/">На главную</a>');
  }
}

// Favorite buttons live on cards across several pages, so they are handled globally.
view.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-fav]');
  if (!button) return;
  event.preventDefault();
  if (!state.user) return requireLogin();
  const on = !button.classList.contains('on');
  try {
    await api(`/api/favorites/${button.dataset.fav}`, { method: on ? 'PUT' : 'DELETE' });
    button.classList.toggle('on', on);
    button.textContent = on ? '♥' : '♡';
    button.setAttribute('aria-pressed', String(on));
    const label = on ? 'Убрать из избранного' : 'В избранное';
    button.setAttribute('aria-label', label);
    button.title = label;
  } catch (err) { if (!isAuthError(err)) toast(err.message); }
});

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const [path, rawQuery = ''] = location.hash.slice(1).split('?');
  const params = path === '/' ? Object.fromEntries(new URLSearchParams(rawQuery)) : {};
  location.hash = buildHash({ ...params, q: searchForm.q.value.trim(), page: '' });
});

window.addEventListener('hashchange', render);

async function start() {
  try {
    const [meta, me] = await Promise.all([api('/api/meta'), api('/api/me')]);
    state.meta = meta;
    state.user = me.user;
    state.unread = me.unread;
    state.notifications = me.notifications || 0;
  } catch (err) {
    view.innerHTML = emptyHtml('⚠️', err.message);
    return;
  }
  renderNav();
  await render();
  setInterval(() => { if (state.user && !document.hidden) refreshNav(); }, 20000);
}

start();
