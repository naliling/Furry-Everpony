import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const P = process.cwd();
const JAVA = join(P, '.tools/android/jdk-17.0.21+9/bin/java.exe');
const CP = join(P, 'android/build-local');
const dataDir = join(P, '.tools/tmp-local-test');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(join(dataDir, 'web'), { recursive: true });
writeFileSync(join(dataDir, 'web', 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>');
writeFileSync(join(dataDir, 'web', 'app.js'), 'console.log("fe");');

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, extra) {
  if (ok) { pass++; } else { fail++; fails.push(name + (extra ? ' :: ' + JSON.stringify(extra) : '')); }
}

let proc = null;
let BASE = '';
/** 起一个本机服务进程并等它报端口；重启测试会再调一次。 */
async function boot() {
  proc = spawn(JAVA, ['-cp', CP, 'fe.local.Main', '0', dataDir, '2026.11.15.0.10.7'], { cwd: P });
  let buf = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('启动超时: ' + buf)), 30000);
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/FE_LOCAL_SERVER_READY (\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    proc.stderr.on('data', (d) => { buf += d.toString(); });
  });
  BASE = 'http://127.0.0.1:' + port;
}
await boot();

async function api(method, path, opts = {}) {
  const headers = {};
  if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
  let body;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  else if (opts.raw !== undefined) { headers['Content-Type'] = 'application/octet-stream'; body = opts.raw; }
  const r = await fetch(BASE + path, { method, headers, body });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: r.status, data, headers: r.headers };
}

