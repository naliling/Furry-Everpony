// 实例互联（federation）测试：真的起两个实例，跨实例加好友 + 双向投递消息
import { buildServer } from '../index.js';
import { openDb } from '../db.js';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

process.env.FE_DISCOVERY = '0'; // 测试里不开 UDP 广播，避免和真机实例抢端口

const toolsDir = join(process.cwd(), '.tools');
mkdirSync(toolsDir, { recursive: true });
const stamp = Date.now();
const dbFileA = join(toolsDir, `fe-fed-a-${stamp}.db`);
const dbFileB = join(toolsDir, `fe-fed-b-${stamp}.db`);

const dbA = openDb(dbFileA);
const dbB = openDb(dbFileB);
const appA = buildServer({ db: dbA, uploadDir: join(toolsDir, 'uploads-fed-a') });
const appB = buildServer({ db: dbB, uploadDir: join(toolsDir, 'uploads-fed-b') });
await appA.listen({ port: 0, host: '127.0.0.1' });
await appB.listen({ port: 0, host: '127.0.0.1' });
const baseA = `http://127.0.0.1:${appA.server.address().port}`;
const baseB = `http://127.0.0.1:${appB.server.address().port}`;
const addrA = baseA.replace('http://', '');
const addrB = baseB.replace('http://', '');

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

