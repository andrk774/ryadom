import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import net from 'node:net';
import {createApp} from '../server/app.js';
import {createBackup,verifyBackup,restoreBackup,cleanupUploads} from '../server/backups.js';
import {createMailer} from '../server/mail.js';
import {createAbuse} from '../server/abuse.js';
import {distanceKm} from '../server/location.js';

async function fixture(t,over={}) {
  const root=path.resolve(os.tmpdir()),dir=fs.mkdtempSync(path.join(root,'ryadom-ops-')),mail=[];
  const app=createApp({dataDir:dir,abuseProtection:false,sendMail:async m=>mail.push(m),...over});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();assert.equal(path.dirname(path.resolve(dir)),root);assert.ok(path.basename(dir).startsWith('ryadom-ops-'));fs.rmSync(dir,{recursive:true,force:true});});
  class Client {
    cookie='';
    async call(method,url,body) {const r=await fetch(base+url,{method,headers:{Cookie:this.cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))this.cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};}
    get(url){return this.call('GET',url);}
    post(url,body={}){return this.call('POST',url,body);}
    patch(url,body){return this.call('PATCH',url,body);}
  }
  const register=async name=>{const c=new Client(),r=await c.post('/api/auth/register',{name,email:name+'@example.test',password:'password123',city:'Казань'});assert.equal(r.status,201);c.id=r.data.user.id;return c;};
  return {app,dir,mail,base,register,anon:new Client()};
}
const listing=(extra={})=>({title:'Товар для проверки',description:'Полное описание товара',price:1000,category:'hobby',city:'Казань',condition:'used',...extra});

test('blocking prevents messages in both directions, including new conversations; history remains readable',async t=>{
  const f=await fixture(t),seller=await f.register('seller'),buyer=await f.register('buyer');
  const id=(await seller.post('/api/listings',listing())).data.listing.id;
  const conv=(await buyer.post(`/api/listings/${id}/messages`,{text:'Hello'})).data.conversationId;
  assert.equal((await seller.call('PUT',`/api/blocks/${buyer.id}`)).status,200);
  for(const c of [seller,buyer])assert.equal((await c.post(`/api/conversations/${conv}/messages`,{text:'Blocked'})).status,403);
  assert.equal((await buyer.post(`/api/listings/${id}/messages`,{text:'Bypass'})).status,403);
  assert.equal((await buyer.get(`/api/conversations/${conv}`)).data.blocked,true);
  assert.equal((await seller.get('/api/blocks')).data.items[0].id,buyer.id);
  assert.equal((await buyer.get('/api/blocks')).data.items.length,0);
  await seller.call('DELETE',`/api/blocks/${buyer.id}`);
  assert.equal((await buyer.post(`/api/conversations/${conv}/messages`,{text:'Allowed'})).status,201);
});

test('nearby and district filters work together; coordinates are validated and rounded',async t=>{
  const f=await fixture(t),seller=await f.register('seller');
  const a=(await seller.post('/api/listings',listing({district:'Центральный',latitude:55.75123,longitude:37.61123}))).data.listing;
  assert.equal(a.latitude,55.75);assert.equal(a.longitude,37.61);
  await seller.post('/api/listings',listing({latitude:59.94,longitude:30.31}));
  assert.equal((await f.anon.get('/api/listings?lat=55.75&lon=37.61&radius=3')).data.total,1);
  assert.equal((await f.anon.get('/api/listings?district='+encodeURIComponent('Центральный'))).data.total,1);
  assert.equal((await f.anon.get('/api/listings?lat=999&lon=37&radius=3')).data.total,0);
  assert.equal((await seller.post('/api/listings',listing({latitude:200,longitude:0}))).status,400);
  assert.equal((await seller.post('/api/listings',listing({latitude:50}))).status,400);
  assert.ok(distanceKm(55.75,37.61,59.94,30.31)>600);
});

