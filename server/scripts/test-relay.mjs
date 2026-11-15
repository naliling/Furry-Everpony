// 中继（relay）测试：一个中继 + 两个实例，验证「直连不通也能加好友、也能发消息」
//
// 关键手法：把 FE_PORT 设成 1，两个实例上报的地址全是「127.0.0.1:1 / 局域网IP:1」这种不可达端口，
// 直连必然失败，于是只能走中继排队 —— 这正是跨网络（家用宽带没有公网地址）时的真实处境。
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

process.env.FE_DISCOVERY = '0';
process.env.FE_PORT = '1';
process.env.FE_RELAY_PULL_MS = '3600000'; // 关掉自动拉取，测试里手动 pullOnce，结果才确定

const { buildServer } = await import('../index.js');
const { openDb } = await import('../db.js');
const { buildRelay } = await import('../relay.js');

const toolsDir = join(process.cwd(), '.tools');
mkdirSync(toolsDir, { recursive: true });
const stamp = Date.now();
const files = {
  a: join(toolsDir, 'fe-relay-a-' + stamp + '.db'),
  b: join(toolsDir, 'fe-relay-b-' + stamp + '.db'),
  relay: join(toolsDir, 'fe-relay-r-' + stamp + '.db'),
};

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const relayApp = buildRelay({ dbFile: files.relay, log: quiet, version: 'test' });
const dbA = openDb(files.a);
const dbB = openDb(files.b);
const appA = buildServer({ db: dbA, uploadDir: join(toolsDir, 'uploads-relay-a'), log: quiet });
const appB = buildServer({ db: dbB, uploadDir: join(toolsDir, 'uploads-relay-b'), log: quiet });

await relayApp.listen({ port: 0, host: '127.0.0.1' });
await appA.listen({ port: 0, host: '127.0.0.1' });
await appB.listen({ port: 0, host: '127.0.0.1' });
const relayBase = 'http://127.0.0.1:' + relayApp.server.address().port;
const baseA = 'http://127.0.0.1:' + appA.server.address().port;
const baseB = 'http://127.0.0.1:' + appB.server.address().port;

let ran = 0;
let pass = 0;
const failures = [];
function check(name, cond, extra = '') {
  ran++;
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    failures.push(name);
    console.log('  FAIL  ' + name + ' ' + extra);
  }
}

