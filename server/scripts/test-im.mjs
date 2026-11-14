// IM 进阶接口测试：引用/表情/收藏/转发/免打扰/状态/改密/好友分组/Bot 审批/群管理/群文件/通知/上传/服务器信息
import { buildServer } from '../index.js';
import { openDb } from '../db.js';
import { mkdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

// 版本号跟着 package.json 走，别在测试里写死
const PKG_VERSION = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version;

const toolsDir = join(process.cwd(), '.tools');
mkdirSync(toolsDir, { recursive: true });

// 造一个只放 APK 的目录：旧版 0.10.4 的修改时间比新版更新，
// 用来验证服务端是按版本号挑包，而不是按文件时间（否则会发出旧包）
const apkDir = join(toolsDir, 'apk-test-im');
mkdirSync(apkDir, { recursive: true });
const fakeApk = () => {
  const b = Buffer.alloc(2000, 0x41);
  b.write('PK', 0, 'latin1');
  return b;
};
// 版本号从 package.json 推，别写死（写死的话每次升版都要改测试）
const parts = PKG_VERSION.split('.');
parts[parts.length - 1] = String(Math.max(0, Number(parts[parts.length - 1]) - 1));
const OLD_VERSION = parts.join('.');
const OLD_APK = `FurryEverpony-${OLD_VERSION}.apk`;
const NEW_APK = `FurryEverpony-${PKG_VERSION}.apk`;
writeFileSync(join(apkDir, OLD_APK), fakeApk());
writeFileSync(join(apkDir, NEW_APK), fakeApk());
const future = new Date(Date.now() + 3600 * 1000);
utimesSync(join(apkDir, OLD_APK), future, future);
process.env.FE_APK_DIR = apkDir;
const dbFile = join(toolsDir, `fe-test-im-${Date.now()}.db`);
const db = openDb(dbFile);
const app = buildServer({ db, uploadDir: join(toolsDir, 'uploads-im') });
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${app.server.address().port}`;

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

async function uploadRaw(buffer, name, token) {
  const headers = { 'Content-Type': 'application/octet-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api/upload?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers,
    body: buffer,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

try {
  console.log('0. 未登录拦截');
  const noAuthNoti = await call('GET', '/api/notifications');
  check('未登录看通知 401', noAuthNoti.status === 401, `status=${noAuthNoti.status}`);
  const noAuthInfo = await call('GET', '/api/server-info');
  check('未登录看服务器信息 401', noAuthInfo.status === 401, `status=${noAuthInfo.status}`);
  const noAuthUpload = await uploadRaw(Buffer.from('x'), 'x.txt');
  check('未登录上传 401', noAuthUpload.status === 401, `status=${noAuthUpload.status}`);
  const noAuthPwd = await call('POST', '/api/me/password', {
    body: { oldPassword: 'password123', newPassword: 'newpassword456' },
  });
  check('未登录改密码 401', noAuthPwd.status === 401, `status=${noAuthPwd.status}`);

  console.log('1. 注册与好友');
  const regA = await call('POST', '/api/register', {
    body: { number: '555001', password: 'password123', nickname: '甲' },
  });
  const regB = await call('POST', '/api/register', {
    body: { number: '555002', password: 'password123', nickname: '乙' },
  });
  const regC = await call('POST', '/api/register', {
    body: { number: '555003', password: 'password123', nickname: '丙' },
  });
  const regD = await call('POST', '/api/register', {
    body: { number: '555004', password: 'password123', nickname: '丁' },
  });
  check(
    '四个号注册成功',
    [regA, regB, regC, regD].every((r) => r.status === 200 && r.data.token),
    JSON.stringify([regA.status, regB.status, regC.status, regD.status]),
  );
  const ta = regA.data.token;
  const tb = regB.data.token;
  const tc = regC.data.token;
  const td = regD.data.token;

  const reqFriend = await call('POST', '/api/friends/request', {
    method: 'POST',
    token: ta,
    body: { number: '555002', message: '你好' },
  });
  check('甲加乙待同意', reqFriend.status === 200 && reqFriend.data.status === 'pending', `status=${reqFriend.status}`);
  const bIncoming = await call('GET', '/api/friends/requests', { token: tb });
  const friendReq = (bIncoming.data.incoming || [])[0];
  check('乙收到好友申请', !!friendReq && friendReq.number === '555001', JSON.stringify(bIncoming.data.incoming));
  const acceptFriend = await call('POST', '/api/friends/accept', {
    token: tb,
    body: { requestId: friendReq?.id },
  });
  check('乙同意好友', acceptFriend.status === 200 && acceptFriend.data.status === 'accepted', `status=${acceptFriend.status}`);

  console.log('2. 消息：引用/正在输入/表情/收藏/删除/转发/合并转发');
  const msg1 = await call('POST', '/api/messages', {
    token: ta,
    body: { to: '555002', body: '第一句' },
  });
  check('甲发消息成功', msg1.status === 200 && msg1.data.message?.id > 0, `status=${msg1.status}`);
  const convId = msg1.data.conversationId;
  const msg1Id = msg1.data.message.id;

  const reply1 = await call('POST', '/api/messages', {
    token: tb,
    body: { to: '555001', body: '回复你', replyTo: msg1Id },
  });
  check('乙引用回复成功', reply1.status === 200 && reply1.data.message?.reply?.id === msg1Id, JSON.stringify(reply1.data));
  const replyId = reply1.data.message.id;

  const bView = await call('GET', `/api/conversations/${convId}/messages`, { token: tb });
  check('会话里看到引用', bView.data.messages?.length === 2 && bView.data.messages[1]?.reply?.body === '第一句', JSON.stringify(bView.data.messages));

  const typingOn = await call('POST', `/api/conversations/${convId}/typing`, {
    token: ta,
    body: { typing: true },
  });
  const bTyping = await call('GET', `/api/conversations/${convId}/messages`, { token: tb });
  check(
    '正在输入可见',
    typingOn.status === 200 && (bTyping.data.typing || []).some((x) => x.number === '555001'),
    JSON.stringify(bTyping.data.typing),
  );
  await call('POST', `/api/conversations/${convId}/typing`, { token: ta, body: { typing: false } });
  const bTypingOff = await call('GET', `/api/conversations/${convId}/messages`, { token: tb });
  check('取消正在输入后不可见', (bTypingOff.data.typing || []).length === 0, JSON.stringify(bTypingOff.data.typing));

  const reactB = await call('POST', `/api/messages/${replyId}/reactions`, {
    token: tb,
    body: { emoji: '👍' },
  });
  check(
    '乙点表情回应',
    reactB.status === 200 && reactB.data.reactions?.length === 1 && reactB.data.reactions[0].count === 1 && reactB.data.reactions[0].mine === true,
    JSON.stringify(reactB.data),
  );
  const reactA = await call('POST', `/api/messages/${replyId}/reactions`, {
    token: ta,
    body: { emoji: '👍' },
  });
  check('甲也点表情后计数 2', reactA.data.reactions?.[0]?.count === 2, JSON.stringify(reactA.data));
  const reactOff = await call('POST', `/api/messages/${replyId}/reactions`, {
    token: tb,
    body: { emoji: '👍' },
  });
  check(
    '乙再点一次取消',
    reactOff.data.reactions?.length === 1 && reactOff.data.reactions[0].count === 1 && reactOff.data.reactions[0].mine === false,
    JSON.stringify(reactOff.data),
  );

  const fav = await call('POST', `/api/messages/${replyId}/favorite`, { token: tb });
  const favList = await call('GET', '/api/favorites', { token: tb });
  check(
    '收藏消息',
    fav.status === 200 && favList.data.favorites?.length === 1 && favList.data.favorites[0]?.message?.id === replyId,
    JSON.stringify(favList.data.favorites),
  );
  check(
    '收藏带会话摘要',
    favList.data.favorites?.[0]?.conversation?.kind === 'dm' && favList.data.favorites[0].conversation.peer?.number === '555001',
    JSON.stringify(favList.data.favorites?.[0]?.conversation),
  );
  await call('DELETE', `/api/messages/${replyId}/favorite`, { token: tb });
  const favEmpty = await call('GET', '/api/favorites', { token: tb });
  check('取消收藏', (favEmpty.data.favorites || []).length === 0, JSON.stringify(favEmpty.data.favorites));

  const delMine = await call('POST', `/api/messages/${msg1Id}/delete`, { token: tb });
  const bAfterDel = await call('GET', `/api/conversations/${convId}/messages`, { token: tb });
  const aAfterDel = await call('GET', `/api/conversations/${convId}/messages`, { token: ta });
  check('仅自己删除成功', delMine.status === 200, `status=${delMine.status}`);
  check('删除后自己少一条', (bAfterDel.data.messages || []).length === 1, `n=${bAfterDel.data.messages?.length}`);
  check('删除后对方还看得到', (aAfterDel.data.messages || []).length === 2, `n=${aAfterDel.data.messages?.length}`);

  const fwd = await call('POST', `/api/messages/${replyId}/forward`, {
    token: tb,
    body: { conversationId: convId },
  });
  check(
    '转发消息',
    fwd.status === 200 && fwd.data.message?.kind === 'forward' && fwd.data.message?.meta?.from?.number === '555002',
    JSON.stringify(fwd.data),
  );
  const merge = await call('POST', `/api/conversations/${convId}/forward-merge`, {
    token: tb,
    body: { messageIds: [msg1Id, replyId], conversationId: convId },
  });
  check(
    '合并转发',
    merge.status === 200 && merge.data.message?.kind === 'merge' && merge.data.message?.meta?.count === 2,
    JSON.stringify(merge.data),
  );
  check('合并转发正文带条数', merge.data.message?.body === '[聊天记录] 2 条', String(merge.data.message?.body));

  console.log('3. 免打扰与在线状态');
  const mute = await call('POST', `/api/conversations/${convId}/mute`, {
    token: ta,
    body: { muted: true },
  });
  const convs = await call('GET', '/api/conversations', { token: ta });
  const convRow = (convs.data.conversations || []).find((c) => c.id === convId);
  check('会话免打扰', mute.status === 200 && convRow?.muted === true, JSON.stringify(convRow));

  await call('PATCH', '/api/me', { token: ta, body: { status: 'away' } });
  const bSeeA = await call('GET', '/api/users/555001', { token: tb });
  check(
    '好友看到忙碌状态',
    bSeeA.data.account?.status === 'away' && bSeeA.data.account?.online === true,
    JSON.stringify(bSeeA.data.account),
  );
  await call('PATCH', '/api/me', { token: ta, body: { status: 'invisible' } });
  const bFinds = await call('GET', '/api/friends', { token: tb });
  const aRow = (bFinds.data.friends || []).find((f) => f.number === '555001');
  check('隐身时显示离线', aRow?.online === false && aRow?.status === 'offline', JSON.stringify(aRow));
  await call('PATCH', '/api/me', { token: ta, body: { status: 'online' } });

  console.log('4. 改密码');
  const badPwd = await call('POST', '/api/me/password', {
    token: ta,
    body: { oldPassword: 'wrongpass', newPassword: 'newpassword456' },
  });
  check('原密码错 403', badPwd.status === 403, `status=${badPwd.status}`);
  const okPwd = await call('POST', '/api/me/password', {
    token: ta,
    body: { oldPassword: 'password123', newPassword: 'newpassword456' },
  });
  check('改密码成功', okPwd.status === 200 && okPwd.data.ok === true, `status=${okPwd.status}`);
  const loginNew = await call('POST', '/api/login', {
    body: { number: '555001', password: 'newpassword456' },
  });
  check('新密码能登录', loginNew.status === 200 && !!loginNew.data.token, `status=${loginNew.status}`);
  const loginOld = await call('POST', '/api/login', {
    body: { number: '555001', password: 'password123' },
  });
  check('旧密码登录 401', loginOld.status === 401, `status=${loginOld.status}`);

  console.log('5. 好友分组与特别关心');
  const g = await call('POST', '/api/friend-groups', { token: ta, body: { name: '同学' } });
  check('建好友分组', g.status === 200 && g.data.group?.id > 0, JSON.stringify(g.data));
  const gid = g.data.group?.id;
  const patchFriend = await call('PATCH', '/api/friends/555002', {
    token: ta,
    body: { remark: '小乙', special: true, groupId: gid },
  });
  const friendList = await call('GET', '/api/friends', { token: ta });
  const friendRow = (friendList.data.friends || []).find((f) => f.number === '555002');
  check(
    '特别关心+分组+备注',
    patchFriend.status === 200 && friendRow?.special === true && friendRow?.group_id === gid && friendRow?.remark === '小乙',
    JSON.stringify(friendRow),
  );
  const groupsList = await call('GET', '/api/friend-groups', { token: ta });
  const groupRow = (groupsList.data.groups || []).find((x) => x.id === gid);
  check('分组人数统计', groupRow?.count === 1, JSON.stringify(groupRow));
  const badGroup = await call('PATCH', '/api/friends/555002', {
    token: ta,
    body: { groupId: 999999 },
  });
  check('不存在分组 404', badGroup.status === 404, `status=${badGroup.status}`);

  console.log('6. Bot 加好友要主人审批');
  const bot = await call('POST', '/api/bots', {
    token: ta,
    body: { number: '555100', nickname: '小马助手' },
  });
  check('建 Bot', bot.status === 200, `status=${bot.status}`);
  const addBot = await call('POST', '/api/friends/request', {
    token: tb,
    body: { number: '555100', message: '你好 Bot' },
  });
  check('加 Bot 待审批', addBot.status === 200 && addBot.data.status === 'pending' && addBot.data.pendingApproval === true, JSON.stringify(addBot.data));
  const aBotInbox = await call('GET', '/api/friends/requests', { token: ta });
  const botReq = (aBotInbox.data.botIncoming || []).find((x) => x.from?.number === '555002' && x.bot?.number === '555100');
  check('主人收到 Bot 好友申请', !!botReq, JSON.stringify(aBotInbox.data.botIncoming));
  const aNoti = await call('GET', '/api/notifications', { token: ta });
  check(
    '通知里有 bot_request',
    (aNoti.data.items || []).some((n) => n.type === 'bot_request'),
    JSON.stringify(aNoti.data.items?.map((n) => n.type)),
  );
  const acceptBot = await call('POST', '/api/friends/accept', {
    token: ta,
    body: { number: '555002', bot: '555100' },
  });
  const bFriends = await call('GET', '/api/friends', { token: tb });
  check(
    '主人同意后乙加上 Bot',
    acceptBot.status === 200 && (bFriends.data.friends || []).some((f) => f.number === '555100'),
    `status=${acceptBot.status}`,
  );

  console.log('7. 群管理');
  const createGroup = await call('POST', '/api/groups', {
    token: ta,
    body: { number: '555200', name: '小马测试群' },
  });
  check('建群', createGroup.status === 200, JSON.stringify(createGroup.data));
  const groupConv = createGroup.data.conversationId;
  const bJoin = await call('POST', '/api/groups/555200/join', { token: tb });
  const cJoin = await call('POST', '/api/groups/555200/join', { token: tc });
  check('乙丙进群', bJoin.status === 200 && cJoin.status === 200, `${bJoin.status}/${cJoin.status}`);

  const dPeek = await call('GET', '/api/groups/555200', { token: td });
  check('非群成员看群详情 403', dPeek.status === 403, `status=${dPeek.status}`);
  const dFiles = await call('GET', '/api/groups/555200/files', { token: td });
  check('非群成员看群文件 403', dFiles.status === 403, `status=${dFiles.status}`);

  const bSetAdmin = await call('POST', '/api/groups/555200/admin', {
    token: tb,
    body: { number: '555003', admin: true },
  });
  check('非群主设管理员 403', bSetAdmin.status === 403, `status=${bSetAdmin.status}`);
  const aSetAdmin = await call('POST', '/api/groups/555200/admin', {
    token: ta,
    body: { number: '555002', admin: true },
  });
  check('群主设乙管理员', aSetAdmin.status === 200, `status=${aSetAdmin.status}`);
  const bDetail = await call('GET', '/api/groups/555200', { token: tb });
  check('群详情显示管理员角色', bDetail.data.group?.role === 'admin' && bDetail.data.group?.members === 3, JSON.stringify(bDetail.data.group));

  const setNick = await call('PATCH', '/api/groups/555200/me', {
    token: tb,
    body: { nickname: '乙酱' },
  });
  const memberList = await call('GET', '/api/groups/555200/members', { token: ta });
  const bMember = (memberList.data.members || []).find((m) => m.number === '555002');
  check(
    '群名片修改',
    setNick.status === 200 && bMember?.group_nickname === '乙酱' && bMember?.nickname === '乙酱',
    JSON.stringify(bMember),
  );

  const inviteBot = await call('POST', '/api/groups/555200/invite', {
    token: ta,
    body: { number: '555100' },
  });
  check('拉 Bot 进群待同意', inviteBot.status === 200 && inviteBot.data.pending === true, JSON.stringify(inviteBot.data));
  const aGroupInbox = await call('GET', '/api/group-requests', { token: ta });
  const botInvite = (aGroupInbox.data.incoming || []).find((x) => x.to_number === '555100' && x.number === '555200');
  check('主人收到入群邀请', !!botInvite, JSON.stringify(aGroupInbox.data.incoming));
  const acceptInvite = await call('POST', `/api/group-requests/${botInvite?.id}/accept`, { token: ta });
  const membersAfterBot = await call('GET', '/api/groups/555200/members', { token: ta });
  check(
    '同意后 Bot 进群',
    acceptInvite.status === 200 && (membersAfterBot.data.members || []).length === 4,
    `status=${acceptInvite.status} n=${membersAfterBot.data.members?.length}`,
  );

  const muteC = await call('POST', '/api/groups/555200/mute', {
    token: tb,
    body: { number: '555003', minutes: 5 },
  });
  check('管理员禁言丙', muteC.status === 200 && muteC.data.mute_until > Date.now(), JSON.stringify(muteC.data));
  const cMuted = await call('POST', '/api/groups/555200/messages', { token: tc, body: { body: '我被禁言了' } });
  check('被禁言不能发言 403', cMuted.status === 403, `status=${cMuted.status}`);
  const unmuteC = await call('POST', '/api/groups/555200/mute', {
    token: tb,
    body: { number: '555003', minutes: 0 },
  });
  const cSend = await call('POST', '/api/groups/555200/messages', { token: tc, body: { body: '解禁了' } });
  check('解除禁言后能发言', unmuteC.status === 200 && cSend.status === 200, `${unmuteC.status}/${cSend.status}`);

  const muteAll = await call('POST', '/api/groups/555200/mute-all', { token: tb, body: { muteAll: true } });
  const cMuteAll = await call('POST', '/api/groups/555200/messages', { token: tc, body: { body: '全员禁言中' } });
  const aMuteAll = await call('POST', '/api/groups/555200/messages', { token: ta, body: { body: '群主还能说' } });
  check('全员禁言时普通成员 403', muteAll.status === 200 && cMuteAll.status === 403, `${muteAll.status}/${cMuteAll.status}`);
  check('群主不受全员禁言限制', aMuteAll.status === 200, `status=${aMuteAll.status}`);
  await call('POST', '/api/groups/555200/mute-all', { token: tb, body: { muteAll: false } });
  const cSend2 = await call('POST', '/api/groups/555200/messages', { token: tc, body: { body: '又能说了' } });
  check('关闭全员禁言后能发言', cSend2.status === 200, `status=${cSend2.status}`);

  const ann = await call('PATCH', '/api/groups/555200', {
    token: ta,
    body: { announcement: '本周六晚八点活动' },
  });
  const bDetail2 = await call('GET', '/api/groups/555200', { token: tb });
  check(
    '改群公告',
    ann.status === 200 && bDetail2.data.group?.announcement === '本周六晚八点活动' && bDetail2.data.group?.announcement_read_at === 0,
    JSON.stringify(bDetail2.data.group),
  );
  const readAnn = await call('POST', '/api/groups/555200/announcement/read', { token: tb });
  const bDetail3 = await call('GET', '/api/groups/555200', { token: tb });
  check(
    '公告已读时间更新',
    readAnn.status === 200 && bDetail3.data.group?.announcement_read_at > 0,
    JSON.stringify(bDetail3.data.group?.announcement_read_at),
  );

  console.log('8. 上传与群文件');
  const text = '群文件测试内容 hello';
  const up = await uploadRaw(Buffer.from(text), '说明.txt', ta);
  check('上传文件成功', up.status === 200 && /^\/uploads\//.test(up.data.url || ''), JSON.stringify(up.data));
  const got = await fetch(base + up.data.url);
  const gotText = await got.text();
  check('取回上传内容一致', got.status === 200 && gotText === text, `status=${got.status} body=${gotText.slice(0, 40)}`);

  const addGroupFile = await call('POST', '/api/groups/555200/files', {
    token: ta,
    body: { name: '说明.txt', url: up.data.url, size: Buffer.byteLength(text) },
  });
  check('群文件登记', addGroupFile.status === 200 && addGroupFile.data.file?.id > 0, JSON.stringify(addGroupFile.data));
  const groupFiles = await call('GET', '/api/groups/555200/files', { token: tb });
  check(
    '群文件列表可见',
    (groupFiles.data.files || []).some((f) => f.name === '说明.txt' && f.url === up.data.url),
    JSON.stringify(groupFiles.data.files),
  );
  const delFile = await call('DELETE', `/api/groups/555200/files/${addGroupFile.data.file?.id}`, { token: tb });
  const groupFiles2 = await call('GET', '/api/groups/555200/files', { token: tb });
  check('管理员删群文件', delFile.status === 200 && (groupFiles2.data.files || []).length === 0, `status=${delFile.status}`);

  console.log('9. 邀请普通成员与通知');
  const inviteD = await call('POST', '/api/groups/555200/invite', {
    token: ta,
    body: { number: '555004' },
  });
  const dNoti = await call('GET', '/api/notifications', { token: td });
  check(
    '丁收到入群通知',
    inviteD.status === 200 && (dNoti.data.items || []).some((n) => n.type === 'group_invite' && n.group?.number === '555200'),
    JSON.stringify(dNoti.data.items),
  );
  const dInbox = await call('GET', '/api/group-requests', { token: td });
  const dInvite = (dInbox.data.incoming || []).find((x) => x.number === '555200');
  const dAccept = await call('POST', `/api/group-requests/${dInvite?.id}/accept`, { token: td });
  const membersFinal = await call('GET', '/api/groups/555200/members', { token: ta });
  check('丁同意后进群', dAccept.status === 200 && (membersFinal.data.members || []).length === 5, `status=${dAccept.status} n=${membersFinal.data.members?.length}`);

  const cAddA = await call('POST', '/api/friends/request', { token: tc, body: { number: '555001' } });
  const aNoti2 = await call('GET', '/api/notifications', { token: ta });
  check(
    '通知里有好友申请',
    cAddA.status === 200 && (aNoti2.data.items || []).some((n) => n.type === 'friend_request' && n.from?.number === '555003'),
    JSON.stringify(aNoti2.data.items?.map((n) => n.type)),
  );

  console.log('10. 服务器信息');
  const info = await call('GET', '/api/server-info', { token: ta });
  check('服务器版本正确', info.data.version === PKG_VERSION, String(info.data.version));
  check('服务器端口有效', typeof info.data.port === 'number' && info.data.port > 0, String(info.data.port));
  check('局域网地址是数组', Array.isArray(info.data.lanUrls), JSON.stringify(info.data.lanUrls));
  check('Web 资源就绪字段', typeof info.data.webReady === 'boolean', String(info.data.webReady));

  console.log('11. 手机端 APK 下载');
  const apkNoAuth = await call('GET', '/api/apk/info');
  check('未登录拿 APK 信息 401', apkNoAuth.status === 401, String(apkNoAuth.status));
  const apkInfo = await call('GET', '/api/apk/info', { token: ta });
  check('APK 信息带 available 布尔', typeof apkInfo.data.available === 'boolean', JSON.stringify(apkInfo.data));
  check('挑的是版本号最新的包，不是时间最新的旧包', apkInfo.data.name === NEW_APK, String(apkInfo.data.name));
  check(
    'APK 版本跟 package.json 一致',
    apkInfo.data.available ? apkInfo.data.version === PKG_VERSION : true,
    String(apkInfo.data.version),
  );
  const apkRes = await fetch(base + '/apk');
  const apkBuf = Buffer.from(await apkRes.arrayBuffer());
  if (apkInfo.data.available) {
    check(
      'APK 下载 200 且是安装包类型',
      apkRes.status === 200 && (apkRes.headers.get('content-type') || '').includes('android.package-archive'),
      apkRes.status + ' ' + apkRes.headers.get('content-type'),
    );
    check('APK 文件是 zip 且非空', apkBuf.length > 1000 && apkBuf[0] === 0x50 && apkBuf[1] === 0x4b, apkBuf.length + 'B');
  } else {
    // 这台机器上还没打包 APK（连接器版已按用户要求删除）：必须优雅 404 + JSON，不能抛异常
    check(
      '没有 APK 时 /apk 返回 404 JSON',
      apkRes.status === 404 && (apkRes.headers.get('content-type') || '').includes('application/json'),
      apkRes.status + ' ' + apkRes.headers.get('content-type'),
    );
    check('没有 APK 时 404 带中文提示', /还没有打包好的 APK/.test(apkBuf.toString('utf8')), apkBuf.toString('utf8').slice(0, 80));
  }
} finally {
  await app.close();
}

console.log(`\nRAN ${ran}  PASS ${pass}  FAIL ${failures.length}  ERR 0`);
if (failures.length) {
  console.log('失败项：' + failures.join('、'));
  process.exit(1);
}
