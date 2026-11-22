import {createHmac, timingSafeEqual, createHash} from 'node:crypto';
export function validateInitData(raw, token, now=Math.floor(Date.now()/1000)) {
  if (typeof raw !== 'string' || raw.length > 16384) throw new Error('Некоректна авторизація.');
  const p = new URLSearchParams(raw);
  if (new Set([...p.keys()]).size !== [...p.keys()].length) throw new Error('Повторені поля авторизації.');
  const hash=p.get('hash'); p.delete('hash');
  const secret=createHmac('sha256','WebAppData').update(token).digest();
  const expected=createHmac('sha256',secret).update([...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n')).digest();
  if (!/^[a-f0-9]{64}$/i.test(hash || '') || !timingSafeEqual(expected,Buffer.from(hash,'hex'))) throw new Error('Підпис Telegram не пройшов перевірку.');
  const timestamp=Number(p.get('auth_date'));
  if (!Number.isInteger(timestamp) || now-timestamp>3600 || timestamp>now+30) throw new Error('Сесію запуску завершено. Відкрийте застосунок заново.');
  const user=JSON.parse(p.get('user') || 'null');
  if (!user || !Number.isSafeInteger(user.id) || user.id<1) throw new Error('Немає користувача Telegram.');
  return user;
}
export const hashToken = token=>createHash('sha256').update(token).digest('hex');