function makeClient(base) {
  return async function call(method, path, { token, body, headers } = {}) {
    const h = { 'Content-Type': 'application/json', ...(headers || {}) };
    if (token) h.Authorization = 'Bearer ' + token;
    const res = await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
}
const callA = makeClient(baseA);
const callB = makeClient(baseB);
const callRelay = makeClient(relayBase);

try {
  console.log('中继自身');
  const health = await callRelay('GET', '/api/health');
  check('中继健康检查', health.status === 200 && health.data.ok === true && health.data.role === 'relay', JSON.stringify(health.data));
  const relayStatus = await callRelay('GET', '/api/relay/status');
  check('中继状态接口', relayStatus.status === 200 && relayStatus.data.ok === true, JSON.stringify(relayStatus.data));
  const badReg = await callRelay('POST', '/api/relay/register', { body: { instanceId: '不是十六进制', secret: 'x'.repeat(20) } });
  check('中继拒绝非法实例 ID', badReg.status === 400, JSON.stringify(badReg.data));
  const shortSecret = await callRelay('POST', '/api/relay/register', { body: { instanceId: 'a'.repeat(32), secret: 'short' } });
  check('中继拒绝太短的密钥', shortSecret.status === 400, JSON.stringify(shortSecret.data));
  const sendUnknown = await callRelay('POST', '/api/relay/send', {
    body: { from: 'a'.repeat(32), secret: 'x'.repeat(20), to: 'b'.repeat(32), kind: 'handshake', payload: {} },
  });
  check('发往未登记实例被拒', sendUnknown.status === 404 || sendUnknown.status === 403, JSON.stringify(sendUnknown.data));

  console.log('两个实例注册账号');
  const a = await callA('POST', '/api/register', { body: { number: '31001', password: 'password-a', nickname: '甲' } });
  const b = await callB('POST', '/api/register', { body: { number: '31002', password: 'password-b', nickname: '乙' } });
  check('A 注册 31001', a.status === 200 && !!a.data.token, JSON.stringify(a.data));
  check('B 注册 31002', b.status === 200 && !!b.data.token, JSON.stringify(b.data));
  const A = a.data.token;
  const B = b.data.token;

  /* 默认是自动通过，人工同意流程要先把开关关掉才测得到 */
  const autoOffA = await callA('PATCH', '/api/federation/settings', { token: A, body: { autoAccept: false } });
  check('A 能关掉自动通过', autoOffA.status === 200 && autoOffA.data.autoAccept === false, JSON.stringify(autoOffA.data));
  const autoOffB = await callB('PATCH', '/api/federation/settings', { token: B, body: { autoAccept: false } });
  check('B 能关掉自动通过', autoOffB.status === 200 && autoOffB.data.autoAccept === false, JSON.stringify(autoOffB.data));

  console.log('中继相关接口鉴权');
  check('relay/status 401', (await callA('GET', '/api/relay/status')).status === 401);
  check('relay/settings 401', (await callA('PATCH', '/api/relay/settings', { body: { url: relayBase } })).status === 401);

  console.log('配置中继');
  const badUrl = await callA('PATCH', '/api/relay/settings', { token: A, body: { url: 'http://' } });
  check('非法中继地址 400', badUrl.status === 400, JSON.stringify(badUrl.data));
  const setRelayA = await callA('PATCH', '/api/relay/settings', { token: A, body: { url: relayBase } });
  check('A 配好中继并登记成功', setRelayA.status === 200 && setRelayA.data.enabled === true && setRelayA.data.registered === true && setRelayA.data.registerError === '', JSON.stringify(setRelayA.data));
  const setRelayB = await callB('PATCH', '/api/relay/settings', { token: B, body: { url: relayBase.replace('http://', '') } });
  check('B 不带协议也能配中继', setRelayB.status === 200 && setRelayB.data.enabled === true && setRelayB.data.url === relayBase, JSON.stringify(setRelayB.data));

  const infoA = await callA('GET', '/api/federation/info', { token: A });
  const infoB = await callB('GET', '/api/federation/info', { token: B });
  check('info 里带中继状态', infoA.data.relay && infoA.data.relay.enabled === true, JSON.stringify(infoA.data.relay));
  check('中继登记的实例 ID 与实例自身一致', setRelayA.data.instanceId === infoA.data.instanceId, setRelayA.data.instanceId + ' vs ' + infoA.data.instanceId);
  const relayStatus2 = await callRelay('GET', '/api/relay/status');
  check('中继上登记了 2 个实例', relayStatus2.data.instances === 2, JSON.stringify(relayStatus2.data));

  console.log('直连不可达 → 好友申请排队到中继');
  const directDown = await callB('POST', '/api/federation/lookup', { token: B, body: { addr: '127.0.0.1:1', number: '31001' } });
  check('直连确实不通（前提成立）', directDown.status !== 200, JSON.stringify(directDown.data));
  const req = await callB('POST', '/api/federation/request', {
    token: B,
    body: { addr: '127.0.0.1:1', number: '31001', instanceId: infoA.data.instanceId, message: '跨网络加你' },
  });
  check('加好友走中继排队', req.status === 200 && req.data.ok === true && req.data.via === 'relay' && req.data.queued === true, JSON.stringify(req.data));

  const queued = await callRelay('GET', '/api/relay/status');
  check('中继队列里有 1 条', queued.data.queued === 1, JSON.stringify(queued.data));

  console.log('A 上线拉取 → 看到好友申请');
  const pullA = await appA.relay.pullOnce();
  check('A 拉到 1 条离线事件', pullA.ok === true && pullA.events === 1, JSON.stringify(pullA));
  const aReqs = await callA('GET', '/api/friends/requests', { token: A });
  const incoming = (aReqs.data.incoming || []).filter((x) => x.number === '31002');
  check('A 看到乙的好友申请', incoming.length === 1, JSON.stringify(aReqs.data));
  const ackAfter = await callRelay('GET', '/api/relay/status');
  check('拉取后中继队列清空', ackAfter.data.queued === 0, JSON.stringify(ackAfter.data));

  console.log('A 同意 → 回执排队到中继');
  const accept = await callA('POST', '/api/friends/accept', { token: A, body: { requestId: incoming[0].id } });
  check('同意不再报「对方实例没连上」', accept.status === 200 && accept.data.ok === true, JSON.stringify(accept.data));
  const friendsA = await callA('GET', '/api/friends', { token: A });
  check('A 好友列表里有 31002', (friendsA.data.friends || []).some((f) => f.number === '31002'), JSON.stringify(friendsA.data));
  const queued2 = await callRelay('GET', '/api/relay/status');
  check('中继队列里有回执 1 条', queued2.data.queued === 1, JSON.stringify(queued2.data));

  console.log('B 上线拉取 → 双向成为好友');
  const pullB = await appB.relay.pullOnce();
  check('B 拉到 1 条离线事件', pullB.ok === true && pullB.events === 1, JSON.stringify(pullB));
  const friendsB = await callB('GET', '/api/friends', { token: B });
  check('B 好友列表里有 31001', (friendsB.data.friends || []).some((f) => f.number === '31001'), JSON.stringify(friendsB.data));

  console.log('离线消息也走中继');
  const dm = await callB('POST', '/api/dm', { token: B, body: { number: '31001' } });
  check('B 能和远端好友建会话', dm.status === 200 && !!dm.data.conversationId, JSON.stringify(dm.data));
  const convId = dm.data.conversationId;
  const sent = await callB('POST', '/api/conversations/' + convId + '/messages', { token: B, body: { body: '直连不通也能收到' } });
  check('B 发出消息', sent.status === 200, JSON.stringify(sent.data));
  await appB.federation.flushOnce();
  const queued3 = await callRelay('GET', '/api/relay/status');
  check('消息排进中继队列', queued3.data.queued >= 1, JSON.stringify(queued3.data));
  const outboxB = await appB.federation.info(false);
  check('B 本地投递队列已清空', (outboxB.outbox ?? 0) === 0, JSON.stringify(outboxB));

  const pullA2 = await appA.relay.pullOnce();
  check('A 拉到消息事件', pullA2.ok === true && pullA2.events >= 1, JSON.stringify(pullA2));
  const aMsgs = await callA('GET', '/api/conversations/' + convId + '/messages', { token: A });
  const got = (aMsgs.data.messages || []).some((m) => m.body === '直连不通也能收到');
  check('A 收到这条消息', got, JSON.stringify(aMsgs.data).slice(0, 400));

  console.log('关掉中继就退回纯直连');
  const off = await callA('PATCH', '/api/relay/settings', { token: A, body: { url: '' } });
  check('能关掉中继', off.status === 200 && off.data.enabled === false, JSON.stringify(off.data));
  const offB = await callB('PATCH', '/api/relay/settings', { token: B, body: { url: '' } });
  check('B 也能关掉中继', offB.status === 200 && offB.data.enabled === false, JSON.stringify(offB.data));
  const noRelay = await callB('POST', '/api/federation/request', {
    token: B,
    body: { addr: '127.0.0.1:1', number: '31001', instanceId: infoA.data.instanceId },
  });
  check('没中继时直连失败照常报错', noRelay.status >= 400 && /连不上|没连上/.test(String(noRelay.data.error || '')), JSON.stringify(noRelay.data));
} catch (err) {
  console.error('  ERR   ' + (err && err.stack ? err.stack : err));
  failures.push('异常：' + (err && err.message ? err.message : err));
  ran++;
} finally {
  try {
    await appA.close();
  } catch {}
  try {
    await appB.close();
  } catch {}
  try {
    await relayApp.close();
  } catch {}
  try {
    dbA.close();
  } catch {}
  try {
    dbB.close();
  } catch {}
  for (const f of Object.values(files)) {
    try {
      rmSync(f, { force: true });
      rmSync(f + '-wal', { force: true });
      rmSync(f + '-shm', { force: true });
    } catch {}
  }
  const fail = failures.length;
  console.log('');
  console.log('RAN ' + ran + ' PASS ' + pass + ' FAIL ' + fail + ' ERR ' + fail);
  process.exitCode = fail ? 1 : 0;
}
