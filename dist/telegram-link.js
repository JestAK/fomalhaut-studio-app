// Shared by browser and server. Missing thread information must never be guessed.
export function parseTelegramLink(input) {
  let url;
  try { url = new URL(input.trim().replace(/^(t\.me|telegram\.me|telegram\.dog)\//i, 'https://$1/')); }
  catch { throw new Error('Вставте посилання на повідомлення в Telegram.'); }
  let chat, message, thread;
  if (url.username || url.password || url.port) throw new Error('Некоректне посилання Telegram.');
  if (url.searchParams.has('comment')) throw new Error('Це посилання на коментар каналу. Скопіюйте посилання з гілки групи.');
  if (url.protocol === 'tg:') {
    if (url.hostname === 'privatepost') chat = privateId(url.searchParams.get('channel'));
    else if (url.hostname === 'resolve') chat = publicId(url.searchParams.get('domain'));
    else throw new Error('Потрібне посилання на повідомлення, а не запрошення.');
    message = url.searchParams.get('post'); thread = url.searchParams.get('thread');
  } else {
    if (!['https:', 'http:'].includes(url.protocol) || !['t.me', 'telegram.me', 'telegram.dog'].includes(url.hostname.toLowerCase())) throw new Error('Підтримуються лише посилання Telegram.');
    const parts = url.pathname.split('/').filter(Boolean);
    const privateChat = parts[0] === 'c';
    chat = privateChat ? privateId(parts[1]) : publicId(parts[0]);
    const ids = parts.slice(privateChat ? 2 : 1);
    if (ids.length < 1 || ids.length > 2) throw new Error('Скопіюйте посилання саме на повідомлення.');
    message = ids.at(-1); thread = ids.length === 2 ? ids[0] : url.searchParams.get('thread');
    const queryThread = url.searchParams.get('thread');
    if (ids.length === 2 && queryThread && queryThread !== thread) throw new Error('Посилання містить суперечливі ID гілки.');
  }
  const messageId = positive(message);
  const threadId = thread ? positive(thread) : null;
  return {chatId:chat, messageId, threadId, needsThread:threadId === null, url:url.href};
}
function positive(value) {
  if (!/^[1-9]\d*$/.test(value || '') || !Number.isSafeInteger(Number(value))) throw new Error('Некоректний ID повідомлення або гілки.');
  return Number(value);
}
function privateId(value) { positive(value); return String(-1000000000000n-BigInt(value)); }
function publicId(value) {
  if (!/^[a-z][a-z0-9_]{3,31}$/i.test(value || '')) throw new Error('Некоректне ім’я групи.');
  return '@'+value;
}

export function parseTelegramTopicLink(input){const p=parseTelegramLink(input);return {...p,threadId:p.threadId||p.messageId,needsThread:false};}
