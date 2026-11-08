let loader;
function load() {
  if (window.turnstile) return Promise.resolve();
  if (!loader) loader=new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async=true;script.onload=resolve;script.onerror=()=>{loader=null;reject(new Error('Не удалось загрузить CAPTCHA'));};
    document.head.append(script);
  });
  return loader;
}
export async function solveCaptcha(siteKey) {
  await load();
  return new Promise((resolve,reject)=>{
    const dialog=document.createElement('dialog');dialog.className='captcha-dialog';
    dialog.innerHTML='<h2>Проверка безопасности</h2><p>Подтвердите, что вы не робот.</p><div class="captcha-widget"></div><button class="btn" type="button">Отмена</button>';
    document.body.append(dialog);dialog.showModal();
    let widget,done=false;
    const finish=(error,token)=>{if(done)return;done=true;if(widget!==undefined)window.turnstile.remove(widget);dialog.close();dialog.remove();error?reject(error):resolve(token);};
    dialog.addEventListener('cancel',()=>finish(new Error('Проверка отменена')));
    dialog.querySelector('button').onclick=()=>finish(new Error('Проверка отменена'));
    widget=window.turnstile.render(dialog.querySelector('.captcha-widget'),{sitekey:siteKey,action:'submit',language:'ru',callback:token=>finish(null,token),'error-callback':()=>finish(new Error('CAPTCHA недоступна. Попробуйте позже.')),'expired-callback':()=>finish(new Error('Проверка истекла. Повторите действие.'))});
  });
}
