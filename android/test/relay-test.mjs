import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRelay } from '../../server/relay.js';

/**
 * 手机端「中继兜底」联调：
 * 起一台真实中继（server/relay.js）+ 两个安卓本地服务实例，
 * A 只拿得到 B 的实例 ID（没有对方任何可直连地址），验证申请经中继排队、
 * B 拉取后自动通过、双方建立好友、消息能互通。
 */

const P = process.cwd();
const JAVA = join(P, '.tools/android/jdk-17.0.21+9/bin/java.exe');
const CP = join(P, 'android/build-local');
const VER = '2026.11.16.0.10.16';
const PA = 17891, PB = 17892;

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, extra) {
  if (ok) pass++;
  else { fail++; fails.push(name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(400);
  }
  return null;
}

const procs = [];
async function boot(name, port, dataDir) {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(join(dataDir, 'web'), { recursive: true });
  writeFileSync(join(dataDir, 'web', 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>');
  const proc = spawn(JAVA, ['-Dfe.relay.pull.ms=400', '-cp', CP, 'fe.local.Main', String(port), dataDir, VER], { cwd: P });
  procs.push(proc);
  await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(name + ' 启动超时: ' + buf)), 40000);
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      if (/FE_LOCAL_SERVER_READY \d+/.test(buf)) { clearTimeout(timer); resolve(); }
    });
    proc.stderr.on('data', (d) => { buf += d.toString(); });
  });
  return 'http://127.0.0.1:' + port;
}

function mkApi(base) {
  return async function api(method, path, opts = {}) {
    const headers = {};
    if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
    let body;
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
    const r = await fetch(base + path, { method, headers, body });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: r.status, data };
  };
}

const relayDir = join(P, '.tools/tmp-relay-test');
rmSync(relayDir, { recursive: true, force: true });
mkdirSync(relayDir, { recursive: true });
const relayApp = buildRelay({ dbFile: join(relayDir, 'relay.db'), log: { info() {}, warn() {}, error() {} }, version: VER });
await relayApp.listen({ port: 0, host: '127.0.0.1' });
const RELAY_PORT = relayApp.server.address().port;
const RELAY = 'http://127.0.0.1:' + RELAY_PORT;

