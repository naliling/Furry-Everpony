import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const TMP = path.join(ROOT, '.tools/tmp-fed-routes');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const NODE = path.join(ROOT, '.tools/node-v22.23.5-win-x64/node.exe');
const JAVA = path.join(ROOT, '.tools/android/jdk-17.0.21+9/bin/java.exe');
const CP = path.join(ROOT, 'android/build-local');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ran = 0, pass = 0; const fails = [];
function check(name, cond, extra = '') { ran++; if (cond) { pass++; console.log('  PASS  ' + name); } else { fails.push(name + ' :: ' + extra); console.log('  FAIL  ' + name + ' :: ' + extra); } }
async function call(base, method, p, body, token) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
async function waitUp(base) { for (let i = 0; i < 60; i++) { await sleep(400); try { const h = await call(base, 'GET', '/api/health'); if (h.data?.version) return true; } catch {} } return false; }
const A = 'http://127.0.0.1:17895', B = 'http://127.0.0.1:17896';
const javaOut = [];
const ja = spawn(JAVA, ['-cp', CP, 'fe.local.Main', '17895', path.join(TMP, 'phone'), '2026.11.16.0.10.17'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
ja.stdout.on('data', (d) => javaOut.push(String(d))); ja.stderr.on('data', (d) => javaOut.push(String(d)));
const nb = spawn(NODE, ['server/index.js'], { cwd: ROOT, env: { ...process.env, FE_DB: path.join(TMP, 'b.db'), FE_PORT: '17896', FE_DISCOVERY: '0', FE_UPLOAD_DIR: path.join(TMP, 'b-up') }, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  check('手机端起来了', await waitUp(A));
  check('电脑端起来了', await waitUp(B));
  const ra = await call(A, 'POST', '/api/register', { number: '730001', password: 'pass1234', nickname: '手机' });
  const rb = await call(B, 'POST', '/api/register', { number: '730002', password: 'pass1234', nickname: '电脑' });
  const ta = ra.data?.token, tb = rb.data?.token;
  check('两边注册成功', !!ta && !!tb, JSON.stringify([ra.status, rb.status]));
  check('未登录拿邀请码 401', (await call(A, 'GET', '/api/federation/invite')).status === 401);
  check('未登录读 info 401', (await call(A, 'GET', '/api/federation/info')).status === 401);
  const info = await call(A, 'GET', '/api/federation/info', null, ta);
  check('手机端 info 200', info.status === 200, JSON.stringify(info.data));
  check('info 有实例 ID', /^[0-9a-f]{32}$/.test(String(info.data?.instanceId || '')), String(info.data?.instanceId));
  // 两端都上报回环地址：测试机上裸 java.exe / node.exe 的局域网端口会被防火墙拦，
  // 真实设备上不需要这一步（应用自己就在监听局域网）。
  await call(B, 'PATCH', '/api/federation/settings', { publicAddr: '127.0.0.1:17896' }, tb);
  const set = await call(A, 'PATCH', '/api/federation/settings', { publicAddr: '127.0.0.1:17895' }, ta);
  check('设置公网地址 200', set.status === 200, JSON.stringify(set.data));
  check('autoAccept 默认开', set.data?.autoAccept === true, String(set.data?.autoAccept));
  const inv = await call(A, 'GET', '/api/federation/invite', null, ta);
  check('手机端能生成邀请码 200', inv.status === 200, JSON.stringify(inv.data).slice(0, 200));
  check('邀请码格式对', String(inv.data?.code || '').startsWith('FEINV1.'), String(inv.data?.code || '').slice(0, 20));
  check('邀请码带实例 ID', /^[0-9a-f]{32}$/.test(String(inv.data?.instanceId || '')), String(inv.data?.instanceId));
  const acc = await call(B, 'POST', '/api/federation/invite/accept', { code: inv.data?.code }, tb);
  check('电脑端扫手机邀请码 200', acc.status === 200, JSON.stringify(acc.data).slice(0, 200));
  check('扫完直接成为好友', acc.data?.friend === true, JSON.stringify(acc.data).slice(0, 200));
  let both = false;
  for (let i = 0; i < 12; i++) { await sleep(800); const fa = await call(A, 'GET', '/api/friends', null, ta); const fb = await call(B, 'GET', '/api/friends', null, tb); if (JSON.stringify(fa.data || '').includes('730002') && JSON.stringify(fb.data || '').includes('730001')) { both = true; break; } }
  check('双方好友列表互相出现', both);
  const hs = await call(A, 'POST', '/api/federation/handshake', { to_number: '730001', from_number: '730002', from_nickname: '电脑', from_addr: '127.0.0.1:17896', from_instance: 'x'.repeat(32) });
  check('手机端能收别人握手（已是好友会补回执）', hs.status === 200, JSON.stringify(hs.data).slice(0, 160));
  check('补回执返回 friend', hs.data?.friend === true, JSON.stringify(hs.data).slice(0, 160));
  const bad = await call(B, 'POST', '/api/federation/invite/accept', { code: 'FEINV1.bad' }, tb);
  check('坏邀请码 400', bad.status === 400, String(bad.status));
  const self = await call(A, 'POST', '/api/federation/invite/accept', { code: inv.data?.code }, ta);
  check('自己的邀请码 400', self.status === 400, String(self.status));
  const req = await call(B, 'POST', '/api/federation/request', { addr: '127.0.0.1:17895', number: '730001' }, tb);
  check('按地址发申请 200', req.status === 200, JSON.stringify(req.data).slice(0, 160));
  const near = await call(A, 'GET', '/api/federation/nearby', null, ta);
  check('手机端 nearby 200', near.status === 200, String(near.status));
} catch (e) { console.log('EXCEPTION', e?.stack || e); fails.push('exception'); }
finally { ja.kill(); nb.kill(); }
console.log('');
console.log('RAN ' + ran + '  PASS ' + pass + '  FAIL ' + fails.length + '  ERR ' + 0);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);