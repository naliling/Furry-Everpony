import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 手机端「实例互联」双实例联调：
 * 同一台机器上起两个本地服务（不同端口、不同数据目录），
 * 走真实 HTTP 互相加好友、互发消息，验证邀请码 / 握手 / 投递 / 好友双向建立。
 */

const P = process.cwd();
const JAVA = join(P, '.tools/android/jdk-17.0.21+9/bin/java.exe');
const CP = join(P, 'android/build-local');
const VER = '2026.11.15.0.10.12';

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, extra) {
  if (ok) pass++;
  else { fail++; fails.push(name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

const procs = [];
async function boot(name, port, dataDir) {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(join(dataDir, 'web'), { recursive: true });
  writeFileSync(join(dataDir, 'web', 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>');
  const proc = spawn(JAVA, ['-cp', CP, 'fe.local.Main', String(port), dataDir, VER], { cwd: P });
  procs.push(proc);
  await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(name + ' 启动超时: ' + buf)), 30000);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  return null;
}

const dirA = join(P, '.tools/tmp-fed-a');
const dirB = join(P, '.tools/tmp-fed-b');
const PA = 17881, PB = 17882;
let A, B, apiA, apiB, tokA, tokB;

try {
  A = await boot('实例A', PA, dirA);
  B = await boot('实例B', PB, dirB);
  apiA = mkApi(A);
  apiB = mkApi(B);

  // ---- 实例地址要真实可见（用户投诉手机上看不到实例地址） ----
  const regA = await apiA('POST', '/api/register', { json: { number: '700001', password: 'password1', nickname: '甲机' } });
  const regB = await apiB('POST', '/api/register', { json: { number: '700002', password: 'password1', nickname: '乙机' } });
  check('A 注册 200', regA.status === 200, regA.data);
  check('B 注册 200', regB.status === 200, regB.data);
  tokA = regA.data.token;
  tokB = regB.data.token;

  const si = await apiA('GET', '/api/server-info', { token: tokA });
  check('server-info 200', si.status === 200, si.data);
  check('server-info 不再硬编码 127.0.0.1', si.data.host !== '127.0.0.1', si.data.host);
  check('server-info boundToLan=true', si.data.boundToLan === true, si.data.boundToLan);
  check('server-info lanUrls 非空', Array.isArray(si.data.lanUrls) && si.data.lanUrls.length > 0, si.data.lanUrls);
  check('server-info myAddresses 非空', Array.isArray(si.data.myAddresses) && si.data.myAddresses.length > 0, si.data.myAddresses);
  check('server-info instanceId 非空', !!si.data.instanceId, si.data.instanceId);
  check('lanUrls 带真实端口', (si.data.lanUrls || []).some((u) => u.endsWith(':' + PA)), si.data.lanUrls);

  // ---- 联邦接口鉴权 ----
  const noAuth = await apiA('GET', '/api/federation/info');
  check('未登录 federation/info 401', noAuth.status === 401, noAuth.status);

  const infoA = await apiA('GET', '/api/federation/info', { token: tokA });
  check('federation/info 200', infoA.status === 200, infoA.data);
  check('info 带 instanceId', !!infoA.data.instanceId, infoA.data.instanceId);
  check('info 带 myAddresses', Array.isArray(infoA.data.myAddresses), infoA.data.myAddresses);

  // ---- 对端可调接口（无需登录） ----
  const prof = await apiA('GET', '/api/federation/profile?number=700001');
  check('对端 profile 200', prof.status === 200, prof.data);
  check('对端 profile 号码正确', prof.data.account && prof.data.account.number === '700001', prof.data.account);
  const profBad = await apiA('GET', '/api/federation/profile?number=abc');
  check('profile 号码非法 400', profBad.status === 400, profBad.status);
  const dir = await apiB('GET', '/api/federation/directory');
  check('directory 200', dir.status === 200, dir.data);
  check('directory 含本实例号码', (dir.data.numbers || []).some((n) => n.number === '700002'), dir.data.numbers);
  const fedBots = await apiB('GET', '/api/federation/bots');
  check('federation/bots 200', fedBots.status === 200, fedBots.data);
  check('federation/bots 结构完整', Array.isArray(fedBots.data.bots) && !!fedBots.data.instanceId, fedBots.data);

  // 先关掉 A 的自动通过：本节测的是「人工同意」链路，自动通过在 relay-test.mjs 里单独测
  const offA = await apiA('PATCH', '/api/federation/settings', { token: tokA, json: { autoAccept: false } });
  check('关闭自动通过 200', offA.status === 200, offA.data);
  check('自动通过已关闭', offA.data && offA.data.autoAccept === false, offA.data);

  // ---- 邀请码：A 生成，B 一键接受（应自动发好友申请） ----
  const inv = await apiA('GET', '/api/federation/invite', { token: tokA });
  check('生成邀请码 200', inv.status === 200, inv.data);
  check('邀请码前缀正确', String(inv.data.code || '').startsWith('FEINV1.'), String(inv.data.code || '').slice(0, 20));
  check('邀请码带地址', Array.isArray(inv.data.addrs) && inv.data.addrs.length > 0, inv.data.addrs);

  const selfInv = await apiA('POST', '/api/federation/invite/accept', { token: tokA, json: { code: inv.data.code } });
  check('接受自己的邀请码 400', selfInv.status === 400, selfInv.data);

  const acc = await apiB('POST', '/api/federation/invite/accept', { token: tokB, json: { code: inv.data.code } });
  check('B 接受 A 的邀请码 200', acc.status === 200, acc.data);
  check('接受后拿到 A 的账号', acc.data.account && acc.data.account.number === '700001', acc.data.account);
  check('接受邀请码自动发了好友申请', acc.data.requested === true, acc.data);

  // A 侧应该收到来自 700002 的待处理申请
  const reqsA = await waitFor(async () => {
    const r = await apiA('GET', '/api/friends/requests', { token: tokA });
    const list = r.data.incoming || [];
    const hit = list.find((x) => x.number === '700002');
    return hit ? list : null;
  }, 10000);
  check('A 收到跨实例好友申请', !!reqsA, reqsA);

  // ---- A 同意：应反向通知 B 建立好友，双方都成为好友 ----
  const ok = await apiA('POST', '/api/friends/accept', { token: tokA, json: { number: '700002' } });
  check('A 同意跨实例申请 200', ok.status === 200, ok.data);
  check('同意返回 remote=true', ok.data.remote === true, ok.data);

  const friendsA = await apiA('GET', '/api/friends', { token: tokA });
  const fa = (friendsA.data.friends || []).find((f) => f.number === '700002');
  check('A 好友列表含 700002', !!fa, friendsA.data.friends);
  check('A 侧标记 remote', fa && fa.remote === true, fa);
  check('A 侧带对端地址', fa && !!fa.addr, fa && fa.addr);

  const friendsB = await waitFor(async () => {
    const r = await apiB('GET', '/api/friends', { token: tokB });
    return (r.data.friends || []).find((f) => f.number === '700001') ? r.data.friends : null;
  }, 8000);
  const fb = (friendsB || []).find((f) => f.number === '700001');
  check('B 侧也建立了好友', !!fb, friendsB);
  check('B 侧标记 remote', fb && fb.remote === true, fb);

  // ---- 消息投递：A → B ----
  const send1 = await apiA('POST', '/api/messages', { token: tokA, json: { to: '700002', kind: 'text', body: '跨实例你好' } });
  check('A 发消息 200', send1.status === 200, send1.data);

  const gotAtB = await waitFor(async () => {
    const convs = await apiB('GET', '/api/conversations', { token: tokB });
    const c = (convs.data.conversations || []).find((x) => x.peer && x.peer.number === '700001');
    if (!c) return null;
    const msgs = await apiB('GET', '/api/conversations/' + c.id + '/messages?limit=50', { token: tokB });
    const list = msgs.data.messages || [];
    return list.find((m) => m.body === '跨实例你好') ? list : null;
  }, 20000);
  check('消息真的投递到 B', !!gotAtB, gotAtB && gotAtB.map((m) => m.body));

  // ---- 消息投递：B → A（反向也要通） ----
  const send2 = await apiB('POST', '/api/messages', { token: tokB, json: { to: '700001', kind: 'text', body: '收到啦' } });
  check('B 回消息 200', send2.status === 200, send2.data);
  const gotAtA = await waitFor(async () => {
    const convs = await apiA('GET', '/api/conversations', { token: tokA });
    const c = (convs.data.conversations || []).find((x) => x.peer && x.peer.number === '700002');
    if (!c) return null;
    const msgs = await apiA('GET', '/api/conversations/' + c.id + '/messages?limit=50', { token: tokA });
    const list = msgs.data.messages || [];
    return list.find((m) => m.body === '收到啦') ? list : null;
  }, 20000);
  check('B 的消息真的投递到 A', !!gotAtA, gotAtA && gotAtA.map((m) => m.body));

  // ---- Bot 广场：别的实例连不上时不能报错 ----
  const bots = await apiB('GET', '/api/bots/public', { token: tokB });
  check('Bot 广场 200', bots.status === 200, bots.data);
  check('Bot 广场返回 bots 数组', Array.isArray(bots.data.bots), bots.data);
  check('Bot 广场带 note 提示', typeof bots.data.note === 'string', bots.data.note);

  // ---- 跨实例加好友的容错：地址不通要有明确错误，不能 500 ----
  const bad = await apiB('POST', '/api/friends/request', { token: tokB, json: { number: '700003', addr: '127.0.0.1:1' } });
  check('地址不通时返回 502', bad.status === 502, { status: bad.status, data: bad.data });
  check('地址不通有中文错误', typeof bad.data.error === 'string' && bad.data.error.length > 0, bad.data);

  // ---- 号码格式错的地址 ----
  const badAddr = await apiB('POST', '/api/friends/request', { token: tokB, json: { number: '700003', addr: '不是地址' } });
  check('地址格式不对 400', badAddr.status === 400, { status: badAddr.status, data: badAddr.data });
} catch (e) {
  fail++;
  fails.push('异常: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
} finally {
  for (const p of procs) { try { p.kill(); } catch (e) { /* 已退出 */ } }
  await sleep(500);
  try { rmSync(dirA, { recursive: true, force: true }); } catch (e) {}
  try { rmSync(dirB, { recursive: true, force: true }); } catch (e) {}
}

console.log('');
console.log('RAN ' + (pass + fail) + '  PASS ' + pass + '  FAIL ' + fail + '  ERR 0');
if (fails.length) { console.log('失败项:'); for (const f of fails) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
