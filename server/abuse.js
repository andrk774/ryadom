import crypto from 'node:crypto';
export function createAbuse({ db, fail, siteKey, secretKey, hostname, verifyCaptcha }) {
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  function hit(key, windowMs) {
    const now = Date.now(), k = hash(key);
    db.prepare('DELETE FROM rate_limits WHERE reset_at < ?').run(now);
    return db.prepare(`INSERT INTO rate_limits (key,count,reset_at) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count`).get(k,now+windowMs).count;
  }
  const limit = (key,max,windowMs) => { if (hit(key,windowMs) > max) fail(429,'Слишком много запросов. Попробуйте позже.'); };
  async function guard({req,body,user,ip}) {
    const pathname = new URL(req.url,'http://local').pathname;
    let kind, threshold, windowMs = 600000;
    if (pathname === '/api/auth/register') { kind='register'; threshold=3; }
    else if (pathname === '/api/auth/login') { kind='login'; threshold=5; }
    else if (pathname === '/api/reports') { kind='report'; threshold=3; }
    else if (/\/messages$/.test(pathname)) { kind='message'; threshold=20; windowMs=60000; }
    else return;
    if (req.method !== 'POST') return;
    const identity = ['register','login'].includes(kind) ? ip : user?.id || ip;
    const count = hit(`suspicious:${kind}:${identity}`,windowMs);
    if (count <= threshold) return;
    if (count > threshold * 10) fail(429,'Лимит попыток исчерпан. Попробуйте позже.');
    if (!siteKey || (!secretKey && !verifyCaptcha)) fail(429,'Слишком много попыток. Попробуйте позже.');
    const challenge = () => { const error = new Error('Подтвердите, что вы не робот'); error.status=428; error.code='CAPTCHA_REQUIRED'; error.siteKey=siteKey; throw error; };
    const token = body.captchaToken;
    if (typeof token !== 'string' || !token || token.length > 2048) challenge();
    const tokenHash = hash(token);
    db.prepare('DELETE FROM captcha_tokens WHERE expires_at < ?').run(Date.now());
    if (!db.prepare('INSERT OR IGNORE INTO captcha_tokens(hash,expires_at) VALUES (?,?)').run(tokenHash,Date.now()+300000).changes) challenge();
    let result;
    try {
      result = verifyCaptcha ? await verifyCaptcha(token, ip) : await (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:secretKey,response:token,remoteip:ip}),signal:AbortSignal.timeout(10000),
      })).json();
    } catch { fail(503,'Проверка CAPTCHA временно недоступна'); }
    if (!result.success || (hostname && result.hostname !== hostname) || result.action !== 'submit') challenge();
  }
  return {limit,guard};
}