test('seller stats count unique daily views, favorites and contacts without exposing another seller',async t=>{
  const f=await fixture(t),seller=await f.register('seller'),buyer=await f.register('buyer');
  const id=(await seller.post('/api/listings',listing())).data.listing.id;
  await seller.get(`/api/listings/${id}`);await buyer.get(`/api/listings/${id}`);await buyer.get(`/api/listings/${id}`);
  await buyer.call('PUT',`/api/favorites/${id}`);await buyer.call('PUT',`/api/favorites/${id}`);
  await buyer.post(`/api/listings/${id}/messages`,{text:'Interested'});
  const stats=(await seller.get('/api/me/stats')).data;
  assert.deepEqual([stats.items[0].views,stats.items[0].favorites,stats.items[0].contacts],[1,1,1]);
  assert.equal(stats.daily[0].views,1);assert.equal(stats.daily[0].favorites,1);
  assert.equal((await buyer.get('/api/me/stats')).data.items.length,0);
  assert.equal((await f.anon.get('/api/me/stats')).status,401);
});

test('expiry reminders deduplicate, listings expire and renewal/republication restore deadlines',async t=>{
  const f=await fixture(t),seller=await f.register('seller');
  const id=(await seller.post('/api/listings',listing())).data.listing.id;
  assert.equal((await seller.post(`/api/listings/${id}/renew`)).status,400);
  f.app.db.prepare('UPDATE listings SET expires_at=? WHERE id=?').run(Date.now()+86400000,id);
  await f.app.maintenance();await f.app.maintenance();
  assert.equal((await seller.get('/api/notifications')).data.items.filter(n=>n.kind==='expiry').length,1);
  assert.equal((await seller.post(`/api/listings/${id}/renew`)).status,200);
  f.app.db.prepare('UPDATE listings SET expires_at=? WHERE id=?').run(Date.now()-1,id);
  assert.equal((await f.anon.get('/api/listings')).data.total,0);
  await f.app.maintenance();
  assert.equal((await seller.get(`/api/listings/${id}`)).data.listing.status,'archived');
  await seller.patch(`/api/listings/${id}`,{status:'active'});
  assert.equal((await f.anon.get('/api/listings')).data.total,1);
});

test('message emails require opt-in and verification, retry on failure, skip read or blocked chats',async t=>{
  let failMail=false;const delivered=[];
  const f=await fixture(t,{sendMail:async m=>{if(failMail)throw new Error('SMTP secret must not be logged');delivered.push(m);}});
  const seller=await f.register('seller'),buyer=await f.register('buyer');
  assert.equal((await seller.patch('/api/me/preferences',{emailNotifications:true})).status,400);
  f.app.db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(seller.id);
  await seller.patch('/api/me/preferences',{emailNotifications:true});
  const id=(await seller.post('/api/listings',listing())).data.listing.id;
  const conv=(await buyer.post(`/api/listings/${id}/messages`,{text:'Hello'})).data.conversationId;
  assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM mail_jobs').get().n,1);
  failMail=true;
  await f.app.maintenance({now:Date.now()+120000});
  assert.equal(f.app.db.prepare('SELECT attempts FROM mail_jobs').get().attempts,1);
  failMail=false;
  await f.app.maintenance({now:Date.now()+400000});
  assert.equal(f.app.db.prepare('SELECT status FROM mail_jobs').get().status,'sent');
  assert.match(delivered.at(-1).text,new RegExp('#/messages/'+conv));
  f.app.db.prepare("UPDATE mail_jobs SET status='pending',due_at=0").run();
  const read=(await seller.get(`/api/conversations/${conv}`)).data.messages.map(m=>m.id);
  await seller.post(`/api/conversations/${conv}/read`,{ids:read});
  await f.app.maintenance();
  assert.equal(f.app.db.prepare('SELECT status FROM mail_jobs').get().status,'skipped');
});

