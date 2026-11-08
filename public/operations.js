export function createOperationsUI({api,view,esc,toast,requireLogin,state,formatDate,render,refreshNav}) {
  function locationHTML(l={}) {
    return `<label class="field">Район<input name="district" maxlength="80" value="${esc(l.district)}" placeholder="Например, Центральный"></label>
    <details><summary>Место встречи для поиска поблизости</summary><p class="hint">Координаты округляются примерно до километра. Не указывайте точный адрес дома.</p>
      <div class="two"><label class="field">Широта<input name="latitude" type="number" step="0.01" min="-90" max="90" value="${esc(l.latitude)}"></label><label class="field">Долгота<input name="longitude" type="number" step="0.01" min="-180" max="180" value="${esc(l.longitude)}"></label></div>
      <button type="button" class="btn btn-small" data-geolocate>Использовать моё местоположение</button><button type="button" class="btn btn-small" data-clear-location>Убрать координаты</button></details>`;
  }
  function bindLocation(form,changed) {
    form.querySelector('[data-geolocate]')?.addEventListener('click',()=>{
      if(!navigator.geolocation){toast('Геолокация недоступна');return;}
      navigator.geolocation.getCurrentPosition(p=>{form.elements.latitude.value=p.coords.latitude.toFixed(2);form.elements.longitude.value=p.coords.longitude.toFixed(2);changed();},()=>toast('Не удалось определить место. Можно ввести координаты вручную.'),{timeout:10000,enableHighAccuracy:false});
    });
    form.querySelector('[data-clear-location]')?.addEventListener('click',()=>{form.elements.latitude.value='';form.elements.longitude.value='';changed();});
  }
  function filterHTML(params) {
    return `<label class="field">Район<input name="district" maxlength="80" value="${esc(params.district)}"></label>
      <label class="field">Радиус, км<select name="radius"><option value="">Без ограничения</option>${[1,3,5,10,25,50,100,500].map(n=>`<option value="${n}"${String(n)===params.radius?' selected':''}>${n} км</option>`).join('')}</select></label>
      <input type="hidden" name="lat" value="${esc(params.lat)}"><input type="hidden" name="lon" value="${esc(params.lon)}">
      <button type="button" class="btn btn-small" id="near-me">Искать рядом со мной</button><p class="hint" id="location-state">${params.lat && params.lon ? 'Местоположение выбрано' : 'Для радиуса выберите местоположение'}</p>`;
  }
  function bindFilter(form) {
    form.querySelector('#near-me').addEventListener('click',()=>{
      if(!navigator.geolocation){toast('Геолокация недоступна');return;}
      navigator.geolocation.getCurrentPosition(p=>{form.elements.lat.value=p.coords.latitude.toFixed(2);form.elements.lon.value=p.coords.longitude.toFixed(2);if(!form.elements.radius.value)form.elements.radius.value='10';form.querySelector('#location-state').textContent='Местоположение выбрано';form.requestSubmit();},()=>toast('Разрешите доступ к местоположению в браузере'),{timeout:10000});
    });
  }
  async function block(userId,blocked) {
    if(!state.user)return requireLogin();
    try{await api(`/api/blocks/${userId}`,{method:blocked?'PUT':'DELETE'});toast(blocked?'Собеседник заблокирован':'Блокировка снята');render();}catch(e){toast(e.message);}
  }
  async function blocksPage(_,__,current) {
    if(!state.user)return requireLogin();
    const {items}=await api('/api/blocks');if(!current())return;
    view.innerHTML=`<h1>Заблокированные собеседники</h1><p class="muted">Вы не можете отправлять друг другу сообщения. История переписки сохранена.</p>${items.map(u=>`<div class="row-item"><a class="row-main" href="#/user/${u.id}">${esc(u.name)}</a><button class="btn" data-unblock="${u.id}">Разблокировать</button></div>`).join('')||'<p>Список пуст.</p>'}`;
    view.querySelectorAll('[data-unblock]').forEach(b=>b.onclick=()=>block(b.dataset.unblock,false));
  }
  async function statsPage(_,__,current) {
    if(!state.user)return requireLogin();const data=await api('/api/me/stats');if(!current())return;
    view.innerHTML=`<h1>Статистика объявлений</h1><p class="muted">Просмотры: один посетитель в день на объявление, без собственных просмотров. Избранное: текущие сохранения. Обращения: начатые переписки.</p>
      <div class="table-scroll"><table><thead><tr><th>Объявление</th><th>Просмотры</th><th>Избранное</th><th>Обращения</th><th>Срок</th></tr></thead><tbody>${data.items.map(l=>`<tr><td><a href="#/listing/${l.id}">${esc(l.title)}</a></td><td>${l.views}</td><td>${l.favorites}</td><td>${l.contacts}</td><td>${esc(formatDate(l.expiresAt))}</td></tr>`).join('')}</tbody></table></div>
      <h2 class="section-gap">Последние 30 дней</h2><div class="table-scroll"><table><thead><tr><th>Дата</th><th>Просмотры</th><th>Добавления в избранное</th></tr></thead><tbody>${data.daily.map(d=>`<tr><td>${esc(d.day)}</td><td>${d.views}</td><td>${d.favorites}</td></tr>`).join('')}</tbody></table></div>`;
  }
  async function operationsPage(_,__,current) {
    if(!state.user)return requireLogin();const data=await api('/api/admin/operations');if(!current())return;
    const backup=data.state.backup,maintenance=data.state.maintenance;
    view.innerHTML=`<h1>Состояние сервиса</h1><div class="panel"><h2>Резервные копии</h2><p>${backup?`Последняя проверенная копия: ${esc(formatDate(backup.at))}`:'Копия ещё не создана'}</p>${data.state.backupError && (!backup || data.state.backupError.at>backup.at)?'<p class="error">Не удалось создать последнюю копию. Проверьте сервер.</p>':''}<h2>Обслуживание</h2><p>${maintenance?`${esc(formatDate(maintenance.at))} · удалено лишних фото: ${maintenance.removed}`:'Ещё не запускалось'}</p><h2>Почта</h2>${data.mail.map(m=>`<p>${esc({pending:'В очереди',sent:'Отправлено',failed:'Ошибка',skipped:'Пропущено'}[m.status]||m.status)}: ${m.count}</p>`).join('')||'<p>Очередь пуста</p>'}</div>
      <h2 class="section-gap">Последние ошибки</h2><div class="table-scroll"><table><thead><tr><th>Время</th><th>Запрос</th><th>Код</th><th>ID</th></tr></thead><tbody>${data.errors.map(e=>`<tr><td>${esc(formatDate(e.created_at))}</td><td>${esc(e.method)} ${esc(e.path)}</td><td>${esc(e.code)}</td><td>${esc(e.request_id)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  return {locationHTML,bindLocation,filterHTML,bindFilter,block,blocksPage,statsPage,operationsPage};
}
