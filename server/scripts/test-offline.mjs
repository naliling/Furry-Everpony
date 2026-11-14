// 离线消息硬保证测试：
// 1) 对方下线时发的消息，她再上线必须收到（一条不少、顺序不乱）
// 2) 我发完消息就退出登录，对方上线必须能收到
// 3) 我下线期间群里别人发的消息，我上线必须能看到
// 4) 服务端重启后消息不丢（真正落盘，不是内存缓存）
// 5) 主动退出群聊后看不到群消息；被重新拉回群后历史还在（如实记录这个行为）
import { buildServer } from '../index.js';
import { openDb } from '../db.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const toolsDir = join(process.cwd(), '.tools');
mkdirSync(toolsDir, { recursive: true });
const dbFile = join(toolsDir, `fe-test-offline-${Date.now()}.db`);
const db = openDb(dbFile);
let app = buildServer({ db, uploadDir: join(toolsDir, 'uploads-offline') });
await app.listen({ port: 0, host: '127.0.0.1' });
let base = `http://127.0.0.1:${app.server.address().port}`;

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

const login = async (number, password = 'password123') => {
  const r = await call('POST', '/api/login', { body: { number, password } });
  return r.status === 200 ? r.data.token : '';
};

try {
  console.log('0. 三个号 + 好友关系');
  const a0 = await call('POST', '/api/register', { body: { number: '660001', password: 'password123', nickname: '甲' } });
  const b0 = await call('POST', '/api/register', { body: { number: '660002', password: 'password123', nickname: '乙' } });
  const c0 = await call('POST', '/api/register', { body: { number: '660003', password: 'password123', nickname: '丙' } });
  check('三个号注册成功', [a0, b0, c0].every((r) => r.status === 200 && r.data.token), JSON.stringify([a0.status, b0.status, c0.status]));
  let ta = a0.data.token;
  let tb = b0.data.token;
  let tc = c0.data.token;

  await call('POST', '/api/friends/request', { token: ta, body: { number: '660002', message: '加个好友' } });
  const bReq = await call('GET', '/api/friends/requests', { token: tb });
  const reqId = (bReq.data.incoming || [])[0]?.id;
  const acc = await call('POST', '/api/friends/accept', { token: tb, body: { requestId: reqId } });
  check('甲乙成为好友', acc.status === 200 && acc.data.status === 'accepted', `status=${acc.status}`);

  console.log('1. 甲离线时乙发的消息，甲上线必须全收到');
  const first = await call('POST', '/api/messages', { token: ta, body: { to: '660002', body: '开场白' } });
  const convId = first.data.conversationId;
  check('甲发开场白建立会话', first.status === 200 && convId > 0, JSON.stringify(first.data));

  // 甲退出登录 = 关掉应用下线
  const out = await call('POST', '/api/logout', { token: ta });
  check('甲退出登录', out.status === 200, `status=${out.status}`);
  const afterLogout = await call('GET', '/api/conversations', { token: ta });
  check('甲的旧 token 立刻失效（真的下线了）', afterLogout.status === 401, `status=${afterLogout.status}`);

  const offlineBodies = ['离线第一句', '离线第二句', '离线第三句'];
  for (const body of offlineBodies) {
    const r = await call('POST', '/api/messages', { token: tb, body: { to: '660001', body } });
    check(`乙给下线的甲发「${body}」成功`, r.status === 200 && r.data.message?.id > 0, `status=${r.status}`);
  }

  ta = await login('660001');
  check('甲重新登录拿到新 token', !!ta);
  const hist = await call('GET', `/api/conversations/${convId}/messages`, { token: ta });
  const bodies = (hist.data.messages || []).map((m) => m.body);
  const gotAll = offlineBodies.every((b) => bodies.includes(b));
  check('甲上线后三条离线消息一条不少', gotAll, JSON.stringify(bodies));
  check(
    '离线消息顺序与发送顺序一致',
    bodies.slice(bodies.indexOf('离线第一句')).join('|') === offlineBodies.join('|'),
    JSON.stringify(bodies),
  );
  check('离线消息的发送者正确显示为乙', (hist.data.messages || []).filter((m) => offlineBodies.includes(m.body)).every((m) => m.mine === false));

  console.log('2. 甲发完消息就退出，乙上线必须收到');
  const aSaid = await call('POST', '/api/messages', { token: ta, body: { to: '660002', body: '我先撤了，你上线看这条' } });
  check('甲发消息成功', aSaid.status === 200, `status=${aSaid.status}`);
  await call('POST', '/api/logout', { token: ta });
  tb = await login('660002');
  const bHist = await call('GET', `/api/conversations/${convId}/messages`, { token: tb });
  const bBodies = (bHist.data.messages || []).map((m) => m.body);
  check('乙上线后看到甲退出前发的那条', bBodies.includes('我先撤了，你上线看这条'), JSON.stringify(bBodies.slice(-4)));

  console.log('3. 甲下线期间群里的消息，甲上线必须能看到');
  const g = await call('POST', '/api/groups', { token: tb, body: { number: '660200', name: '离线测试群' } });
  const groupConv = g.data.conversationId;
  check('乙建群', g.status === 200 && groupConv > 0, JSON.stringify(g.data));
  ta = await login('660001'); // 第 2 步把甲登出了，这里重新登录才有有效 token
  check('甲重新登录（进群前）', !!ta);
  const joinA = await call('POST', '/api/groups/660200/join', { token: ta });
  const joinC = await call('POST', '/api/groups/660200/join', { token: tc });
  check('甲丙进群', joinA.status === 200 && joinC.status === 200, `${joinA.status}/${joinC.status}`);

  const groupOffline = ['甲不在时的群消息一', '甲不在时的群消息二'];
  await call('POST', '/api/logout', { token: ta });
  for (const body of groupOffline) {
    const r = await call('POST', '/api/groups/660200/messages', { token: tb, body: { body } });
    check(`乙在群里发「${body}」`, r.status === 200, `status=${r.status}`);
  }
  ta = await login('660001');
  const gHist = await call('GET', `/api/conversations/${groupConv}/messages`, { token: ta });
  const gBodies = (gHist.data.messages || []).map((m) => m.body);
  check('甲上线后看到下线期间的两条群消息', groupOffline.every((b) => gBodies.includes(b)), JSON.stringify(gBodies));
  const convList = await call('GET', '/api/conversations', { token: ta });
  const gConv = (convList.data.conversations || []).find((c) => c.id === groupConv);
  check('群会话未读数 ≥ 2（红点会亮）', !!gConv && gConv.unread >= 2, JSON.stringify(gConv && { unread: gConv.unread, last: gConv.last && gConv.last.body }));

  console.log('4. 服务端重启后消息还在（真落盘）');
  const beforeCount = (gHist.data.messages || []).length;
  await app.close();
  db.close();
  const db2 = openDb(dbFile);
  app = buildServer({ db: db2, uploadDir: join(toolsDir, 'uploads-offline') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
  const ta2 = await login('660001');
  const gHist2 = await call('GET', `/api/conversations/${groupConv}/messages`, { token: ta2 });
  const gBodies2 = (gHist2.data.messages || []).map((m) => m.body);
  check('重启服务端后历史条数不变', gBodies2.length === beforeCount, `${beforeCount} → ${gBodies2.length}`);
  check('重启服务端后离线群消息仍在', groupOffline.every((b) => gBodies2.includes(b)), JSON.stringify(gBodies2));

  console.log('5. 主动退群看不到群消息；被拉回来历史还在');
  const leave = await call('DELETE', '/api/groups/660200/leave', { token: ta2 });
  check('甲退出群聊', leave.status === 200, `status=${leave.status}`);
  const afterLeave = await call('GET', `/api/conversations/${groupConv}/messages`, { token: ta2 });
  check('退群后看不到群消息（403）', afterLeave.status === 403, `status=${afterLeave.status}`);
  const invite = await call('POST', '/api/groups/660200/invite', { token: tb, body: { number: '660001' } });
  check('乙重新邀请甲', invite.status === 200, JSON.stringify(invite.data));
  const aReqs = await call('GET', '/api/group-requests', { token: ta2 });
  const inv = (aReqs.data.incoming || []).find((r) => r.number === '660200');
  const accInv = await call('POST', `/api/group-requests/${inv?.id}/accept`, { token: ta2 });
  check('甲重新进群', accInv.status === 200, `status=${accInv.status}`);
  const rejoin = await call('GET', `/api/conversations/${groupConv}/messages`, { token: ta2 });
  const rejoinBodies = (rejoin.data.messages || []).map((m) => m.body);
  check('重新进群后历史消息还在（含退群期间的）', groupOffline.every((b) => rejoinBodies.includes(b)), JSON.stringify(rejoinBodies));
} catch (e) {
  console.log('  ERR  ' + (e && e.stack ? e.stack : e));
  ran++;
} finally {
  await app.close().catch(() => {});
  console.log(`\nRAN ${ran}  PASS ${pass}  FAIL ${failures.length}  ERR 0`);
  if (failures.length) console.log('失败用例：' + failures.join('、'));
  process.exit(failures.length ? 1 : 0);
}