try {
  // ---- 健康与静态 ----
  const h = await api('GET', '/api/health');
  check('health 200', h.status === 200);
  check('health ok', h.data && h.data.ok === true, h.data);
  check('health local=true', h.data && h.data.local === true, h.data);
  const me401 = await api('GET', '/api/me');
  check('未登录 /api/me 401', me401.status === 401, me401.status);

  // 刚装好、还没人登录过：boot-token 是空的，首页不能被改动
  const bootFresh = await api('GET', '/api/native/token');
  check('全新安装 native token 为空串', bootFresh.status === 200 && bootFresh.data.token === '', bootFresh.data);
  const idxFresh = await api('GET', '/');
  check('全新安装首页原样返回', !idxFresh.data.includes('fe_token') && idxFresh.data.includes('<div id="root"'), idxFresh.data.slice(0, 160));

  // ---- 号码与注册 ----
  const avail = await api('GET', '/api/number/660001/available');
  check('号码可用', avail.status === 200 && avail.data.available === true, avail.data);
  const badNum = await api('POST', '/api/register', { json: { number: '066', password: 'password1', nickname: '错' } });
  check('非法号码 400', badNum.status === 400, badNum.status);
  const regA = await api('POST', '/api/register', { json: { number: '660001', password: 'password1', nickname: '甲' } });
  check('注册甲 200', regA.status === 200, regA.data);
  const A = regA.data.token;
  check('注册返回 account.number', regA.data.account && regA.data.account.number === '660001', regA.data.account);
  const regB = await api('POST', '/api/register', { json: { number: '660002', password: 'password1', nickname: '乙' } });
  const B = regB.data.token;
  check('注册乙 200', regB.status === 200);
  const regC = await api('POST', '/api/register', { json: { number: '660003', password: 'password1', nickname: '丙' } });
  const C = regC.data.token;
  check('注册丙 200', regC.status === 200);
  const dup = await api('POST', '/api/register', { json: { number: '660001', password: 'password1', nickname: '重' } });
  check('重复号码 409', dup.status === 409, dup.status);
  const badLogin = await api('POST', '/api/login', { json: { number: '660001', password: 'wrongpass' } });
  check('密码错 401', badLogin.status === 401, badLogin.status);
  const okLogin = await api('POST', '/api/login', { json: { number: '660001', password: 'password1' } });
  check('登录成功', okLogin.status === 200 && !!okLogin.data.token);

  // ---- 资料 ----
  const meA = await api('GET', '/api/me', { token: A });
  check('me 200', meA.status === 200 && meA.data.account.nickname === '甲', meA.data);
  const patchMe = await api('PATCH', '/api/me', { token: A, json: { bio: '你好', status: 'away' } });
  check('改资料 200', patchMe.status === 200, patchMe.data);
  const meA2 = await api('GET', '/api/me', { token: A });
  check('改资料生效', meA2.data.account.bio === '你好' && meA2.data.account.status === 'away', meA2.data.account);

  // ---- 好友 ----
  const reqFriend = await api('POST', '/api/friends/request', { token: B, json: { number: '660001', message: '加个好友' } });
  check('乙申请加甲 200', reqFriend.status === 200, reqFriend.data);
  const reqsA = await api('GET', '/api/friends/requests', { token: A });
  check('甲收到申请', reqsA.status === 200 && reqsA.data.incoming.length === 1, reqsA.data);
  const acc = await api('POST', '/api/friends/accept', { token: A, json: { number: '660002' } });
  check('甲同意 200', acc.status === 200, acc.data);
  const fA = await api('GET', '/api/friends', { token: A });
  check('甲好友里有乙', fA.status === 200 && fA.data.friends.length === 1 && fA.data.friends[0].number === '660002', fA.data);

  // ---- 好友分组与特别关心 ----
  const gcreate = await api('POST', '/api/friend-groups', { token: A, json: { name: '同学' } });
  check('建分组 200', gcreate.status === 200, gcreate.data);
  const glist = await api('GET', '/api/friend-groups', { token: A });
  check('分组列表有 1 个', glist.data.groups.length === 1, glist.data);
  const gid = glist.data.groups[0].id;
  const patchF = await api('PATCH', '/api/friends/660002', { token: A, json: { remark: '老乙', special: true, groupId: gid } });
  check('改备注/特别关心/分组 200', patchF.status === 200, patchF.data);
  const fA2 = await api('GET', '/api/friends', { token: A });
  check('备注生效', fA2.data.friends[0].remark === '老乙', fA2.data.friends[0]);
  check('特别关心生效', fA2.data.friends[0].special === true);

  // ---- 私聊 ----
  const m1 = await api('POST', '/api/messages', { token: B, json: { to: '660001', kind: 'text', body: '在吗' } });
  check('乙发消息 200', m1.status === 200 && m1.data.message.body === '在吗', m1.data);
  const convId = m1.data.conversationId;
  check('返回 conversationId', typeof convId === 'number', convId);
  const convsA = await api('GET', '/api/conversations', { token: A });
  check('甲会话列表 1 条', convsA.data.conversations.length === 1, convsA.data);
  check('甲未读 1', convsA.data.conversations[0].unread === 1, convsA.data.conversations[0]);
  check('会话 peer 是乙', convsA.data.conversations[0].peer.number === '660002', convsA.data.conversations[0].peer);
  check('会话 last 预览', convsA.data.conversations[0].last.preview === '在吗', convsA.data.conversations[0].last);

  const reply = await api('POST', '/api/conversations/' + convId + '/messages', { token: A, json: { kind: 'text', body: '在的', replyTo: m1.data.message.id } });
  check('甲回复 200', reply.status === 200, reply.data);
  check('回复带 reply 字段', reply.data.message.reply && reply.data.message.reply.body === '在吗', reply.data.message.reply);
  const msgs = await api('GET', '/api/conversations/' + convId + '/messages', { token: A });
  check('消息列表 2 条', msgs.data.messages.length === 2, msgs.data.messages.length);
  check('消息带 typing 字段', Array.isArray(msgs.data.typing));

  const read = await api('POST', '/api/conversations/' + convId + '/read', { token: A });
  check('已读 200', read.status === 200, read.data);
  const convsA2 = await api('GET', '/api/conversations', { token: A });
  check('已读后未读 0', convsA2.data.conversations[0].unread === 0, convsA2.data.conversations[0].unread);

  const mute = await api('POST', '/api/conversations/' + convId + '/mute', { token: A, json: { muted: true } });
  check('免打扰 200', mute.status === 200, mute.data);
  const convsA3 = await api('GET', '/api/conversations', { token: A });
  check('免打扰生效', convsA3.data.conversations[0].muted === true);

  const pin = await api('POST', '/api/conversations/' + convId + '/pin', { token: A, json: { pinned: true } });
  check('置顶 200', pin.status === 200, pin.data);
  const convsA4 = await api('GET', '/api/conversations', { token: A });
  check('置顶生效', convsA4.data.conversations[0].pinned === true);

  const typ = await api('POST', '/api/conversations/' + convId + '/typing', { token: B, json: { typing: true } });
  check('正在输入 200', typ.status === 200, typ.data);
  const msgs2 = await api('GET', '/api/conversations/' + convId + '/messages', { token: A });
  check('正在输入可见', msgs2.data.typing.length === 1 && msgs2.data.typing[0].number === '660002', msgs2.data.typing);

  // ---- 表情 / 收藏 / 删除 / 转发 ----
  const mid = m1.data.message.id;
  const r1 = await api('POST', '/api/messages/' + mid + '/reactions', { token: A, json: { emoji: '👍' } });
  check('加表情 200', r1.status === 200, r1.data);
  const r2 = await api('POST', '/api/messages/' + mid + '/reactions', { token: B, json: { emoji: '👍' } });
  check('第二人加表情 200', r2.status === 200, r2.data);
  const msgs3 = await api('GET', '/api/conversations/' + convId + '/messages', { token: A });
  const target = msgs3.data.messages.find((m) => m.id === mid);
  check('表情计数 2', target.reactions.length === 1 && target.reactions[0].count === 2, target.reactions);
  check('mine 标记', target.reactions[0].mine === true);

  const fav = await api('POST', '/api/messages/' + mid + '/favorite', { token: A });
  check('收藏 200', fav.status === 200, fav.data);
  const favList = await api('GET', '/api/favorites', { token: A });
  check('收藏列表 1 条', favList.data.favorites.length === 1, favList.data);
  check('收藏带 conversation', favList.data.favorites[0].conversation && favList.data.favorites[0].conversation.kind === 'dm', favList.data.favorites[0]);
  const unfav = await api('DELETE', '/api/messages/' + mid + '/favorite', { token: A });
  check('取消收藏 200', unfav.status === 200);
  const favList2 = await api('GET', '/api/favorites', { token: A });
  check('取消后 0 条', favList2.data.favorites.length === 0);

  const del = await api('POST', '/api/messages/' + mid + '/delete', { token: A });
  check('仅自己删除 200', del.status === 200, del.data);
  const msgsA = await api('GET', '/api/conversations/' + convId + '/messages', { token: A });
  const msgsB = await api('GET', '/api/conversations/' + convId + '/messages', { token: B });
  check('自己看不到被删消息', !msgsA.data.messages.some((m) => m.id === mid), msgsA.data.messages.length);
  check('对方还能看到', msgsB.data.messages.some((m) => m.id === mid), msgsB.data.messages.length);

  const fwd = await api('POST', '/api/messages/' + reply.data.message.id + '/forward', { token: A, json: { conversationId: convId } });
  check('转发 200', fwd.status === 200, fwd.data);

  // 合并转发（前端「多选 → 合并转发」走这个接口）
  const listForMerge = await api('GET', '/api/conversations/' + convId + '/messages', { token: A });
  const pickIds = listForMerge.data.messages.slice(-2).map((m) => m.id);
  const mergeNoAuth = await api('POST', '/api/conversations/' + convId + '/forward-merge', { json: { messageIds: pickIds, conversationId: convId } });
  check('合并转发未登录 401', mergeNoAuth.status === 401, mergeNoAuth.status);
  const merge = await api('POST', '/api/conversations/' + convId + '/forward-merge', { token: A, json: { messageIds: pickIds, conversationId: convId } });
  check('合并转发 200', merge.status === 200, merge.data);
  check('合并转发 kind=merge', merge.data.message && merge.data.message.kind === 'merge', merge.data.message && merge.data.message.kind);
  check('合并转发正文带条数', merge.data.message && merge.data.message.body === '[聊天记录] 2 条', merge.data.message && merge.data.message.body);
  const rawMeta = merge.data.message && merge.data.message.meta;
  const mergeMeta = !rawMeta ? {} : (typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta);
  check('合并转发 meta 带 2 条明细', mergeMeta.count === 2 && Array.isArray(mergeMeta.items) && mergeMeta.items.length === 2, mergeMeta);
  const mergeEmpty = await api('POST', '/api/conversations/' + convId + '/forward-merge', { token: A, json: { messageIds: [], conversationId: convId } });
  check('合并转发空列表 400', mergeEmpty.status === 400, mergeEmpty.status);
  const mergeBadConv = await api('POST', '/api/conversations/999999/forward-merge', { token: A, json: { messageIds: pickIds, conversationId: convId } });
  check('合并转发源会话不存在 403', mergeBadConv.status === 403, mergeBadConv.status);

  // Bot 广场在手机版给空列表，不能报错（前端会 toast 报错）
  const bots = await api('GET', '/api/bots', { token: A });
  check('手机版 /api/bots 空列表', bots.status === 200 && Array.isArray(bots.data.bots) && bots.data.bots.length === 0, bots.data);
  const botsPublic = await api('GET', '/api/bots/public?q=x', { token: A });
  check('手机版 /api/bots/public 空列表', botsPublic.status === 200 && Array.isArray(botsPublic.data.bots), botsPublic.data);
  const astrbot = await api('GET', '/api/astrbot/platforms', { token: A });
  check('手机版 /api/astrbot/platforms 空列表', astrbot.status === 200 && Array.isArray(astrbot.data.platforms), astrbot.data);

  const search = await api('GET', '/api/messages/search?q=' + encodeURIComponent('在的'), { token: A });
  check('搜索 200', search.status === 200 && search.data.messages.length >= 1, search.data);

  // ---- 群 ----
  const gcreate2 = await api('POST', '/api/groups', { token: A, json: { name: '测试群', number: '770001' } });
  check('建群 200', gcreate2.status === 200, gcreate2.data);
  check('建群返回群号', gcreate2.data.group && gcreate2.data.group.number === '770001', gcreate2.data.group);
  const gdetail = await api('GET', '/api/groups/770001', { token: A });
  check('群详情 200', gdetail.status === 200, gdetail.data);
  check('群详情 role=owner', gdetail.data.group.role === 'owner', gdetail.data.group.role);
  check('群成员 1 人', gdetail.data.group.members === 1, gdetail.data.group.members);
  const notMember = await api('GET', '/api/groups/770001', { token: B });
  check('非成员看群详情 403', notMember.status === 403, notMember.status);

  const inv = await api('POST', '/api/groups/770001/invite', { token: A, json: { number: '660002' } });
  check('邀请乙 200', inv.status === 200, inv.data);
  const greq = await api('GET', '/api/group-requests', { token: B });
  check('乙收到群邀请', greq.data.incoming.length === 1, greq.data);
  const gacc = await api('POST', '/api/group-requests/' + greq.data.incoming[0].id + '/accept', { token: B });
  check('乙同意入群 200', gacc.status === 200, gacc.data);
  const gdetail2 = await api('GET', '/api/groups/770001', { token: A });
  check('群成员 2 人', gdetail2.data.group.members === 2, gdetail2.data.group.members);

  const gmsg = await api('POST', '/api/groups/770001/messages', { token: B, json: { body: '大家好' } });
  check('群发言 200', gmsg.status === 200 && gmsg.data.message.body === '大家好', gmsg.data);
  const gmsgBad = await api('POST', '/api/groups/770001/messages', { token: C, json: { body: '插一句' } });
  check('非成员群发言 403', gmsgBad.status === 403, gmsgBad.status);

  const admin = await api('POST', '/api/groups/770001/admin', { token: A, json: { number: '660002', admin: true } });
  check('设管理员 200', admin.status === 200, admin.data);
  const members = await api('GET', '/api/groups/770001/members', { token: A });
  const bm = members.data.members.find((m) => m.number === '660002');
  check('乙 role=admin', bm && bm.role === 'admin', bm && bm.role);
  const nick = await api('PATCH', '/api/groups/770001/me', { token: B, json: { nickname: '乙酱' } });
  check('改群名片 200', nick.status === 200, nick.data);
  const members2 = await api('GET', '/api/groups/770001/members', { token: A });
  const bm2 = members2.data.members.find((m) => m.number === '660002');
  check('群名片生效', bm2.nickname === '乙酱' && bm2.group_nickname === '乙酱', bm2.nickname);

  // 拉丙进群，用来验证普通成员在全员禁言时不能发言
  await api('POST', '/api/groups/770001/invite', { token: A, json: { number: '660003' } });
  const creq = await api('GET', '/api/group-requests', { token: C });
  await api('POST', '/api/group-requests/' + creq.data.incoming[0].id + '/accept', { token: C });

  const mutAll = await api('POST', '/api/groups/770001/mute-all', { token: A, json: { muteAll: true } });
  check('全员禁言 200', mutAll.status === 200, mutAll.data);
  const gmsgMuted = await api('POST', '/api/groups/770001/messages', { token: C, json: { body: '被禁言' } });
  check('全员禁言时普通成员 403', gmsgMuted.status === 403, gmsgMuted.status);
  const gmsgAdmin = await api('POST', '/api/groups/770001/messages', { token: B, json: { body: '管理员能说' } });
  check('全员禁言时管理员能发言', gmsgAdmin.status === 200, gmsgAdmin.status);
  const gmsgOwner = await api('POST', '/api/groups/770001/messages', { token: A, json: { body: '群主能说' } });
  check('全员禁言时群主能发言', gmsgOwner.status === 200, gmsgOwner.status);
  await api('POST', '/api/groups/770001/mute-all', { token: A, json: { muteAll: false } });

  const ann = await api('PATCH', '/api/groups/770001', { token: A, json: { announcement: '今晚八点开会' } });
  check('改公告 200', ann.status === 200, ann.data);
  const annRead = await api('POST', '/api/groups/770001/announcement/read', { token: B });
  check('公告已读 200', annRead.status === 200);
  const gdetail3 = await api('GET', '/api/groups/770001', { token: B });
  check('公告已读时间>0', gdetail3.data.group.announcement_read_at > 0, gdetail3.data.group.announcement_read_at);
  check('公告内容正确', gdetail3.data.group.announcement === '今晚八点开会', gdetail3.data.group.announcement);

  // ---- 上传与群文件 ----
  const payload = Buffer.from('这是测试文件内容', 'utf8');
  const up = await api('POST', '/api/upload?name=' + encodeURIComponent('测试.txt'), { token: A, raw: payload });
  check('上传 200', up.status === 200 && up.data.ok === true, up.data);
  check('上传返回 url', typeof up.data.url === 'string' && up.data.url.startsWith('/uploads/'), up.data.url);
  const dl = await fetch(BASE + up.data.url);
  const dlText = await dl.text();
  check('取回上传文件', dl.status === 200 && dlText === '这是测试文件内容', dl.status);
  const gfile = await api('POST', '/api/groups/770001/files', { token: A, json: { name: '测试.txt', url: up.data.url, size: payload.length } });
  check('登记群文件 200', gfile.status === 200, gfile.data);
  const gfiles = await api('GET', '/api/groups/770001/files', { token: B });
  check('群文件列表 1 条', gfiles.data.files.length === 1 && gfiles.data.files[0].name === '测试.txt', gfiles.data);
  const gfileDel = await api('DELETE', '/api/groups/770001/files/' + gfiles.data.files[0].id, { token: B });
  check('管理员删群文件 200', gfileDel.status === 200, gfileDel.data);

  // ---- 通知 / 服务器信息 ----
  const notes = await api('GET', '/api/notifications', { token: A });
  check('通知 200', notes.status === 200 && Array.isArray(notes.data.items), notes.data);
  const info = await api('GET', '/api/server-info', { token: A });
  check('server-info 200', info.status === 200, info.data);
  check('server-info local=true', info.data.local === true, info.data);
  check('server-info 有 version', typeof info.data.version === 'string' && info.data.version.length > 0, info.data.version);
  check('server-info lanUrls 是数组', Array.isArray(info.data.lanUrls), info.data.lanUrls);

  const apkInfo = await api('GET', '/api/apk/info', { token: A });
  check('apk/info 200 且不可用', apkInfo.status === 200 && apkInfo.data.available === false, apkInfo.data);

  // ---- 静态兜底与 404 ----
  const index = await api('GET', '/');
  check('静态兜底返回页面', index.status === 200 && typeof index.data === 'string' && index.data.includes('<div id="root"'), index.status);
  const unknown = await api('GET', '/api/没有这个接口', { token: A });
  check('未知接口 404', unknown.status === 404, unknown.status);

  // ---- 开机登录态：boot-token 落盘 + 首页注入（划掉后台重开不用重登的关键） ----
  const TOKEN_RE = /^[0-9a-f]{16,64}$/;
  check('注册返回的 token 形状合规', TOKEN_RE.test(String(A)), String(A).slice(0, 6));

  const bootNow = await api('GET', '/api/native/token');
  check('用过的 token 已经自动落盘成甲的', bootNow.status === 200 && bootNow.data.token === A, bootNow.data);

  const setTok = await api('POST', '/api/native/token', { json: { token: A } });
  check('写 native token 200 且 ok', setTok.status === 200 && setTok.data.ok === true, setTok.data);
  const getTok = await api('GET', '/api/native/token');
  check('native token 能读回同一个', getTok.data.token === A, getTok.data);
  const idxInj = await api('GET', '/');
  check('首页注入了登录 token', typeof idxInj.data === 'string' && idxInj.data.includes("localStorage.setItem('fe_token',\"" + A + "\")"), idxInj.data.slice(0, 400));
  const posScript = idxInj.data.indexOf("setItem('fe_token'");
  const posHead = idxInj.data.indexOf('</head>');
  check('注入点在 </head> 之前', posScript > 0 && posHead > 0 && posScript < posHead, [posScript, posHead]);
  const idxNamed = await api('GET', '/index.html');
  check('/index.html 也注入', idxNamed.data.includes("setItem('fe_token'"), idxNamed.data.slice(0, 200));
  const appJs = await api('GET', '/app.js');
  check('非首页不注入', typeof appJs.data === 'string' && !appJs.data.includes('fe_token'), appJs.data);

  const evilTok = "';alert(1);//";
  const badTok = await api('POST', '/api/native/token', { json: { token: evilTok } });
  check('写非法 token 仍 200（只落盘不注入）', badTok.status === 200, badTok.data);
  const badGet = await api('GET', '/api/native/token');
  check('非法 token 原样存着便于排查', badGet.data.token === evilTok, badGet.data);
  const idxBad = await api('GET', '/');
  check('非法 token 不注入', !idxBad.data.includes('alert(1)') && !idxBad.data.includes('fe_token'), idxBad.data.slice(0, 300));

  const clearTok = await api('POST', '/api/native/token', { json: { token: '' } });
  check('清空 native token 200 且 ok', clearTok.status === 200 && clearTok.data.ok === true, clearTok.data);
  const afterClear = await api('GET', '/api/native/token');
  check('清空后读回空串', afterClear.data.token === '', afterClear.data);
  const idxClear = await api('GET', '/');
  check('清空后首页不注入', !idxClear.data.includes('fe_token'), idxClear.data.slice(0, 200));

  // 真实使用中的 token 要自动落盘，App 下次打开注入的就是它
  const meAuto = await api('GET', '/api/me', { token: A });
  check('带 token 请求 200', meAuto.status === 200, meAuto.status);
  const autoTok = await api('GET', '/api/native/token');
  check('用过的 token 自动落盘', autoTok.data.token === A, autoTok.data);
  const idxAuto = await api('GET', '/');
  check('首页注入自动落盘的 token', idxAuto.data.includes("localStorage.setItem('fe_token',\"" + A + "\")"));
  const noAuthTok = await api('POST', '/api/native/token', { json: { token: A } });
  check('写 native token 不需要登录', noAuthTok.status === 200, noAuthTok.status);

  // ---- 退出登录 ----
  const logout = await api('POST', '/api/logout', { token: B });
  check('退出登录 200', logout.status === 200, logout.data);
  const afterLogout = await api('GET', '/api/me', { token: B });
  check('退出后 token 失效 401', afterLogout.status === 401, afterLogout.status);
  const bootAfterLogout = await api('GET', '/api/native/token');
  check('退出登录后 boot-token 清空', bootAfterLogout.data.token === '', bootAfterLogout.data);
  const idxAfterLogout = await api('GET', '/');
  check('退出登录后首页不注入', !idxAfterLogout.data.includes('fe_token'), idxAfterLogout.data.slice(0, 200));

  // ---- 杀进程重开：等价于「从最近任务划掉再打开」的服务器侧 ----
  proc.kill();
  await new Promise((r) => setTimeout(r, 800));
  await boot();
  const meRestart = await api('GET', '/api/me', { token: A });
  check('重开后老 token 仍有效', meRestart.status === 200, meRestart.status);
  const bootRestart = await api('GET', '/api/native/token');
  check('重开后 boot-token 自动写回', bootRestart.data.token === A, bootRestart.data);
  const idxRestart = await api('GET', '/');
  check('重开后首页注入老 token', idxRestart.data.includes("localStorage.setItem('fe_token',\"" + A + "\")"));
  const meForged = await api('GET', '/api/me', { token: 'f'.repeat(48) });
  check('重开后瞎编的 token 仍 401', meForged.status === 401, meForged.status);
} catch (e) {
  fail++;
  fails.push('异常: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
} finally {
  try { if (proc) proc.kill(); } catch (e) { /* 已经退了就算了 */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
}

console.log('');
console.log('RAN ' + (pass + fail) + '  PASS ' + pass + '  FAIL ' + fail + '  ERR 0');
if (fails.length) { console.log('失败项:'); for (const f of fails) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
