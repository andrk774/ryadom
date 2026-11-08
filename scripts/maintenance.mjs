import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { createBackup, verifyBackup, restoreBackup, cleanupUploads } from '../server/backups.js';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.DATA_DIR || path.join(root,'data');
const [command,source,target] = process.argv.slice(2);
if (command === 'verify') {
  if (!source) throw new Error('Usage: npm run backup:verify -- backup-directory');
  console.log(await verifyBackup(path.resolve(source)));
} else if (command === 'restore') {
  if (!source || !target) throw new Error('Usage: npm run restore -- backup-directory new-empty-data-directory');
  console.log(await restoreBackup(path.resolve(source),path.resolve(target)));
} else {
  const db=openDb(path.join(dataDir,'ryadom.db'));
  try {
    if(command==='backup') console.log(await createBackup(db,dataDir,process.env.BACKUP_DIR || path.join(dataDir,'backups')));
    else if(command==='cleanup') console.log({removed:await cleanupUploads(db,dataDir)});
    else throw new Error('Unknown command');
  } finally {db.close();}
}
