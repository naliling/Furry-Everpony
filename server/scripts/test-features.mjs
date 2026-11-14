/**
 * 0.8.0 新增功能测试：置顶、备注、拉黑、消息搜索、群资料、踢人、已读回执。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from '../index.js';
import { openDb } from '../db.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

const dir = join(process.cwd(), '.tools', `test-features-${process.pid}`);
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
  const a = await call('/api/register', {
    method: 'POST',
    body: { number: '700001', password: 'fe-test-2026', nickname: '甲' },
  });
  const b = await call('/api/register', {
    method: 'POST',
    body: { number: '700002', password: 'fe-test-2026', nickname: '乙' },
  });
  const ta = a.data.token;
  const tb = b.data.token;
  check('注册两个号', !!ta && !!tb);

  await call('/api/friends/request', { method: 'POST', token: ta, body: { number: '700002' } });
  const reqs = await call('/api/friends/requests', { token: tb });
  const reqId = reqs.data.incoming[0].id;
  await call('/api/friends/accept', { method: 'POST', token: tb, body: { requestId: reqId } });

  const send = await call('/api/messages', {
    method: 'POST',
    token: ta,
    body: { to: '700002', body: '今晚吃火锅' },
  });
  check('发消息', send.status === 200 && !!send.data.message.id, `id=${send.data.message.id}`);
  const msgId = send.data.message.id;
  const convId = send.data.conversationId;

  /* 置顶 */
  const before = await call('/api/conversations', { token: ta });
  const c0 = before.data.conversations.find((c) => c.id === convId);
  check('会话带 pinned/peerRead 字段', c0 && c0.pinned === false && typeof c0.peerRead === 'number');
  const pin = await call(`/api/conversations/${convId}/pin`, {
    method: 'POST',
    token: ta,
    body: { pinned: true },
  });
  const after = await call('/api/conversations', { token: ta });
  const c1 = after.data.conversations.find((c) => c.id === convId);
  check('置顶生效', pin.status === 200 && c1.pinned === true);

  /* 已读回执 */
  await call(`/api/conversations/${convId}/read`, { method: 'POST', token: tb });
  const afterRead = await call('/api/conversations', { token: ta });
  const c2 = afterRead.data.conversations.find((c) => c.id === convId);
  check('对方已读位置回传', c2.peerRead >= msgId, `peerRead=${c2.peerRead} msg=${msgId}`);

  /* 备注 */
  const remark = await call('/api/friends/700002', {
    method: 'PATCH',
    token: ta,
    body: { remark: '老乙' },
  });
  const friendsAfterRemark = await call('/api/friends', { token: ta });
  const remarkRow = friendsAfterRemark.data.friends.find((f) => f.number === '700002');
  check('改备注', remark.status === 200 && remarkRow?.remark === '老乙', JSON.stringify(remarkRow?.remark));

  /* 拉黑 */
  const block = await call('/api/blocks/700002', { method: 'POST', token: ta });
  const blocks = await call('/api/blocks', { token: ta });
  check('拉黑后出现在黑名单', block.status === 200 && blocks.data.blocks.some((x) => x.number === '700002'));
  const unblock = await call('/api/blocks/700002', { method: 'DELETE', token: ta });
  const blocks2 = await call('/api/blocks', { token: ta });
  check('解除拉黑', unblock.status === 200 && blocks2.data.blocks.length === 0);

  /* 消息搜索 */
  const search = await call('/api/messages/search?q=' + encodeURIComponent('火锅'), { token: ta });
  check('搜到消息', search.data.messages.length === 1, `n=${search.data.messages.length}`);
  const searchConv = await call(
    `/api/messages/search?q=${encodeURIComponent('火锅')}&conversationId=${convId}`,
    { token: ta },
  );
  check('按会话搜', searchConv.data.messages.length === 1);
  const searchOther = await call('/api/messages/search?q=' + encodeURIComponent('不存在的东西'), { token: ta });
  check('搜不到返回空', searchOther.data.messages.length === 0);

  /* 撤回 */
  const recall = await call(`/api/messages/${msgId}/recall`, { method: 'POST', token: ta });
  const msgs = await call(`/api/conversations/${convId}/messages`, { token: ta });
  const recalled = msgs.data.messages.find((m) => m.id === msgId);
  check('撤回后 recalled=true 且正文清空', recall.status === 200 && recalled.recalled === true && recalled.body === '');

  /* 群 */
  const g = await call('/api/groups', {
    method: 'POST',
    token: ta,
    body: { number: '800001', name: '测试群' },
  });
  check('建群', g.status === 200, `status=${g.status}`);
  const gname = await call('/api/groups/800001', {
    method: 'PATCH',
    token: ta,
    body: { name: '改过名的群', announcement: '今晚八点开会' },
  });
  check('群主改群名与公告', gname.status === 200);
  const denied = await call('/api/groups/800001', {
    method: 'PATCH',
    token: tb,
    body: { name: '乙来改' },
  });
  check('非群主改群资料 403', denied.status === 403, `status=${denied.status}`);

  await call('/api/groups/800001/join', { method: 'POST', token: tb });
  const m1 = await call('/api/groups/800001/members', { token: ta });
  check('乙进群后成员 2 人', m1.data.members.length === 2, `n=${m1.data.members.length}`);
  const kickDenied = await call('/api/groups/800001/kick', {
    method: 'POST',
    token: tb,
    body: { number: '700001' },
  });
  check('非管理员踢人 403', kickDenied.status === 403, `status=${kickDenied.status}`);
  const kick = await call('/api/groups/800001/kick', {
    method: 'POST',
    token: ta,
    body: { number: '700002' },
  });
  const m2 = await call('/api/groups/800001/members', { token: ta });
  check('群主踢人成功', kick.status === 200 && m2.data.members.length === 1, `n=${m2.data.members.length}`);

  /* Bot 身份切换 */
  const mkBot = await call('/api/bots', {
    method: 'POST',
    token: ta,
    body: { number: '800101', nickname: '甲的 Bot' },
  });
  check('建 Bot', mkBot.status === 200, `status=${mkBot.status}`);
  const sess = await call('/api/bots/800101/session', { method: 'POST', token: ta });
  check('主人可开 Bot 会话', sess.status === 200 && !!sess.data.token, `status=${sess.status}`);
  const meAsBot = await call('/api/me', { token: sess.data.token });
  check(
    '会话身份就是 Bot',
    meAsBot.data.account?.number === '800101' && meAsBot.data.account?.type === 'bot',
    `number=${meAsBot.data.account?.number}`,
  );
  const sess2 = await call('/api/bots/800101/session', { method: 'POST', token: tb });
  check('非主人开 Bot 会话 403', sess2.status === 403, `status=${sess2.status}`);
  const sess3 = await call('/api/bots/800101/session', { method: 'POST' });
  check('无 token 开 Bot 会话 401', sess3.status === 401, `status=${sess3.status}`);
  const sess4 = await call('/api/bots/700002/session', { method: 'POST', token: ta });
  check('对个人号开 Bot 会话 404', sess4.status === 404, `status=${sess4.status}`);

  /* 鉴权 */
  const noAuth = await call('/api/blocks');
  check('无 token 拉黑名单 401', noAuth.status === 401, `status=${noAuth.status}`);
} finally {
  await app.close();
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\nRAN ${results.length}  PASS ${pass}  FAIL ${fail}  ERR 0`);
process.exit(fail ? 1 : 0);
