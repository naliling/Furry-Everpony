import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { openDb } from '../db.js';
import { buildServer } from '../index.js';

let ran = 0;
let pass = 0;
let fail = 0;
let err = 0;

function ok(name, cond, extra = '') {
  ran += 1;
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

const dir = join(process.cwd(), '.tools', `test-link-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const db = openDb(join(dir, 't.db'));
const app = buildServer({ db, uploadDir: join(dir, 'uploads') });
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${app.server.address().port}`;

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

/** 假的 AstrBot：反向 WS 服务器，等人连进来 */
function fakeFramework() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const state = { ws: null, events: [], actions: [], waiters: [] };
  wss.on('connection', (ws, req) => {
    state.ws = ws;
    state.headers = req.headers;
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.echo !== undefined) state.actions.push(m);
      else state.events.push(m);
      state.waiters = state.waiters.filter((w) => !w(m));
    });
  });
  return new Promise((resolve) => {
    wss.on('listening', () => {
      state.port = wss.address().port;
      state.wait = (pred, ms = 4000) =>
        new Promise((res) => {
          const hit = state.events.find(pred);
          if (hit) return res(hit);
          const t = setTimeout(() => res(null), ms);
          state.waiters.push((m) => {
            if (pred(m)) {
              clearTimeout(t);
              res(m);
              return true;
            }
            return false;
          });
        });
      state.act = (action, params = {}, ms = 4000) =>
        new Promise((res) => {
          const echo = 'e' + Math.random().toString(36).slice(2, 8);
          state.ws.send(JSON.stringify({ action, params, echo }));
          const t = setInterval(() => {
            const hit = state.actions.find((a) => a.echo === echo);
            if (hit) {
              clearInterval(t);
              res(hit);
            }
          }, 30);
          setTimeout(() => {
            clearInterval(t);
            res(null);
          }, ms);
        });
      state.close = () => wss.close();
      resolve(state);
    });
  });
}

try {
  const reg = await call('/api/register', {
    method: 'POST',
    body: { number: '800001', password: 'fe-test-2026', nickname: '主人' },
  });
  ok('注册个人号', reg.status === 200 && !!reg.data.token);
  const token = reg.data.token;

  const made = await call('/api/bots', {
    method: 'POST',
    token,
    body: { number: '810001', nickname: '小马' },
  });
  ok('创建 Bot', made.status === 200 && !!made.data.bot);

  const fw = await fakeFramework();
  const url = `ws://127.0.0.1:${fw.port}/ws`;

  const noAuth = await fetch(`${base}/api/bots/810001/link`);
  ok('未登录读配置 401', noAuth.status === 401);

  const put = await call('/api/bots/810001/link', {
    method: 'PUT',
    token,
    body: { url, token: 'fw-secret', enabled: true },
  });
  ok('保存并连接', put.status === 200 && put.data.link.enabled === true);

  const life = await fw.wait((e) => e.post_type === 'meta_event' && e.meta_event_type === 'lifecycle');
  ok('握手带 X-Client-Role', fw.headers['x-client-role'] === 'Universal');
  ok('握手带 X-Self-ID', fw.headers['x-self-id'] === '810001');
  ok('握手带 Bearer 令牌', fw.headers.authorization === 'Bearer fw-secret');
  ok('框架收到 lifecycle', !!life && life.self_id === 810001);

  const login = await fw.act('get_login_info');
  ok('框架能调 get_login_info', !!login && login.status === 'ok' && login.data.user_id === 810001);

  // 主人给 Bot 发消息 → 框架应收到 message/private
  const sent = await call('/api/messages', {
    method: 'POST',
    token,
    body: { to: '810001', body: '在吗' },
  });
  ok('主人给 Bot 发消息', sent.status === 200);

  const ev = await fw.wait((e) => e.post_type === 'message' && e.message_type === 'private');
  ok('框架收到私聊事件', !!ev && ev.user_id === 800001 && ev.raw_message === '在吗');
  ok('message 是段数组', Array.isArray(ev && ev.message) && ev.message[0].type === 'text' && ev.message[0].data.text === '在吗');

  const reply = await fw.act('send_private_msg', { user_id: 800001, message: '在的' });
  ok('框架回消息成功', !!reply && reply.status === 'ok');

  const convs = await call('/api/conversations', { token });
  const conv = (convs.data.conversations || []).find((c) => c.peer && c.peer.number === '810001');
  ok('会话里能看到 Bot', !!conv);

  const msgs = await call(`/api/conversations/${conv.id}/messages`, { token });
  const bodies = (msgs.data.messages || []).map((m) => m.body);
  ok('Bot 的回话进了聊天', bodies.includes('在的'));

  const st = await call('/api/bots/810001/link', { token });
  ok('状态是已连接', st.data.link.connected === true);

  const off = await call('/api/bots/810001/link', {
    method: 'PUT',
    token,
    body: { url, token: 'fw-secret', enabled: false },
  });
  ok('断开成功', off.status === 200 && off.data.link.enabled === false);

  await new Promise((r) => setTimeout(r, 300));
  const st2 = await call('/api/bots/810001/link', { token });
  ok('断开后状态是未连接', st2.data.link.connected === false);

  fw.close();
} catch (e) {
  err += 1;
  console.log('  ! 异常：' + e.message);
} finally {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(`RAN ${ran} PASS ${pass} FAIL ${fail} ERR ${err}`);
  process.exit(fail || err ? 1 : 0);
}
