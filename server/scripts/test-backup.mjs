// 账号搬迁测试：导出加密包 → 在另一个实例导入 → 资料/好友/消息/群/收藏/Bot 全部回来
import { buildServer } from '../index.js';
import { openDb } from '../db.js';
import { openPackage } from '../backup.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const toolsDir = join(process.cwd(), '.tools');
mkdirSync(toolsDir, { recursive: true });
mkdirSync(join(toolsDir, 'uploads-backup'), { recursive: true });

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

function mkApp(tag) {
  const db = openDb(join(toolsDir, 'fe-test-backup-' + tag + '-' + Date.now() + '.db'));
  const app = buildServer({ db, uploadDir: join(toolsDir, 'uploads-backup') });
  return { db, app };
}

const A = mkApp('a');
await A.app.listen({ port: 0, host: '127.0.0.1' });
const baseA = 'http://127.0.0.1:' + A.app.server.address().port;

const B = mkApp('b');
await B.app.listen({ port: 0, host: '127.0.0.1' });
const baseB = 'http://127.0.0.1:' + B.app.server.address().port;

async function call(base, method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const PWD = 'fe-test-pass-2026';

try {
  /* ---------- 在 A 实例造数据 ---------- */
  const reg = await call(baseA, 'POST', '/api/register', { body: { number: '771001', password: PWD, nickname: '搬家甲' } });
  check('A 注册成功', reg.status === 200 && !!reg.data.token, reg.status);
  const tokenA = reg.data.token;

  const reg2 = await call(baseA, 'POST', '/api/register', { body: { number: '771002', password: PWD, nickname: '搬家乙' } });
  const tokenB2 = reg2.data.token;
  await call(baseA, 'POST', '/api/friends/request', { token: tokenA, body: { number: '771002', message: '加一下' } });
  const reqs = await call(baseA, 'GET', '/api/friends/requests', { token: tokenB2 });
  const reqId = (reqs.data.incoming || [])[0]?.id;
  await call(baseA, 'POST', '/api/friends/accept', { token: tokenB2, body: { requestId: reqId } });

  const dm = await call(baseA, 'POST', '/api/dm', { token: tokenA, body: { number: '771002' } });
  const convId = dm.data.conversationId;
  await call(baseA, 'POST', '/api/conversations/' + convId + '/messages', { token: tokenA, body: { body: '这条消息要跟着账号搬家' } });
  const sent = await call(baseA, 'POST', '/api/conversations/' + convId + '/messages', { token: tokenA, body: { body: '第二条' } });
  await call(baseA, 'POST', '/api/messages/' + sent.data.message.id + '/favorite', { token: tokenA });

  const grp = await call(baseA, 'POST', '/api/groups', { token: tokenA, body: { number: '771200', name: '搬家群' } });
  const groupConv = grp.data.conversationId;
  await call(baseA, 'POST', '/api/conversations/' + groupConv + '/messages', { token: tokenA, body: { body: '群里也有一条' } });

  const bot = await call(baseA, 'POST', '/api/bots', { token: tokenA, body: { number: '771300', nickname: '搬家 Bot' } });
  check('A 建 Bot 成功', bot.status === 200 || bot.status === 201, bot.status + ' ' + JSON.stringify(bot.data).slice(0, 120));

  /* ---------- 导出 ---------- */
  const noAuth = await call(baseA, 'POST', '/api/account/export', { body: { password: PWD } });
  check('导出未登录 401', noAuth.status === 401, noAuth.status);
  const noPwd = await call(baseA, 'POST', '/api/account/export', { token: tokenA, body: {} });
  check('导出不填密码 400', noPwd.status === 400, noPwd.status);
  const badPwd = await call(baseA, 'POST', '/api/account/export', { token: tokenA, body: { password: 'wrong-pass-123' } });
  check('导出密码错 403', badPwd.status === 403, badPwd.status);

  const exported = await call(baseA, 'POST', '/api/account/export', { token: tokenA, body: { password: PWD } });
  check('导出成功', exported.status === 200 && exported.data.ok === true, exported.status);
  check('导出文件名带号码和 .feacct', /^furry-everpony-771001-\d{8}\.feacct$/.test(String(exported.data.filename)), exported.data.filename);
  check('导出包格式标记正确', exported.data.package?.format === 'fe-account-backup', exported.data.package?.format);
  check('导出包有大小且大于 1KB', Number(exported.data.size) > 1024, exported.data.size);
  const rawJson = JSON.stringify(exported.data.package);
  check('导出包是密文（搜不到明文消息）', !rawJson.includes('这条消息要跟着账号搬家'), '明文泄漏');
  check('导出包是密文（搜不到号码 771002 之外的资料）', !rawJson.includes('搬家乙'), '昵称明文泄漏');

  const payload = openPackage(exported.data.package, PWD);
  const accountsInPkg = payload.tables.accounts || [];
  const meRow = accountsInPkg.find((a) => a.number === '771001');
  const otherRow = accountsInPkg.find((a) => a.number === '771002');
  check('包里有自己的账号行', !!meRow);
  check('自己的密码哈希被带上了（换设备还能用原密码登录）', !!meRow?.password_hash, String(meRow?.password_hash).slice(0, 12));
  check('别人的密码哈希被清空', !!otherRow && otherRow.password_hash === null, String(otherRow?.password_hash));
  check('包里有好友关系', (payload.tables.friendships || []).length >= 2, (payload.tables.friendships || []).length);
  check('包里有消息', (payload.tables.messages || []).length >= 3, (payload.tables.messages || []).length);
  check('包里有群', (payload.tables.groups || []).length >= 1, (payload.tables.groups || []).length);
  check('包里有收藏', (payload.tables.favorites || []).length >= 1, (payload.tables.favorites || []).length);

  /* ---------- 导入到 B 实例 ---------- */
  const badImport = await call(baseB, 'POST', '/api/account/import', { body: { password: 'wrong-pass-123', package: exported.data.package } });
  check('导入密码错 400', badImport.status === 400 && /密码不对/.test(badImport.data.error || ''), badImport.status + ' ' + badImport.data.error);
  const junk = await call(baseB, 'POST', '/api/account/import', { body: { password: PWD, package: { format: 'nope' } } });
  check('导入非法包 400', junk.status === 400, junk.status + ' ' + junk.data.error);

  const imported = await call(baseB, 'POST', '/api/account/import', { body: { password: PWD, package: exported.data.package } });
  check('导入成功', imported.status === 200 && !!imported.data.token, imported.status + ' ' + JSON.stringify(imported.data).slice(0, 160));
  check('导入后号码一致', imported.data.account?.number === '771001', imported.data.account?.number);
  check('导入后昵称一致', imported.data.account?.nickname === '搬家甲', imported.data.account?.nickname);
  check('导入统计里有好友', Number(imported.data.counts?.friends) >= 1, JSON.stringify(imported.data.counts));
  check('导入统计里有消息', Number(imported.data.counts?.messages) >= 3, JSON.stringify(imported.data.counts));
  check('导入统计里有群', Number(imported.data.counts?.groups) >= 1, JSON.stringify(imported.data.counts));

  const tokenImp = imported.data.token;
  const meB = await call(baseB, 'GET', '/api/me', { token: tokenImp });
  check('导入后用新 token 能取到自己的资料', meB.status === 200 && meB.data.account?.number === '771001', meB.status);

  const friendsB = await call(baseB, 'GET', '/api/friends', { token: tokenImp });
  check('导入后好友列表有搬家乙', (friendsB.data.friends || []).some((f) => f.number === '771002'), (friendsB.data.friends || []).length);

  const convsB = await call(baseB, 'GET', '/api/conversations', { token: tokenImp });
  const dmConv = (convsB.data.conversations || []).find((c) => c.kind === 'dm');
  check('导入后私聊会话还在', !!dmConv, (convsB.data.conversations || []).length);
  if (dmConv) {
    const msgs = await call(baseB, 'GET', '/api/conversations/' + dmConv.id + '/messages', { token: tokenImp });
    const bodies = (msgs.data.messages || []).map((m) => m.body);
    check('导入后消息内容完整', bodies.includes('这条消息要跟着账号搬家') && bodies.includes('第二条'), JSON.stringify(bodies).slice(0, 120));
  }
  const groupsB = await call(baseB, 'GET', '/api/groups', { token: tokenImp });
  check('导入后群还在', (groupsB.data.groups || []).some((g) => g.number === '771200'), (groupsB.data.groups || []).length);
  const favB = await call(baseB, 'GET', '/api/favorites', { token: tokenImp });
  check('导入后收藏还在', (favB.data.favorites || []).length >= 1, (favB.data.favorites || []).length);
  const botsB = await call(baseB, 'GET', '/api/bots', { token: tokenImp });
  check('导入后 Bot 还在', (botsB.data.bots || []).some((b) => b.number === '771300'), (botsB.data.bots || []).length);

  const loginOld = await call(baseB, 'POST', '/api/login', { body: { number: '771001', password: PWD } });
  check('导入后能用原密码直接登录（换设备不用改密码）', loginOld.status === 200 && !!loginOld.data.token, loginOld.status);

  const again = await call(baseB, 'POST', '/api/account/import', { body: { password: PWD, package: exported.data.package } });
  check('同一个号码重复导入 409', again.status === 409, again.status + ' ' + again.data.error);
} finally {
  await A.app.close();
  await B.app.close();
}

console.log('\nRAN ' + ran + '  PASS ' + pass + '  FAIL ' + failures.length + '  ERR 0');
if (failures.length) {
  console.log('失败项：' + failures.join('、'));
  process.exit(1);
}
