// 端到端接口测试：起一个临时库 + 临时端口，跑完整社交流程
import { buildServer } from '../index.js';
import { openDb } from '../db.js';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const toolsDir = join(process.cwd(), '.tools');
mkdirSync(toolsDir, { recursive: true });
const dbFile = join(toolsDir, `fe-test-${Date.now()}.db`);
const db = openDb(dbFile);
const app = buildServer({ db, uploadDir: join(toolsDir, 'uploads') });
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${app.server.address().port}`;

let ran = 0;
let pass = 0;
const failures = [];

function check(name, cond, extra = '') {
  ran++;
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

try {
  console.log('注册与登录');
  const a = await call('POST', '/api/register', {
    body: { number: '10001', password: 'password-a', nickname: '甲' },
  });
  check('甲注册成功', a.status === 200 && a.data.token, JSON.stringify(a.data));
  const b = await call('POST', '/api/register', {
    body: { number: '10002', password: 'password-b', nickname: '乙' },
  });
  check('乙注册成功', b.status === 200 && b.data.token);

  const A = a.data.token;
  const B = b.data.token;

  console.log('好友流程');
  const lookup = await call('GET', '/api/users/10002', { token: A });
  check('查得到乙', lookup.status === 200 && lookup.data.account.nickname === '乙');
  check('还不是好友', lookup.data.isFriend === false);

  const noAuth = await call('GET', '/api/users/10002');
  check('未登录查人返回 401', noAuth.status === 401);

  const req = await call('POST', '/api/friends/request', {
    token: A,
    body: { number: '10002', message: '你好' },
  });
  check('甲发好友申请', req.status === 200 && req.data.status === 'pending', JSON.stringify(req.data));

  const dup = await call('POST', '/api/friends/request', {
    token: A,
    body: { number: '10002' },
  });
  check('重复申请被拒 409', dup.status === 409);

  const inbox = await call('GET', '/api/friends/requests', { token: B });
  check('乙收到 1 条申请', inbox.data.incoming.length === 1);
  const requestId = inbox.data.incoming[0]?.id;

  const accept = await call('POST', '/api/friends/accept', { token: B, body: { requestId } });
  check('乙同意申请', accept.status === 200);

  const friendsA = await call('GET', '/api/friends', { token: A });
  check('甲的好友列表有 1 人', friendsA.data.friends.length === 1 && friendsA.data.friends[0].number === '10002');

  console.log('发消息');
  const send = await call('POST', '/api/messages', { token: A, body: { to: '10002', body: '在吗' } });
  check('甲给乙发消息', send.status === 200 && send.data.conversationId > 0, JSON.stringify(send.data));
  const convId = send.data.conversationId;

  const send2 = await call('POST', '/api/messages', { token: B, body: { to: '10001', body: '在的' } });
  check('乙回消息复用同一会话', send2.data.conversationId === convId);

  const convsB = await call('GET', '/api/conversations', { token: B });
  check('乙的会话列表有 1 条', convsB.data.conversations.length === 1);
  check('会话对方是甲', convsB.data.conversations[0]?.peer?.number === '10001');
  check('乙自己发完消息未读为 0', convsB.data.conversations[0]?.unread === 0);

  const convsA = await call('GET', '/api/conversations', { token: A });
  check('甲收到乙的消息后有 1 条未读', convsA.data.conversations[0]?.unread === 1);

  const msgs = await call('GET', `/api/conversations/${convId}/messages`, { token: B });
  check('乙读到 2 条消息', msgs.data.messages.length === 2);
  check('第一条是甲发的', msgs.data.messages[0].mine === false);

  const read = await call('POST', `/api/conversations/${convId}/read`, { token: A });
  check('甲标记已读（空 body 也接受）', read.status === 200, JSON.stringify(read.data));
  const convsA2 = await call('GET', '/api/conversations', { token: A });
  check('甲未读清零', convsA2.data.conversations[0].unread === 0);

  console.log('权限与边界');
  const stranger = await call('POST', '/api/messages', { token: B, body: { to: '10003', body: 'x' } });
  check('给不存在的人发消息 404', stranger.status === 404);

  const c = await call('POST', '/api/register', {
    body: { number: '10003', password: 'password-c', nickname: '丙' },
  });
  const notFriend = await call('POST', '/api/messages', { token: c.data.token, body: { to: '10001', body: 'x' } });
  check('非好友发消息 403', notFriend.status === 403);

  const selfReq = await call('POST', '/api/friends/request', { token: A, body: { number: '10001' } });
  check('加自己 400', selfReq.status === 400);

  const badMsg = await call('POST', `/api/conversations/${convId}/messages`, { token: A, body: { body: '' } });
  check('空消息 400', badMsg.status === 400);

  const outsider = await call('GET', `/api/conversations/${convId}/messages`, { token: c.data.token });
  check('非会话成员读消息 403', outsider.status === 403);
} catch (err) {
  failures.push('异常: ' + err.message);
  console.error(err);
} finally {
  await app.close();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(dbFile + suffix);
    } catch {
      /* 忽略 */
    }
  }
}

console.log('');
console.log(`RAN ${ran}  PASS ${pass}  FAIL ${failures.length}  ERR ${failures.length ? 1 : 0}`);
if (failures.length) {
  console.log('失败项：' + failures.join(' | '));
  process.exit(1);
}