try {
  const A = await boot('实例A', PA, join(P, '.tools/tmp-relay-a'));
  const B = await boot('实例B', PB, join(P, '.tools/tmp-relay-b'));
  const apiA = mkApi(A);
  const apiB = mkApi(B);

  // ---- 中继服务本身 ----
  const rh = await fetch(RELAY + '/api/health').then((r) => r.json());
  check('中继健康', rh.ok === true && rh.role === 'relay', rh);

  const regA = await apiA('POST', '/api/register', { json: { number: '720001', password: 'password1', nickname: '甲机' } });
  const regB = await apiB('POST', '/api/register', { json: { number: '720002', password: 'password1', nickname: '乙机' } });
  check('A 注册 200', regA.status === 200, regA.data);
  check('B 注册 200', regB.status === 200, regB.data);
  const tokA = regA.data.token, tokB = regB.data.token;

  // ---- 鉴权与参数 ----
  const noAuth = await apiA('GET', '/api/relay/status');
  check('未登录 relay/status 401', noAuth.status === 401, noAuth.status);
  const noAuthSet = await apiA('PATCH', '/api/relay/settings', { json: { url: RELAY } });
  check('未登录 relay/settings 401', noAuthSet.status === 401, noAuthSet.status);
  const badUrl = await apiA('PATCH', '/api/relay/settings', { token: tokA, json: { url: '::::' } });
  check('非法中继地址 400', badUrl.status === 400, badUrl.data);

  // ---- 两台都配上中继（B 故意不带协议） ----
  const setA = await apiA('PATCH', '/api/relay/settings', { token: tokA, json: { url: RELAY } });
  check('A 配中继 200', setA.status === 200, setA.data);
  check('A 中继已启用', setA.data.enabled === true, setA.data);
  check('A 中继注册成功', setA.data.registered === true, setA.data);
  const setB = await apiB('PATCH', '/api/relay/settings', { token: tokB, json: { url: '127.0.0.1:' + RELAY_PORT } });
  check('B 配中继 200', setB.status === 200, setB.data);
  check('B 中继已启用', setB.data.enabled === true, setB.data);

  const rh2 = await fetch(RELAY + '/api/health').then((r) => r.json());
  check('中继上登记 2 个实例', rh2.instances === 2, rh2);

  const infoA = await apiA('GET', '/api/federation/info', { token: tokA });
  const infoB = await apiB('GET', '/api/federation/info', { token: tokB });
  check('info 带中继状态', !!(infoA.data.relay && infoA.data.relay.enabled), infoA.data.relay);
  check('两端实例 ID 不同', !!infoA.data.instanceId && !!infoB.data.instanceId && infoA.data.instanceId !== infoB.data.instanceId, [infoA.data.instanceId, infoB.data.instanceId]);

  // ---- 只有实例 ID，没有任何可直连地址：必须走中继 ----
  const req = await apiA('POST', '/api/federation/request', { token: tokA, json: { number: '720002', instanceId: infoB.data.instanceId } });
  check('A 发申请 200', req.status === 200, req.data);
  check('申请走中继', req.data.via === 'relay', req.data);
  check('申请已排队', req.data.queued === true, req.data);

  // B 轮询拉到握手 → 自动通过 → 反向通知 A
  const friendsB = await waitFor(async () => {
    const r = await apiB('GET', '/api/friends', { token: tokB });
    return (r.data.friends || []).find((f) => f.number === '720001') ? r.data.friends : null;
  }, 25000);
  check('B 经中继收到申请并成为好友', !!friendsB, friendsB);
  const fb = (friendsB || []).find((f) => f.number === '720001');
  check('B 侧标记 remote', fb && fb.remote === true, fb);

  const friendsA = await waitFor(async () => {
    const r = await apiA('GET', '/api/friends', { token: tokA });
    return (r.data.friends || []).find((f) => f.number === '720002') ? r.data.friends : null;
  }, 20000);
  check('A 侧也成为好友', !!friendsA, friendsA);

  const pendA = await apiA('GET', '/api/friends/requests', { token: tokA });
  check('自动通过后没有待处理申请', (pendA.data.incoming || []).length === 0, pendA.data.incoming);

  // ---- 消息互通 ----
  const send1 = await apiA('POST', '/api/messages', { token: tokA, json: { to: '720002', kind: 'text', body: '中继你好' } });
  check('A 发消息 200', send1.status === 200, send1.data);
  const gotB = await waitFor(async () => {
    const convs = await apiB('GET', '/api/conversations', { token: tokB });
    const c = (convs.data.conversations || []).find((x) => x.peer && x.peer.number === '720001');
    if (!c) return null;
    const msgs = await apiB('GET', '/api/conversations/' + c.id + '/messages?limit=50', { token: tokB });
    return (msgs.data.messages || []).find((m) => m.body === '中继你好') ? true : null;
  }, 25000);
  check('消息真的到 B', !!gotB, gotB);

  const send2 = await apiB('POST', '/api/messages', { token: tokB, json: { to: '720001', kind: 'text', body: '收到啦' } });
  check('B 回消息 200', send2.status === 200, send2.data);
  const gotA = await waitFor(async () => {
    const convs = await apiA('GET', '/api/conversations', { token: tokA });
    const c = (convs.data.conversations || []).find((x) => x.peer && x.peer.number === '720002');
    if (!c) return null;
    const msgs = await apiA('GET', '/api/conversations/' + c.id + '/messages?limit=50', { token: tokA });
    return (msgs.data.messages || []).find((m) => m.body === '收到啦') ? true : null;
  }, 25000);
  check('消息真的回 A', !!gotA, gotA);

  // ---- 状态与关闭 ----
  const st = await apiA('GET', '/api/relay/status', { token: tokA });
  check('relay/status 200', st.status === 200, st.data);
  check('relay/status enabled', st.data.enabled === true, st.data);
  check('relay/status 带实例 ID', !!st.data.instanceId, st.data);

  const offA = await apiA('PATCH', '/api/relay/settings', { token: tokA, json: { url: '' } });
  check('关掉中继 200', offA.status === 200, offA.data);
  check('关掉后 enabled=false', offA.data.enabled === false, offA.data);
} catch (e) {
  fail++;
  fails.push('异常: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
} finally {
  for (const p of procs) { try { p.kill(); } catch (e) { /* ignore */ } }
  try { await relayApp.close(); } catch (e) { /* ignore */ }
}

console.log('RAN ' + (pass + fail) + '  PASS ' + pass + '  FAIL ' + fail + '  ERR 0');
if (fail) {
  console.log('失败项:');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