test('CAPTCHA gates suspicious attempts, validates action/host, prevents token reuse and persists counters',async t=>{
  const f=await fixture(t);const fail=(status,message)=>{const e=new Error(message);e.status=status;throw e;};
  const args={db:f.app.db,fail,siteKey:'test-site',secretKey:'test-secret',hostname:'127.0.0.1',verifyCaptcha:async token=>({success:token.startsWith('valid'),hostname:'127.0.0.1',action:'submit'})};
  const attempt=(abuse,token)=>abuse.guard({req:{url:'/api/auth/register',method:'POST'},body:{captchaToken:token},ip:'127.0.0.1'});
  let abuse=createAbuse(args);
  for(let i=0;i<3;i++)await attempt(abuse);
  await assert.rejects(attempt(abuse),e=>e.status===428);
  await assert.rejects(attempt(abuse,'invalid'),e=>e.status===428);
  await attempt(abuse,'valid-1');
  abuse=createAbuse(args);
  await assert.rejects(attempt(abuse,'valid-1'),e=>e.status===428);
  await attempt(abuse,'valid-2');
  const wrong=createAbuse({...args,verifyCaptcha:async()=>({success:true,hostname:'evil.test',action:'submit'})});
  await assert.rejects(attempt(wrong,'valid-3'),e=>e.status===428);
  const disabled=createAbuse({...args,siteKey:''});
  await assert.rejects(attempt(disabled),e=>e.status===429);
});

test('backup includes referenced photos, verifies checksums, restores data and cleanup preserves drafts/chat',async t=>{
  const f=await fixture(t),seller=await f.register('seller');
  const png=await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer();
  const response=await fetch(f.base+'/api/uploads',{method:'POST',headers:{Cookie:seller.cookie},body:png});
  const {url}=await response.json();
  await seller.post('/api/listings',listing({photos:[url]}));
  const orphan='a'.repeat(32)+'.webp';fs.writeFileSync(path.join(f.dir,'uploads',orphan),png);
  f.app.db.prepare('INSERT INTO uploads(filename,user_id,created_at) VALUES (?,?,0)').run(orphan,seller.id);
  const backup=await createBackup(f.app.db,f.dir);
  const verified=await verifyBackup(backup);assert.equal(verified.files,2);
  const restored=path.join(f.dir,'restored');
  assert.equal((await restoreBackup(backup,restored)).users,1);
  await assert.rejects(restoreBackup(backup,restored),/empty/);
  assert.ok(fs.existsSync(path.join(restored,url.slice(1))));
  assert.equal(await cleanupUploads(f.app.db,f.dir),1);
  assert.ok(fs.existsSync(path.join(f.dir,url.slice(1))));
  fs.appendFileSync(path.join(backup,'ryadom.db'),'corruption');
  await assert.rejects(verifyBackup(backup),/checksum/);
});

test('operations dashboard is admin-only and health endpoint works',async t=>{
  const f=await fixture(t),user=await f.register('owner');
  assert.equal((await f.anon.get('/api/health')).data.status,'ok');
  assert.equal((await user.get('/api/admin/operations')).status,403);
  f.app.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);
  await f.app.maintenance();
  const data=(await user.get('/api/admin/operations')).data;
  assert.equal(data.state.backup.verified,true);assert.ok(data.state.maintenance.at);
});

test('SMTP adapter delivers through a local SMTP server without external recipients',async t=>{
  let message='',inData=false;
  const server=net.createServer(socket=>{
    socket.write('220 localhost test\r\n');let buffered='';
    socket.on('data',chunk=>{buffered+=chunk.toString();let index;
      while((index=buffered.indexOf('\r\n'))!==-1){const line=buffered.slice(0,index);buffered=buffered.slice(index+2);
        if(inData){if(line==='.') {inData=false;socket.write('250 queued\r\n');}else message+=line+'\n';}
        else if(/^EHLO|HELO/.test(line))socket.write('250 localhost\r\n');
        else if(/^MAIL|RCPT|RSET/.test(line))socket.write('250 OK\r\n');
        else if(line==='DATA'){inData=true;socket.write('354 Continue\r\n');}
        else if(line==='QUIT'){socket.end('221 Bye\r\n');}
      }
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const send=createMailer({production:true,smtpUrl:`smtp://127.0.0.1:${server.address().port}`,from:'sender@example.test'});
  await send({to:'receiver@example.test',subject:'Local integration test',text:'SMTP works'});
  assert.match(message,/SMTP works/);assert.match(message,/receiver@example.test/);
});
