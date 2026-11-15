import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db.js';
import { buildServer } from '../index.js';

/**
 * 本机中转站（relay-host）接口测试
 *
 * 不真的起隧道（那要下载 55MB 并联网），只验证：
 *  - 接口鉴权、参数校验、开关状态
 *  - 邀请码里会带上「对外中继地址」（别人拿邀请码就能走中继加我）
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const stamp = Date.now() + '-' + Math.random().toString(16).slice(2, 8);
process.env.FE_DISCOVERY = '0';
process.env.FE_RELAY_PULL_MS = '3600000';

const db = openDb(join(HERE, '../../.tools/fe-host-' + stamp + '.db'));
const app = buildServer({ db, uploadDir: join(HERE, '../../.tools/fe-host-up-' + stamp) });
await app.listen({ port: 0, host: '127.0.0.1' });
const base = 'http://127.0.0.1:' + app.server.address().port;

let ran = 0;
let pass = 0;
const failures = [];
function check(name, cond, extra = '') {
  ran++;
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { failures.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }
  return { status: res.status, data };
}

console.log('\n== 本机中转站 ==');
const reg = await call('POST', '/api/register', { body: { number: '640001', password: 'pass1234', nickname: '中转站测试' } });
check('注册测试账号', reg.status === 200 && !!reg.data?.token, JSON.stringify(reg.data).slice(0, 120));
const token = reg.data?.token;

check('未登录读中转站状态 401', (await call('GET', '/api/relay/host')).status === 401);
check('未登录开中转站 401', (await call('POST', '/api/relay/host', { body: { enabled: true } })).status === 401);

const st = await call('GET', '/api/relay/host', { token });
check('读中转站状态 200', st.status === 200 && st.data?.ok === true, JSON.stringify(st.data).slice(0, 160));
check('默认没开', st.data?.enabled === false && st.data?.state === 'off', JSON.stringify(st.data).slice(0, 160));
check('状态里有本机中继端口', st.data?.relayPort > 0 && String(st.data?.localUrl).includes('127.0.0.1'), String(st.data?.localUrl));

check('参数不对 400', (await call('POST', '/api/relay/host', { token, body: { enabled: 'yes' } })).status === 400);
const off = await call('POST', '/api/relay/host', { token, body: { enabled: false } });
check('关掉中转站 200 且状态 off', off.status === 200 && off.data?.enabled === false && off.data?.state === 'off', JSON.stringify(off.data).slice(0, 160));

console.log('\n== 邀请码带对外中继地址 ==');
const setRelay = await call('PATCH', '/api/relay/settings', { token, body: { url: 'https://relay.example.com:7800' } });
check('配中继地址 200', setRelay.status === 200 && setRelay.data?.enabled === true, JSON.stringify(setRelay.data).slice(0, 160));
const inv = await call('GET', '/api/federation/invite', { token });
check('生成邀请码 200', inv.status === 200 && !!inv.data?.code, JSON.stringify(inv.data).slice(0, 160));
const payload = JSON.parse(Buffer.from(String(inv.data?.code || '').replace('FEINV1.', ''), 'base64url').toString('utf8'));
check('邀请码里带中继地址', payload.r === 'https://relay.example.com:7800', String(payload.r));
check('邀请码里带实例 ID', typeof payload.i === 'string' && payload.i.length === 32, String(payload.i));

await app.close();
db.close();
console.log('\nRAN ' + ran + ' PASS ' + pass + ' FAIL ' + failures.length + ' ERR 0');
if (failures.length) { for (const f of failures) console.log('  ! ' + f); process.exit(1); }
