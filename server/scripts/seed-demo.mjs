// 造一批演示数据：4 个账号、互为好友、几段对话。只用于本地预览，不进仓库。
const base = process.env.FE_BASE || 'http://127.0.0.1:7788';
const PASSWORD = 'fe-test-2026';

async function call(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function ensureAccount(number, nickname) {
  const r = await call('POST', '/api/register', { number, password: PASSWORD, nickname });
  if (r.status === 200) return r.data.token;
  const l = await call('POST', '/api/login', { number, password: PASSWORD });
  if (l.status !== 200) throw new Error(`登录失败 ${number}: ${JSON.stringify(l.data)}`);
  return l.data.token;
}

async function befriend(tokenA, tokenB, numA, numB) {
  const list = await call('GET', '/api/friends', undefined, tokenA);
  if (list.data.friends?.some((f) => f.number === numB)) return;
  await call('POST', '/api/friends/request', { number: numB }, tokenA);
  const reqs = await call('GET', '/api/friends/requests', undefined, tokenB);
  const hit = reqs.data.incoming?.find((x) => x.number === numA);
  if (hit) await call('POST', '/api/friends/accept', { requestId: hit.id }, tokenB);
}

async function say(token, to, body) {
  await call('POST', '/api/messages', { to, body }, token);
}

const people = [
  ['3632823490', '娜莉灵'],
  ['3951331639', '茉心'],
  ['3887128092', '阿莉娜'],
  ['2625379556', '露娜'],
];

const tokens = {};
for (const [num, name] of people) {
  tokens[num] = await ensureAccount(num, name);
  console.log(`账号就绪 ${num} ${name}`);
}

await befriend(tokens['3632823490'], tokens['3951331639'], '3632823490', '3951331639');
await befriend(tokens['3632823490'], tokens['3887128092'], '3632823490', '3887128092');
await befriend(tokens['3632823490'], tokens['2625379556'], '3632823490', '2625379556');
await befriend(tokens['3951331639'], tokens['3887128092'], '3951331639', '3887128092');

const conv = await call('GET', '/api/conversations', undefined, tokens['3632823490']);
if ((conv.data.conversations?.length || 0) === 0) {
  await say(tokens['3951331639'], '3632823490', '晚上好呀，今天怎么样？');
  await say(tokens['3632823490'], '3951331639', '刚弄完一个东西，有点累');
  await say(tokens['3951331639'], '3632823490', '那早点休息吧，别熬太晚');
  await say(tokens['3951331639'], '3632823490', '明天有空的话一起看看那个界面');
  await say(tokens['3887128092'], '3632823490', '好，那就明天下午');
  await say(tokens['2625379556'], '3632823490', '我这边网有点问题，晚点回你');
}

const final = await call('GET', '/api/conversations', undefined, tokens['3632823490']);
console.log('会话数：' + final.data.conversations.length);
for (const c of final.data.conversations) {
  console.log(`  ${c.peer.nickname}(${c.peer.number}) 未读=${c.unread} 最后="${c.last?.body || ''}"`);
}
console.log('TOKEN_3632823490=' + tokens['3632823490']);
