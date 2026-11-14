/**
 * OneBot 11 协议端联调测试。
 *
 * 模拟一个 AstrBot：用 Bot 的 token 连上 WS，收私聊事件，再调 API 回消息。
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { buildServer } from '../index.js';
import { openDb } from '../db.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

// 沙箱里 %TEMP% 不可写，测试库放在项目自己的 .tools 下
const dir = join(process.cwd(), '.tools', `test-onebot-${process.pid}`);
mkdirSync(dir, { recursive: true });
const db = openDb(join(dir, 'test.db'));
const app = buildServer({ db, uploadDir: join(dir, 'uploads') });
await app.listen({ port: 0, host: '127.0.0.1' });
const port = app.server.address().port;
const base = `http://127.0.0.1:${port}`;

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

try {
  /* 1. 注册一个个人号 */
  const reg = await call('/api/register', {
    method: 'POST',
    body: { number: '111111', password: 'password123', nickname: '测试用户' },
  });
  check('注册个人号 111111', reg.status === 200, `status=${reg.status}`);
  const userToken = reg.data.token;

  /* 2. 创建 Bot */
  const bot = await call('/api/bots', {
    method: 'POST',
    token: userToken,
    body: { number: '222222', nickname: '小马' },
  });
  check('创建 Bot 222222', bot.status === 200 && !!bot.data.bot?.token, `status=${bot.status}`);
  const botToken = bot.data.bot.token;

  /* 3. 加 Bot 为好友 */
  const add = await call('/api/friends/request', {
    method: 'POST',
    token: userToken,
    body: { number: '222222' },
  });
  check(
    '建 Bot 后自动成为好友（再加提示已是好友）',
    add.status === 409 && /已经是好友/.test(add.data.error || ''),
    `status=${add.status} ${add.data.error || ''}`,
  );

  /* 4. 连上 OneBot WS */
  const ws = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws?access_token=${botToken}`);
  const inbox = [];
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
  await opened;
  check('WS 用 Bot token 连上', ws.readyState === 1);

  await new Promise((r) => setTimeout(r, 120));
  check(
    '收到 lifecycle 事件',
    inbox.some((e) => e.post_type === 'meta_event' && e.meta_event_type === 'lifecycle'),
    inbox.map((e) => e.post_type).join(',')
  );

  /* 5. 用户给 Bot 发消息 → 应收到 message 事件 */
  const send = await call('/api/messages', {
    method: 'POST',
    token: userToken,
    body: { to: '222222', body: '你好小马' },
  });
  check('用户给 Bot 发消息', send.status === 200, `status=${send.status}`);

  await new Promise((r) => setTimeout(r, 200));
  const evt = inbox.find((e) => e.post_type === 'message' && e.message_type === 'private');
  check('收到 message/private 事件', !!evt, evt ? `user_id=${evt.user_id}` : '没收到');
  check('事件里的 self_id 是 Bot 号码', evt?.self_id === 222222, String(evt?.self_id));
  check('事件里的 user_id 是发送者号码', evt?.user_id === 111111, String(evt?.user_id));
  check('事件正文正确', evt?.raw_message === '你好小马', evt?.raw_message);

  /* 6. Bot 调 API 回消息 */
  const echo = Date.now();
  ws.send(JSON.stringify({ action: 'send_private_msg', params: { user_id: 111111, message: '我在' }, echo }));
  await new Promise((r) => setTimeout(r, 250));
  const reply = inbox.find((e) => e.echo === echo);
  check('send_private_msg 返回 ok', reply?.status === 'ok', JSON.stringify(reply?.data));
  check('send_private_msg 带 message_id', typeof reply?.data?.message_id === 'number', String(reply?.data?.message_id));

  /* 7. 用户在会话里能看到 Bot 的回复 */
  const convs = await call('/api/conversations', { token: userToken });
  const conv = convs.data.conversations?.[0];
  check('会话列表里有和 Bot 的会话', !!conv, conv ? `peer=${conv.peer?.number}` : '没有');
  const msgs = await call(`/api/conversations/${conv.id}/messages`, { token: userToken });
  const bodies = (msgs.data.messages || []).map((m) => m.body);
  check('会话里能看到 Bot 的回复', bodies.includes('我在'), bodies.join(' | '));

  /* 8. 其它 API */
  const login = await new Promise((resolve) => {
    const e2 = Date.now();
    const timer = setInterval(() => {
      const found = inbox.find((e) => e.echo === e2);
      if (found) {
        clearInterval(timer);
        resolve(found);
      }
    }, 30);
    ws.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: e2 }));
    setTimeout(() => {
      clearInterval(timer);
      resolve(null);
    }, 1000);
  });
  check('get_login_info 返回 Bot 号码', login?.data?.user_id === 222222, JSON.stringify(login?.data));

  /* 9. 错误 token 连不上 */
  const bad = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws?access_token=nope`);
  const badResult = await new Promise((resolve) => {
    bad.on('open', () => resolve('opened'));
    bad.on('error', () => resolve('rejected'));
    setTimeout(() => resolve('timeout'), 1200);
  });
  check('错误 token 被拒绝', badResult === 'rejected', badResult);

  ws.close();
} finally {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\nRAN ${results.length}  PASS ${pass}  FAIL ${fail}  ERR 0`);
process.exit(fail === 0 ? 0 : 1);