function makeClient(base) {
  return async function call(method, path, { token, body, headers } = {}) {
    const h = { 'Content-Type': 'application/json', ...(headers || {}) };
    if (token) h.Authorization = `Bearer ${token}`;
    const res = await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
}
const callA = makeClient(baseA);
const callB = makeClient(baseB);

try {
  console.log('两个实例各自注册账号');
  const a = await callA('POST', '/api/register', { body: { number: '30001', password: 'password-a', nickname: '甲' } });
  const b = await callB('POST', '/api/register', { body: { number: '30002', password: 'password-b', nickname: '乙' } });
  check('A 实例注册 30001', a.status === 200 && !!a.data.token, JSON.stringify(a.data));
  check('B 实例注册 30002', b.status === 200 && !!b.data.token, JSON.stringify(b.data));
  const A = a.data.token;
  const B = b.data.token;

  console.log('未登录一律 401');
  check('info 401', (await callA('GET', '/api/federation/info')).status === 401);
  check('nearby 401', (await callA('GET', '/api/federation/nearby')).status === 401);
  check('lookup 401', (await callA('POST', '/api/federation/lookup', { body: { number: '30002' } })).status === 401);
  check('request 401', (await callA('POST', '/api/federation/request', { body: { number: '30002' } })).status === 401);
  check('settings 401', (await callA('PATCH', '/api/federation/settings', { body: { publicAddr: '' } })).status === 401);

  console.log('实例身份与地址');
  const setA = await callA('PATCH', '/api/federation/settings', { token: A, body: { publicAddr: addrA } });
  check('A 设置实例地址', setA.status === 200 && setA.data.publicAddr === addrA, JSON.stringify(setA.data));
  const setB = await callB('PATCH', '/api/federation/settings', { token: B, body: { publicAddr: 'http://' + addrB + '/' } });
  check('B 地址写法容错', setB.status === 200 && setB.data.publicAddr === addrB, JSON.stringify(setB.data));
  check('非法地址 400', (await callA('PATCH', '/api/federation/settings', { token: A, body: { publicAddr: '不是地址' } })).status === 400);

  /* 默认是自动通过，人工同意流程要先把开关关掉才测得到 */
  const autoOffA = await callA('PATCH', '/api/federation/settings', { token: A, body: { autoAccept: false } });
  check('A 能关掉自动通过', autoOffA.status === 200 && autoOffA.data.autoAccept === false, JSON.stringify(autoOffA.data));
  const autoOffB = await callB('PATCH', '/api/federation/settings', { token: B, body: { autoAccept: false } });
  check('B 能关掉自动通过', autoOffB.status === 200 && autoOffB.data.autoAccept === false, JSON.stringify(autoOffB.data));

  const infoA = await callA('GET', '/api/federation/info', { token: A });
  check('info 有 instanceId', typeof infoA.data.instanceId === 'string' && infoA.data.instanceId.length === 32);
  check('info 有端口', infoA.data.port > 0);
  check('info myAddresses 含自己地址', (infoA.data.myAddresses || []).includes(addrA), JSON.stringify(infoA.data.myAddresses));

  const infoB = await callB('GET', '/api/federation/info', { token: B });
  check('两个实例 instanceId 不同', infoA.data.instanceId !== infoB.data.instanceId);

  console.log('查找远端账号');
  const look = await callA('POST', '/api/federation/lookup', { token: A, body: { addr: addrB, number: '30002' } });
  check('查到 B 实例的 30002', look.status === 200 && look.data.account?.number === '30002', JSON.stringify(look.data));
  check('查到的是远端账号', look.data.account?.remote === true);
  check('查到带实例地址', look.data.account?.addr === addrB);
  check('还不是好友', look.data.isFriend === false);

  const lookMissing = await callA('POST', '/api/federation/lookup', { token: A, body: { addr: addrB, number: '39999' } });
  check('对方没有这个号码 404', lookMissing.status === 404 && /没有这个号码/.test(lookMissing.data.error || ''), JSON.stringify(lookMissing.data));
  const lookDown = await callA('POST', '/api/federation/lookup', { token: A, body: { addr: '127.0.0.1:1', number: '30002' } });
  check('对方实例连不上 404', lookDown.status === 404 && /连不上/.test(lookDown.data.error || ''), JSON.stringify(lookDown.data));
  const lookLocal = await callA('POST', '/api/federation/lookup', { token: A, body: { addr: '', number: '30001' } });
  check('本机号码也能查', lookLocal.status === 200 && lookLocal.data.account.remote === false);

  console.log('跨实例加好友');
  const req = await callA('POST', '/api/federation/request', { token: A, body: { addr: addrB, number: '30002', message: '我是甲' } });
  check('A 发出跨实例申请', req.status === 200 && req.data.pending === true, JSON.stringify(req.data));
  check('缺地址 400', (await callA('POST', '/api/federation/request', { token: A, body: { number: '30002' } })).status === 400);

  const bReqs = await callB('GET', '/api/friends/requests', { token: B });
  const incoming = (bReqs.data.incoming || []).find((r) => r.number === '30001');
  check('B 收到申请', !!incoming, JSON.stringify(bReqs.data.incoming));
  check('申请带附言', incoming?.message === '我是甲');

  const dup = await callA('POST', '/api/federation/request', { token: A, body: { addr: addrB, number: '30002' } });
  check('重复申请不报错', dup.status === 200);

  const accept = await callB('POST', '/api/friends/accept', { token: B, body: { requestId: incoming.id } });
  check('B 同意申请', accept.status === 200 && accept.data.status === 'accepted', JSON.stringify(accept.data));
  check('同意时标记为远端', accept.data.remote === true);

  const friendsA = await callA('GET', '/api/friends', { token: A });
  const f30002 = (friendsA.data.friends || []).find((f) => f.number === '30002');
  check('A 好友里有 30002', !!f30002, JSON.stringify(friendsA.data.friends));
  check('A 侧标记 remote', f30002?.remote === true);
  check('A 侧记下对方地址', f30002?.addr === addrB);

  const friendsB = await callB('GET', '/api/friends', { token: B });
  const f30001 = (friendsB.data.friends || []).find((f) => f.number === '30001');
  check('B 好友里有 30001', !!f30001);
  check('B 侧标记 remote', f30001?.remote === true);

  console.log('A → B 投递消息');
  const dm = await callA('POST', '/api/dm', { token: A, body: { number: '30002' } });
  check('A 能开远端会话', dm.status === 200 && dm.data.conversationId > 0, JSON.stringify(dm.data));
  const sent = await callA('POST', `/api/conversations/${dm.data.conversationId}/messages`, { token: A, body: { body: '跨实例你好' } });
  check('A 发消息本地成功', sent.status === 200 && sent.data.message?.body === '跨实例你好', JSON.stringify(sent.data));

  await appA.federation.flushOnce();
  const bConvs = await callB('GET', '/api/conversations', { token: B });
  const convFromA = (bConvs.data.conversations || []).find((c) => c.peer?.number === '30001');
  check('B 收到会话', !!convFromA, JSON.stringify(bConvs.data.conversations));
  check('B 会话未读 +1', convFromA?.unread >= 1);
  check('B 看到的摘要正确', convFromA?.last?.body === '跨实例你好', JSON.stringify(convFromA?.last));

  const bMsgs = await callB('GET', `/api/conversations/${convFromA.id}/messages`, { token: B });
  check('B 能读到消息正文', (bMsgs.data.messages || []).some((m) => m.body === '跨实例你好'));

  console.log('B → A 反向投递');
  const reply = await callB('POST', `/api/conversations/${convFromA.id}/messages`, { token: B, body: { body: '反向也能收到' } });
  check('B 回复成功', reply.status === 200);
  await appB.federation.flushOnce();
  const aConvs = await callA('GET', '/api/conversations', { token: A });
  const convToB = (aConvs.data.conversations || []).find((c) => c.peer?.number === '30002');
  check('A 收到回信', convToB?.last?.body === '反向也能收到', JSON.stringify(convToB?.last));

  console.log('内部接口的安全性');
  const dirB = await fetch(baseB + '/api/federation/directory').then((r) => r.json());
  check('目录列出 B 的用户号', Array.isArray(dirB.numbers) && dirB.numbers.some((n) => n.number === '30002'));
  check('目录不含远端镜像', !(dirB.numbers || []).some((n) => n.type === 'remote'));

  const badSecret = await callB('POST', '/api/federation/deliver', {
    headers: { 'x-fe-instance': infoA.data.instanceId, 'x-fe-secret': 'deadbeef' },
    body: { from_number: '30001', to_number: '30002', message: { kind: 'text', body: '伪造' } },
  });
  check('密钥不对 403', badSecret.status === 403, JSON.stringify(badSecret.data));

  const unknownPeer = await callB('POST', '/api/federation/deliver', {
    headers: { 'x-fe-instance': 'x', 'x-fe-secret': 'y' },
    body: { from_number: '39998', to_number: '30002', message: { kind: 'text', body: '陌生实例' } },
  });
  check('陌生实例 403', unknownPeer.status === 403);

  const hsMissing = await callB('POST', '/api/federation/handshake', {
    body: { from_instance: 'x', from_addr: addrA, from_number: '30001', to_number: '39999' },
  });
  check('握手目标号码不存在 404', hsMissing.status === 404);

  const nearby = await callA('GET', '/api/federation/nearby', { token: A });
  check('附近实例返回数组', Array.isArray(nearby.data.instances));

  const offline = await callA('POST', '/api/federation/request', { token: A, body: { addr: '127.0.0.1:1', number: '30002' } });
  check('对方离线时申请报错', offline.status === 404 || offline.status === 502);

  /* ---------- 邀请码：不同网络（甚至不同城市）加好友 ---------- */
  console.log('邀请码');
  const inviteNoAuth = await callA('GET', '/api/federation/invite');
  check('未登录取邀请码 401', inviteNoAuth.status === 401);

  const noAddr = await callA('GET', '/api/federation/invite', { token: A });
  // 没填对外地址时：有公网 IPv6 的机器照样能生成（本机就有），没有的必须给明确原因而不是空码
  if (noAddr.status === 200) {
    check('没填对外地址但有公网 IPv6 也能生成', Array.isArray(noAddr.data.addrs) && noAddr.data.addrs.length > 0);
    check('邀请码带公网 IPv6 地址', (noAddr.data.publicV6 || []).every((a) => /^\[[0-9a-f:]+\]:\d+$/i.test(a)), JSON.stringify(noAddr.data.publicV6));
  } else {
    check('没有可用地址时 409 且给原因', noAddr.status === 409 && /公网|地址/.test(noAddr.data.error || ''), JSON.stringify(noAddr.data));
    check('邀请码带公网 IPv6 地址（无 IPv6 机器跳过）', true);
  }

  await callA('PATCH', '/api/federation/settings', { token: A, body: { publicAddr: addrA } });
  const invite = await callA('GET', '/api/federation/invite', { token: A });
  check('填了对外地址后能生成邀请码', invite.status === 200 && String(invite.data.code || '').startsWith('FEINV1.'), JSON.stringify(invite.data).slice(0, 200));
  check('邀请码里带 24 小时有效期', invite.data.expiresAt > Date.now() + 23 * 3600 * 1000);
  check('邀请码地址列表含对外地址', Array.isArray(invite.data.addrs) && invite.data.addrs.includes(addrA));

  const code = invite.data.code;
  const acceptNoAuth = await callB('POST', '/api/federation/invite/accept', { body: { code } });
  check('未登录用邀请码 401', acceptNoAuth.status === 401);

  const acceptSelf = await callA('POST', '/api/federation/invite/accept', { token: A, body: { code } });
  check('用自己邀请码 400', acceptSelf.status === 400 && /自己/.test(acceptSelf.data.error || ''), JSON.stringify(acceptSelf.data));

  const acceptOk = await callB('POST', '/api/federation/invite/accept', { token: B, body: { code } });
  check('乙用邀请码查到甲', acceptOk.status === 200 && acceptOk.data.account?.number === '30001', JSON.stringify(acceptOk.data).slice(0, 300));
  check('邀请码结果带可用地址', acceptOk.data.addr === addrA);
  check('邀请码结果带好友状态字段', typeof acceptOk.data.isFriend === 'boolean' && typeof acceptOk.data.hasPending === 'boolean');

  const acceptAgain = await callB('POST', '/api/federation/invite/accept', { token: B, body: { code } });
  // 前面已经互相加过好友了，所以这里 isFriend 应该是 true、hasPending 是 false
  check('再查一次：已是好友 isFriend=true hasPending=false', acceptAgain.status === 200 && acceptAgain.data.isFriend === true && acceptAgain.data.hasPending === false, JSON.stringify(acceptAgain.data).slice(0, 200));

  const truncated = await callB('POST', '/api/federation/invite/accept', { token: B, body: { code: code.slice(0, code.length - 6) } });
  check('邀请码被截断 400', truncated.status === 400, JSON.stringify(truncated.data));

  const notInvite = await callB('POST', '/api/federation/invite/accept', { token: B, body: { code: 'hello world hello' } });
  check('不是邀请码 400', notInvite.status === 400 && /FEINV1/.test(notInvite.data.error || ''));

  const b64 = (obj) => 'FEINV1.' + Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const expired = await callB('POST', '/api/federation/invite/accept', {
    token: B,
    body: { code: b64({ v: 1, a: [addrA], n: '30001', k: '甲', e: Date.now() - 1000 }) },
  });
  check('过期邀请码 400', expired.status === 400 && /过期/.test(expired.data.error || ''));

  const badNumber = await callB('POST', '/api/federation/invite/accept', {
    token: B,
    body: { code: b64({ v: 1, a: [addrA], n: '0123', k: 'x', e: Date.now() + 60000 }) },
  });
  check('邀请码里号码非法 400', badNumber.status === 400);

  const v6code = await callB('POST', '/api/federation/invite/accept', {
    token: B,
    body: { code: b64({ v: 1, a: ['[::1]:1'], n: '30001', k: '甲', e: Date.now() + 60000 }) },
  });
  check('IPv6 地址邀请码能解析（连不上给 404 不是 400）', v6code.status === 404, JSON.stringify(v6code.data));

  const v6info = await callA('GET', '/api/federation/info', { token: A });
  check('info 带 publicV6 与 publicV6Urls 字段', Array.isArray(v6info.data.publicV6) && Array.isArray(v6info.data.publicV6Urls));

  console.log('自动通过（邀请码/二维码免同意）');
  /* 前面人工流程已经让两边成了好友，先删掉，才能测「用邀请码一步成为好友」 */
  await callA('DELETE', '/api/friends/30002', { token: A });
  await callB('DELETE', '/api/friends/30001', { token: B });
  const autoOn = await callA('PATCH', '/api/federation/settings', { token: A, body: { autoAccept: true } });
  check('A 打开自动通过', autoOn.status === 200 && autoOn.data.autoAccept === true, JSON.stringify(autoOn.data));
  const inviteA = await callA('GET', '/api/federation/invite', { token: A });
  check('自动通过时仍能生成邀请码', inviteA.status === 200 && !!inviteA.data.code, JSON.stringify(inviteA.data).slice(0, 200));
  /* B 用 A 的邀请码加 A：A 侧自动通过，两边立刻是好友，B 这次请求直接返回 friend=true */
  const viaCode = await callB('POST', '/api/federation/invite/accept', { token: B, body: { code: inviteA.data.code } });
  check('用邀请码一步加成功', viaCode.status === 200 && viaCode.data.friend === true, JSON.stringify(viaCode.data).slice(0, 300));
  const friendsB2 = await callB('GET', '/api/friends', { token: B });
  check('B 立刻在好友列表里看到 A', (friendsB2.data.friends || []).some((f) => f.number === '30001'), JSON.stringify((friendsB2.data.friends || []).map((f) => f.number)));
  const friendsA2 = await callA('GET', '/api/friends', { token: A });
  check('A 侧也立刻是好友', (friendsA2.data.friends || []).some((f) => f.number === '30002'));
  const reqsB = await callB('GET', '/api/friends/requests', { token: B });
  check('自动通过不留下待处理申请', !(reqsB.data.incoming || []).some((r) => r.number === '30001' && r.status === 'pending'));
  const selfCode = await callA('POST', '/api/federation/invite/accept', { token: A, body: { code: inviteA.data.code } });
  check('自己的邀请码 400', selfCode.status === 400);
} catch (err) {
  failures.push('异常: ' + err.message);
  console.error(err);
} finally {
  await appA.close();
  await appB.close();
  dbA.close();
  dbB.close();
  for (const file of [dbFileA, dbFileB]) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(file + suffix);
      } catch {
        /* 忽略 */
      }
    }
  }
}

console.log('');
console.log(`RAN ${ran}  PASS ${pass}  FAIL ${failures.length}  ERR ${failures.length ? 1 : 0}`);
if (failures.length) {
  console.log('失败项：' + failures.join(' | '));
  process.exit(1);
}
