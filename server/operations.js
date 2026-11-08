import crypto from 'node:crypto';
import path from 'node:path';
import { createBackup, cleanupUploads } from './backups.js';

export function installOperations({route,q,db,fail,requireUser,getOwnListing,sendMail,baseUrl,dataDir,backupDir=path.join(dataDir,'backups'),listingDays=30,limit}) {
  const day = now => new Date(now).toISOString().slice(0,10);
  const state = (key,value) => q('INSERT INTO maintenance_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
  const isBlocked = (a,b) => Boolean(q('SELECT 1 FROM user_blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)').get(a,b,b,a));
  function notify(userId,kind,text,key,{listingId=null,conversationId=null}={}) {
    q('INSERT OR IGNORE INTO notifications (user_id,kind,text,dedupe_key,listing_id,conversation_id,created_at) VALUES (?,?,?,?,?,?,?)').run(userId,kind,text,key,listingId,conversationId,Date.now());
  }
  function queueMail(userId,subject,text,key,conversationId=null) {
    const user=q('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user?.email_verified || !user.email_notifications || user.blocked) return;
    q('INSERT OR IGNORE INTO mail_jobs(user_id,conversation_id,dedupe_key,subject,text,due_at,created_at) VALUES (?,?,?,?,?,?,?)').run(userId,conversationId,key,subject,text,Date.now()+60000,Date.now());
  }
  function messageSent(conv,senderId) {
    const recipient=conv.buyer_id === senderId ? conv.seller_id : conv.buyer_id;
    const key=`message:${conv.id}:${recipient}`;
    const existing=q('SELECT id FROM notifications WHERE dedupe_key = ?').get(key);
    if (existing) q('UPDATE notifications SET read_at = NULL, created_at = ? WHERE id = ?').run(Date.now(),existing.id);
    else notify(recipient,'message','Новое сообщение в переписке',key,{conversationId:conv.id});
    const bucket=Math.floor(Date.now()/600000);
    queueMail(recipient,'Рядом — новое сообщение',`Вам написали. Откройте переписку: ${baseUrl}/#/messages/${conv.id}`,`${key}:${bucket}`,conv.id);
  }
  function recordView(listingId,viewer) {
    const today=day(Date.now()), hash=crypto.createHash('sha256').update(viewer).digest('hex');
    if (!q('INSERT OR IGNORE INTO view_events(listing_id,day,viewer) VALUES (?,?,?)').run(listingId,today,hash).changes) return false;
    q('UPDATE listings SET views = views + 1 WHERE id = ?').run(listingId);
    q('INSERT INTO listing_stats(listing_id,day,views) VALUES (?,?,1) ON CONFLICT(listing_id,day) DO UPDATE SET views=views+1').run(listingId,today);
    return true;
  }
  function recordFavorite(listingId) { q('INSERT INTO listing_stats(listing_id,day,favorites) VALUES (?,?,1) ON CONFLICT(listing_id,day) DO UPDATE SET favorites=favorites+1').run(listingId,day(Date.now())); }
  const admin = ctx => { const u=requireUser(ctx); if(u.role!=='admin') fail(403,'Доступ только для модератора'); return u; };
  route('GET','/api/blocks',ctx=>({items:q('SELECT u.id,u.name,b.created_at FROM user_blocks b JOIN users u ON u.id=b.blocked_id WHERE b.user_id=? ORDER BY b.created_at DESC').all(requireUser(ctx).id)}));
  route('PUT','/api/blocks/:id',ctx=>{
    const user=requireUser(ctx); limit(`block:${user.id}`,30,3600000);
    if(user.id===ctx.params.id) fail(400,'Нельзя заблокировать себя');
    if(!q('SELECT 1 FROM users WHERE id=?').get(ctx.params.id)) fail(404,'Пользователь не найден');
    q('INSERT OR IGNORE INTO user_blocks(user_id,blocked_id,created_at) VALUES (?,?,?)').run(user.id,ctx.params.id,Date.now()); return {ok:true};
  });
  route('DELETE','/api/blocks/:id',ctx=>{q('DELETE FROM user_blocks WHERE user_id=? AND blocked_id=?').run(requireUser(ctx).id,ctx.params.id);return {ok:true};});
  route('PATCH','/api/me/preferences',ctx=>{
    const user=requireUser(ctx);
    if(typeof ctx.body.emailNotifications!=='boolean') fail(400,'Укажите настройку уведомлений');
    if(ctx.body.emailNotifications && !user.email_verified) fail(400,'Сначала подтвердите email');
    q('UPDATE users SET email_notifications=? WHERE id=?').run(Number(ctx.body.emailNotifications),user.id);return {ok:true};
  });
  route('GET','/api/me/stats',ctx=>{
    const user=requireUser(ctx);
    return {items:q(`SELECT l.id,l.title,l.views,l.status,l.expires_at AS expiresAt,
      (SELECT COUNT(*) FROM favorites f WHERE f.listing_id=l.id) AS favorites,
      (SELECT COUNT(*) FROM conversations c WHERE c.listing_id=l.id) AS contacts
      FROM listings l WHERE l.user_id=? AND l.status!='deleted' ORDER BY l.created_at DESC`).all(user.id),
      daily:q(`SELECT s.day,SUM(s.views) AS views,SUM(s.favorites) AS favorites FROM listing_stats s JOIN listings l ON l.id=s.listing_id
        WHERE l.user_id=? AND s.day>=? GROUP BY s.day ORDER BY s.day`).all(user.id,day(Date.now()-29*86400000))};
  });
  route('POST','/api/listings/:id/renew',ctx=>{
    const user=requireUser(ctx),row=getOwnListing(ctx.params.id,user);
    limit(`renew:${user.id}`,30,3600000);
    if(row.status!=='active' || row.moderation!=='approved') fail(400,'Сначала опубликуйте объявление');
    if(row.expires_at>Date.now()+3*86400000) fail(400,'Продление доступно за три дня до окончания');
    q('UPDATE listings SET expires_at=?,updated_at=? WHERE id=?').run(Date.now()+listingDays*86400000,Date.now(),row.id);return {ok:true};
  });
  route('GET','/api/admin/operations',ctx=>{admin(ctx);return {
    state:Object.fromEntries(q('SELECT * FROM maintenance_state').all().map(r=>[r.key,JSON.parse(r.value)])),
    errors:q('SELECT * FROM error_events ORDER BY id DESC LIMIT 100').all(),
    mail:q('SELECT status,COUNT(*) AS count FROM mail_jobs GROUP BY status').all(),
  };});
  route('GET','/api/health',()=>{q('SELECT 1').get();return {status:'ok'};});
  function recordError(req,error) {
    const id=crypto.randomUUID();
    // Never log bodies, cookies, email addresses, query strings, SMTP URLs or stacks.
    const routePath=new URL(req.url,'http://local').pathname.replace(/\d+/g,':id').slice(0,160);
    try { q('INSERT INTO error_events(request_id,method,path,code,created_at) VALUES (?,?,?,?,?)').run(id,req.method,routePath,/^[A-Z_0-9]+$/.test(error.code || '') ? error.code : 'INTERNAL_ERROR',Date.now()); }
    catch { /* Console reporting remains available when the database itself is failing. */ }
    console.error(JSON.stringify({event:'request_failed',requestId:id,method:req.method,path:routePath}));
    return id;
  }
  let running=null;
  async function work({backup=false,now=Date.now()}={}) {
    const expiring=q("SELECT * FROM listings WHERE status='active' AND moderation='approved' AND expires_at <= ?").all(now+3*86400000);
    for(const row of expiring) {
      const expired=row.expires_at<=now, key=`expiry:${row.id}:${row.expires_at}:${expired?'expired':'soon'}`;
      const text=expired?'Срок объявления закончился. Опубликуйте его снова.':'Срок объявления закончится через три дня или раньше. Можно продлить публикацию.';
      notify(row.user_id,'expiry',text,key,{listingId:row.id});
      queueMail(row.user_id,'Рядом — срок объявления',`${text}\n${baseUrl}/#/me`,key);
      if(expired) q("UPDATE listings SET status='archived',updated_at=? WHERE id=?").run(now,row.id);
    }
    for(const job of q("SELECT * FROM mail_jobs WHERE status='pending' AND due_at<=? ORDER BY id LIMIT 20").all(now)) {
      const user=q('SELECT * FROM users WHERE id=?').get(job.user_id);
      let skip=!user?.email_verified || !user.email_notifications || user.blocked;
      if(job.conversation_id) {
        const conv=q('SELECT * FROM conversations WHERE id=?').get(job.conversation_id);
        skip ||= !conv || isBlocked(conv.buyer_id,conv.seller_id) || !q('SELECT 1 FROM messages WHERE conversation_id=? AND sender_id!=? AND read_at IS NULL').get(job.conversation_id,job.user_id);
      }
      if(skip){q("UPDATE mail_jobs SET status='skipped' WHERE id=?").run(job.id);continue;}
      try { await sendMail({to:user.email,subject:job.subject,text:job.text});q("UPDATE mail_jobs SET status='sent',attempts=attempts+1 WHERE id=?").run(job.id); }
      catch { q('UPDATE mail_jobs SET attempts=attempts+1,due_at=?,status=? WHERE id=?').run(now+Math.min(3600000,60000*2**job.attempts),job.attempts>=4?'failed':'pending',job.id);state('mailError',{at:now,message:'Не удалось отправить письмо; проверьте SMTP'}); }
    }
    const last=JSON.parse(q("SELECT value FROM maintenance_state WHERE key='backup'").get()?.value || 'null');
    if(backup || !last || now-last.at>=86400000) {
      try { const directory=await createBackup(db,dataDir,backupDir);state('backup',{at:now,directory,verified:true}); }
      catch { state('backupError',{at:now,message:'Резервная копия не создана. Проверьте каталог и доступность фото.'}); }
    }
    const removed=await cleanupUploads(db,dataDir);
    q('DELETE FROM error_events WHERE created_at < ?').run(now-30*86400000);
    q('DELETE FROM view_events WHERE day < ?').run(day(now-90*86400000));
    q("DELETE FROM mail_jobs WHERE status IN ('sent','skipped') AND created_at < ?").run(now-30*86400000);
    state('maintenance',{at:now,removed});
  }
  const run = options => running || (running=work(options).finally(()=>{running=null;}));
  return {isBlocked,messageSent,recordView,recordFavorite,recordError,run,wait:()=>running || Promise.resolve()};
}
