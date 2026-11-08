import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

export function createMailer({ dataDir, production = false, smtpUrl = process.env.SMTP_URL, from = process.env.MAIL_FROM }) {
  if (production && (!smtpUrl || !from)) throw new Error('Для production задайте SMTP_URL и MAIL_FROM');
  const transport = smtpUrl ? nodemailer.createTransport({url:smtpUrl,connectionTimeout:10000,greetingTimeout:10000,socketTimeout:30000}) : null;
  return async ({ to, subject, text }) => {
    if (transport) return transport.sendMail({ from, to, subject, text });
    const dir = path.join(dataDir, 'mail');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${Date.now()}-${crypto.randomUUID()}.json`), JSON.stringify({ to, subject, text }, null, 2), { mode: 0o600 });
  };
}
