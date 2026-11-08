import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const uploadName = /^[a-f0-9]{32}\.(jpg|png|webp)$/;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function referencedUploads(db) {
  const names = new Set();
  const add = url => { if (typeof url === 'string' && url.startsWith('/uploads/') && uploadName.test(url.slice(9))) names.add(url.slice(9)); };
  for (const row of db.prepare("SELECT photos FROM listings WHERE status != 'deleted' OR EXISTS (SELECT 1 FROM conversations c WHERE c.listing_id = listings.id)").all()) JSON.parse(row.photos).forEach(add);
  for (const row of db.prepare('SELECT avatar FROM users').all()) add(row.avatar);
  for (const row of db.prepare('SELECT attachments FROM messages').all()) JSON.parse(row.attachments).forEach(add);
  for (const row of db.prepare('SELECT payload FROM drafts').all()) (JSON.parse(row.payload).photos || []).forEach(add);
  return names;
}
function child(root, name) {
  const target = path.resolve(root,name);
  if (path.dirname(target) !== path.resolve(root)) throw new Error('Invalid backup path');
  return target;
}
export async function createBackup(db, dataDir, backupRoot = path.join(dataDir,'backups'), retention = 7) {
  await fs.mkdir(backupRoot,{recursive:true});
  const name = `backup-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const target = child(backupRoot,name);
  await fs.mkdir(target);
  const snapshotFile = path.join(target,'ryadom.db');
  db.prepare('VACUUM INTO ?').run(snapshotFile);
  const snapshot = new DatabaseSync(snapshotFile,{readOnly:true});
  let names;
  try { names = referencedUploads(snapshot); } finally { snapshot.close(); }
  await fs.mkdir(path.join(target,'uploads'));
  const files = {'ryadom.db':digest(await fs.readFile(snapshotFile))};
  for (const name of names) {
    const bytes = await fs.readFile(path.join(dataDir,'uploads',name));
    await fs.writeFile(path.join(target,'uploads',name),bytes);
    files[`uploads/${name}`]=digest(bytes);
  }
  await fs.writeFile(path.join(target,'backup.json'),JSON.stringify({version:1,createdAt:Date.now(),files},null,2));
  await verifyBackup(target);
  const completed = [];
  for (const name of await fs.readdir(backupRoot)) {
    if (!/^backup-\d+-[a-f0-9]{8}$/.test(name)) continue;
    try { const stat=await fs.stat(path.join(child(backupRoot,name),'backup.json')); completed.push({name,time:stat.mtimeMs}); } catch { /* incomplete backups are retained for inspection */ }
  }
  completed.sort((a,b)=>b.time-a.time);
  for (const old of completed.slice(Math.max(1,retention))) await fs.rm(child(backupRoot,old.name),{recursive:true,force:true});
  return target;
}
export async function verifyBackup(directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory,'backup.json'),'utf8'));
  if (manifest.version !== 1 || !manifest.files?.['ryadom.db']) throw new Error('Invalid backup manifest');
  for (const [name,hash] of Object.entries(manifest.files)) {
    if (name !== 'ryadom.db' && !/^uploads\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(name)) throw new Error('Invalid backup filename');
    if (digest(await fs.readFile(path.join(directory,name))) !== hash) throw new Error(`Backup checksum mismatch: ${name}`);
  }
  const db = new DatabaseSync(path.join(directory,'ryadom.db'),{readOnly:true});
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database integrity check failed');
    for (const name of referencedUploads(db)) if (!manifest.files[`uploads/${name}`]) throw new Error('Missing referenced photo');
    return {ok:true,files:Object.keys(manifest.files).length,users:db.prepare('SELECT COUNT(*) AS n FROM users').get().n,listings:db.prepare('SELECT COUNT(*) AS n FROM listings').get().n};
  } finally { db.close(); }
}
export async function restoreBackup(directory,target) {
  const result = await verifyBackup(directory);
  const resolved = path.resolve(target);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(directory)) throw new Error('Use a new restore directory');
  await fs.mkdir(resolved,{recursive:true});
  if ((await fs.readdir(resolved)).length) throw new Error('Restore destination must be empty');
  const manifest=JSON.parse(await fs.readFile(path.join(directory,'backup.json'),'utf8'));
  await fs.mkdir(path.join(resolved,'uploads'));
  for (const name of Object.keys(manifest.files)) await fs.copyFile(path.join(directory,name),path.join(resolved,name));
  await fs.copyFile(path.join(directory,'backup.json'),path.join(resolved,'backup.json'));
  await verifyBackup(resolved);
  return result;
}
export async function cleanupUploads(db,dataDir,graceMs=86400000) {
  const referenced=referencedUploads(db),cutoff=Date.now()-graceMs;
  let removed=0;
  const dir=path.join(dataDir,'uploads');
  for (const name of await fs.readdir(dir)) {
    if (!uploadName.test(name) || referenced.has(name)) continue;
    const row=db.prepare('SELECT created_at FROM uploads WHERE filename = ?').get(name);
    const file=child(dir,name), stat=await fs.stat(file);
    if ((row?.created_at ?? stat.mtimeMs)>cutoff) continue;
    // Recheck after filesystem awaits. Remove ownership before yielding so new requests
    // cannot attach an upload selected for deletion.
    if (referencedUploads(db).has(name)) continue;
    db.prepare('DELETE FROM uploads WHERE filename = ?').run(name); removed++;
    await fs.unlink(file);
  }
  return removed;
}
