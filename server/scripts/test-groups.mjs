/**
 * 群聊 + Bot 广场 + 发言排行 联调测试。
 *
 * 两个用户、两个 Bot（一个公开一个不公开）、一个群，走完整链路。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { buildServer } from '../index.js';
import { openDb } from '../db.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

const dir = join(process.cwd(), '.tools', `test-groups-${process.pid}`);
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

function waitEvent(ws, match, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('等事件超时'));
    }, timeout);
    function onMsg(raw) {
      const ev = JSON.parse(raw.toString());
      if (match(ev)) {
        clearTimeout(t);
        ws.off('message', onMsg);
        resolve(ev);
      }
    }
    ws.on('message', onMsg);
  });
}

function waitReply(ws, echo, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等回应超时')), timeout);
    function onMsg(raw) {
      const ev = JSON.parse(raw.toString());
      if (ev.echo === echo) {
        clearTimeout(t);
        ws.off('message', onMsg);
        resolve(ev);
      }
    }
    ws.on('message', onMsg);
  });
}

try {
  /* 1. 两个个人号 */
  const a = await call('/api/register', {
    method: 'POST',
    body: { number: '100001', password: 'password123', nickname: '甲' },
  });
  const b = await call('/api/register', {
    method: 'POST',
    body: { number: '100002', password: 'password123', nickname: '乙' },
  });
  check('注册甲 100001', a.status === 200, `status=${a.status}`);
  check('注册乙 100002', b.status === 200, `status=${b.status}`);
  const ta = a.data.token;
  const tb = b.data.token;

  /* 2. 甲建两个 Bot，一个公开一个不公开 */
  const bot1 = await call('/api/bots', {
    method: 'POST',
    token: ta,
    body: { number: '200001', nickname: '小马', bio: '会说话的小马', public: true },
  });
  const bot2 = await call('/api/bots', {
    method: 'POST',
    token: ta,
    body: { number: '200002', nickname: '影子', public: false },
  });
  check('建公开 Bot 200001', bot1.status === 200 && bot1.data.bot.public === true, `status=${bot1.status}`);
  check('建私有 Bot 200002', bot2.status === 200 && bot2.data.bot.public === false, `status=${bot2.status}`);
  const botToken = bot1.data.bot.token;

  /* 3. Bot 广场 */
  const plaza1 = await call('/api/bots/public', { token: tb });
  check(
    '广场里能看到公开 Bot',
    plaza1.status === 200 && plaza1.data.bots.some((x) => x.number === '200001'),
    `total=${plaza1.data.total}`,
  );
  check(
    '广场里看不到私有 Bot',
    !plaza1.data.bots.some((x) => x.number === '200002'),
  );

  /* 广场会把已知远端实例的公开 Bot 一起合并进来（跨实例），所以断言一律只看本机项（!remote） */
  const plazaSearch = await call('/api/bots/public?q=小马', { token: tb });
  const searchLocal = plazaSearch.data.bots.filter((x) => !x.remote);
  check(
    '按名字搜到 Bot',
    searchLocal.length === 1 && searchLocal[0].number === '200001',
    `hits=${searchLocal.length}`,
  );

  const plazaMiss = await call('/api/bots/public?q=不存在', { token: tb });
  check(
    '搜不到时返回空',
    plazaMiss.data.bots.filter((x) => !x.remote).length === 0,
    `local=${plazaMiss.data.bots.filter((x) => !x.remote).length}`,
  );

  /* 4. 私有改公开 */
  const patched = await call('/api/bots/200002', {
    method: 'PATCH',
    token: ta,
    body: { public: true },
  });
  const plaza2 = await call('/api/bots/public', { token: tb });
  const local2 = plaza2.data.bots.filter((x) => !x.remote);
  check(
    'PATCH 改成公开后出现',
    patched.status === 200 && local2.length === 2,
    `status=${patched.status} body=${JSON.stringify(patched.data)} local=${local2.length}`,
  );

  const patchOthers = await call('/api/bots/200001', {
    method: 'PATCH',
    token: tb,
    body: { public: false },
  });
  check('别人改不了我的 Bot 404', patchOthers.status === 404, `status=${patchOthers.status}`);

  /* 5. 乙从广场加 Bot 为好友 */
  const add = await call('/api/friends/request', {
    method: 'POST',
    token: tb,
    body: { number: '200001' },
  });
  check(
    '加 Bot 要主人审批',
    add.data.status === 'pending' && add.data.pendingApproval === true,
    `status=${add.data.status}`,
  );

  const botInbox = await call('/api/friends/requests', { token: ta });
  const botReq = (botInbox.data.botIncoming || []).find((x) => x.from?.number === '100002');
  check('Bot 主人收到加好友申请', !!botReq, JSON.stringify(botInbox.data.botIncoming || []));

  const ownerAccept = await call('/api/friends/accept', {
    method: 'POST',
    token: ta,
    body: { number: '100002', bot: '200001' },
  });
  check(
    'Bot 主人同意后成为好友',
    ownerAccept.status === 200 && ownerAccept.data.status === 'accepted',
    `status=${ownerAccept.status}`,
  );

  const plaza3 = await call('/api/bots/public', { token: tb });
  const mine = plaza3.data.bots.find((x) => x.number === '200001');
  check('广场里标出已加好友', mine?.isFriend === true, `isFriend=${mine?.isFriend}`);

  /* 6. 建群 + 进群 + Bot 入群 */
  const g = await call('/api/groups', {
    method: 'POST',
    token: ta,
    body: { number: '300001', name: '小马群' },
  });
  check('建群 300001', g.status === 200, `status=${g.status}`);
  const groupConvId = g.data.conversationId;

  const dup = await call('/api/groups', {
    method: 'POST',
    token: tb,
    body: { number: '300001', name: '重复' },
  });
  check('重复群号 409', dup.status === 409, `status=${dup.status}`);

  const join = await call('/api/groups/300001/join', { method: 'POST', token: tb });
  check('乙进群', join.status === 200, `status=${join.status}`);

  const inviteBot = await call('/api/groups/300001/invite', {
    method: 'POST',
    token: ta,
    body: { number: '200001' },
  });
  check(
    '拉 Bot 进群要主人同意',
    inviteBot.status === 200 && inviteBot.data.pending === true,
    `status=${inviteBot.status}`,
  );

  const groupInbox = await call('/api/group-requests', { token: ta });
  const groupInv = (groupInbox.data.incoming || []).find(
    (x) => x.to_number === '200001' && x.number === '300001',
  );
  check('Bot 主人收到入群邀请', !!groupInv, JSON.stringify(groupInbox.data.incoming || []));

  const invAccept = await call(`/api/group-requests/${groupInv?.id}/accept`, {
    method: 'POST',
    token: ta,
  });
  check('同意后 Bot 进群', invAccept.status === 200, `status=${invAccept.status}`);

  const members = await call('/api/groups/300001/members', { token: tb });
  check('群成员 3 个', members.data.members.length === 3, `n=${members.data.members.length}`);

  const notMember = await call('/api/groups/300001/messages', {
    method: 'POST',
    token: (await call('/api/register', {
      method: 'POST',
      body: { number: '100003', password: 'password123', nickname: '丙' },
    })).data.token,
    body: { body: '我不在群里' },
  });
  check('不在群里发言 403', notMember.status === 403, `status=${notMember.status}`);

  /* 7. Bot 连 WS，乙在群里说话 → Bot 收到群事件 */
  const ws = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws?access_token=${botToken}`);
  globalThis.__ws = ws;
  // 先挂监听再等 open，避免漏掉握手后立刻推送的 lifecycle
  const lifeP = waitEvent(ws, (e) => e.post_type === 'meta_event' && e.meta_event_type === 'lifecycle');
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  await lifeP;

  const groupEvent = waitEvent(ws, (e) => e.post_type === 'message' && e.message_type === 'group');
  const sent = await call('/api/groups/300001/messages', {
    method: 'POST',
    token: tb,
    body: { body: '小马你好' },
  });
  check('乙在群里发消息', sent.status === 200, `status=${sent.status}`);

  const ev = await groupEvent;
  check('Bot 收到群消息事件', ev.message_type === 'group' && ev.group_id === 300001, `group_id=${ev.group_id}`);
  check('群事件 sender 是乙', ev.user_id === 100002 && ev.sender.nickname === '乙');
  check('群事件正文正确', ev.raw_message === '小马你好' && Array.isArray(ev.message));
  check('群事件 anonymous 为 null', ev.anonymous === null);

  const glist = waitReply(ws, 'gl1');
  ws.send(JSON.stringify({ action: 'get_group_list', params: {}, echo: 'gl1' }));
  const gl = await glist;
  check(
    'get_group_list 里有这个群',
    gl.status === 'ok' && gl.data.some((x) => x.group_id === 300001),
    JSON.stringify(gl.data),
  );

  const sg = waitReply(ws, 'sg1');
  ws.send(
    JSON.stringify({
      action: 'send_group_msg',
      params: { group_id: 300001, message: '我在群里' },
      echo: 'sg1',
    }),
  );
  const sgr = await sg;
  check('send_group_msg 成功', sgr.status === 'ok' && sgr.data.message_id > 0, JSON.stringify(sgr.data));

  const conv = await call(`/api/conversations/${groupConvId}/messages`, { token: tb });
  const bodies = conv.data.messages.map((m) => m.body);
  check('群里能看到 Bot 的回复', bodies.includes('我在群里'), bodies.join(' | '));
  const botMsg = conv.data.messages.find((m) => m.body === '我在群里');
  check('群消息带发送者信息', botMsg?.sender?.number === '200001', JSON.stringify(botMsg?.sender));

  /* 8. 发言排行 */
  const dm1 = await call('/api/messages', { method: 'POST', token: tb, body: { to: '200001', body: '第一句' } });
  const dm2 = await call('/api/messages', { method: 'POST', token: tb, body: { to: '200001', body: '第二句' } });
  check('私聊发两句', dm1.status === 200 && dm2.status === 200, `${dm1.status}/${dm2.status}`);
  const stats = await call('/api/bots/200001/stats', { token: ta });
  const top = stats.data.ranking?.[0];
  check('排行第一是乙', top?.number === '100002', JSON.stringify(top));
  check('乙发了 2 句', top?.total === 2, `total=${top?.total}`);
  check('总数为 2', stats.data.total === 2, `total=${stats.data.total}`);

  const statsOther = await call('/api/bots/200001/stats', { token: tb });
  check('别人看不到我的 Bot 排行 404', statsOther.status === 404, `status=${statsOther.status}`);

  ws.close();
} catch (e) {
  check('测试过程未抛异常', false, e.message);
} finally {
  try {
    globalThis.__ws?.close();
  } catch {
    /* 忽略 */
  }
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\nRAN ${results.length}  PASS ${pass}  FAIL ${fail}  ERR 0`);
  await app.close();
  process.exit(fail === 0 ? 0 : 1);
}
