/**
 * OneBot 11 兼容层增强测试（v0.10.3）。
 *
 * 覆盖 0.10.2 之前完全缺失、导致 AstrBot「指令用不了」的那批能力：
 * 合并转发（收/发）、消息段（at / reply / image）、媒体落盘、群管理 action、
 * 未知 action 的 1404 回执，以及 Bot 收到消息时的「正在输入」。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { buildServer } from '../index.js';
import { openDb } from '../db.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  ' + detail : ''));
}

const dir = join(process.cwd(), '.tools', 'test-onebot-plus-' + process.pid);
mkdirSync(dir, { recursive: true });
const db = openDb(join(dir, 'test.db'));
const app = buildServer({ db, uploadDir: join(dir, 'uploads') });
await app.listen({ port: 0, host: '127.0.0.1' });
const port = app.server.address().port;
const base = 'http://127.0.0.1:' + port;

async function call(method, path, { body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const inbox = [];
let echoSeq = 0;
const pending = new Map();

function waitFor(pred, ms = 3000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const hit = inbox.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - started > ms) return resolve(null);
      setTimeout(tick, 50);
    };
    tick();
  });
}

try {
  /* ---------- 准备：主人 + Bot + 群 ---------- */
  const reg = await call('POST', '/api/register', {
    body: { number: '111111', password: 'password123', nickname: '主人' },
  });
  check('注册主人 111111', reg.status === 200, 'status=' + reg.status);
  const userToken = reg.data.token;

  const botRes = await call('POST', '/api/bots', {
    token: userToken,
    body: { number: '222222', nickname: '小马' },
  });
  check('创建 Bot 222222', botRes.status === 200 && !!botRes.data.bot?.token, 'status=' + botRes.status);
  const botToken = botRes.data.bot.token;

  const groupRes = await call('POST', '/api/groups', {
    token: userToken,
    body: { number: '444444', name: '测试群' },
  });
  check('建群 444444', groupRes.status === 200, 'status=' + groupRes.status);
  const groupConvId = groupRes.data.conversationId;

  const botRow = db.prepare('SELECT * FROM accounts WHERE number = ?').get('222222');
  const reg2 = await call('POST', '/api/register', {
    body: { number: '333333', password: 'password123', nickname: '普通成员' },
  });
  const memberToken = reg2.data.token;
  const join2 = await call('POST', '/api/groups/444444/join', { token: memberToken });
  check('普通成员 333333 进群', join2.status === 200, 'status=' + join2.status);

  const groupRow = db.prepare('SELECT * FROM groups WHERE number = ?').get('444444');
  db.prepare('INSERT OR IGNORE INTO group_members (group_id, account_id, role, joined_at) VALUES (?, ?, ?, ?)').run(
    groupRow.id,
    botRow.id,
    'admin',
    Date.now(),
  );
  db.prepare(
    'INSERT OR IGNORE INTO conversation_members (conversation_id, account_id, last_read_id, pinned, muted) VALUES (?, ?, 0, 0, 0)',
  ).run(groupConvId, botRow.id);
  check('Bot 入群（测试直写库）', true);

  /* ---------- 连上 WS ---------- */
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/onebot/v11/ws?access_token=' + botToken);
  ws.on('message', (raw) => {
    let evt = null;
    try {
      evt = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    if (evt.echo !== undefined && pending.has(evt.echo)) {
      const fn = pending.get(evt.echo);
      pending.delete(evt.echo);
      fn(evt);
      return;
    }
    inbox.push(evt);
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  check('WS 用 Bot token 连上', ws.readyState === 1);

  function act(action, params = {}) {
    const echo = 'e' + ++echoSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(echo);
        reject(new Error('action 超时：' + action));
      }, 8000);
      pending.set(echo, (evt) => {
        clearTimeout(timer);
        resolve(evt);
      });
      ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  await new Promise((r) => setTimeout(r, 150));

  /* ---------- 1. 合并转发（出站） ---------- */
  const fwd = await act('send_private_forward_msg', {
    user_id: 111111,
    messages: [
      { type: 'node', data: { user_id: '111111', nickname: '主人', content: [{ type: 'text', data: { text: '第一条' } }] } },
      { type: 'node', data: { user_id: '111111', nickname: '主人', content: [{ type: 'text', data: { text: '第二条' } }] } },
    ],
  });
  check('send_private_forward_msg 返回 ok', fwd.status === 'ok', JSON.stringify(fwd).slice(0, 120));
  check('合并转发返回数字 message_id', typeof fwd.data?.message_id === 'number', String(fwd.data?.message_id));

  const dmRow = db
    .prepare("SELECT * FROM conversations WHERE kind = 'dm' ORDER BY id DESC LIMIT 1")
    .get();
  const lastDm = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(dmRow.id);
  check('合并消息落库 kind=merge', lastDm?.kind === 'merge', lastDm?.kind);
  const mergeMeta = JSON.parse(lastDm?.meta || '{}');
  check('合并消息带 2 条节点', mergeMeta.count === 2 && mergeMeta.items?.length === 2, JSON.stringify(mergeMeta.count));

  const gotFwd = await act('get_forward_msg', { id: lastDm.id });
  check('get_forward_msg 读回 2 条', gotFwd.status === 'ok' && gotFwd.data?.messages?.length === 2, String(gotFwd.data?.messages?.length));

  const groupFwd = await act('send_group_forward_msg', {
    group_id: 444444,
    messages: [
      { type: 'node', data: { user_id: '222222', nickname: '小马', content: [{ type: 'text', data: { text: '群里的合并' } }] } },
    ],
  });
  check('send_group_forward_msg 返回 ok', groupFwd.status === 'ok', JSON.stringify(groupFwd).slice(0, 120));
  const lastGroup = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1')
    .get(groupConvId);
  check('群里出现合并消息', lastGroup?.kind === 'merge', lastGroup?.kind);

  /* ---------- 2. 消息段：图片 / @ / 引用 ---------- */
  const imgMsg = await act('send_private_msg', {
    user_id: 111111,
    message: [{ type: 'image', data: { file: 'base64://' + PNG_1PX } }],
  });
  check('发图片返回 ok', imgMsg.status === 'ok', JSON.stringify(imgMsg).slice(0, 120));
  const imgRow = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(imgMsg.data?.message_id));
  check('图片消息 kind=image', imgRow?.kind === 'image', imgRow?.kind);
  check('图片落到 /uploads', String(imgRow?.body || '').startsWith('/uploads/'), imgRow?.body);
  const imgRes = await fetch(base + imgRow.body);
  check('图片地址可访问', imgRes.status === 200, 'status=' + imgRes.status);
  check('图片 Content-Type 正确', (imgRes.headers.get('content-type') || '').includes('image/png'), imgRes.headers.get('content-type'));

  const firstDmMsg = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 1')
    .get(dmRow.id);
  const replyMsg = await act('send_private_msg', {
    user_id: 111111,
    message: [
      { type: 'reply', data: { id: String(firstDmMsg.id) } },
      { type: 'at', data: { qq: '111111' } },
      { type: 'text', data: { text: '引用加艾特' } },
    ],
  });
  const replyRow = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(replyMsg.data?.message_id));
  check('引用段落库 reply_to_id', replyRow?.reply_to_id === firstDmMsg.id, String(replyRow?.reply_to_id));
  const replyMeta = JSON.parse(replyRow?.meta || '{}');
  check('艾特段保留在 meta.mentions', Array.isArray(replyMeta.mentions) && replyMeta.mentions[0] === '111111', JSON.stringify(replyMeta));
  check('正文没有被 CQ 码污染', replyRow?.body === '引用加艾特', replyRow?.body);

  /* ---------- 3. 群管理 action ---------- */
  const memberList = await act('get_group_member_list', { group_id: 444444 });
  check(
    'get_group_member_list 有 3 人',
    memberList.status === 'ok' && memberList.data?.length === 3,
    String(memberList.data?.length),
  );
  const groupInfo = await act('get_group_info', { group_id: 444444 });
  check('get_group_info 群名正确', groupInfo.data?.group_name === '测试群', groupInfo.data?.group_name);

  const card = await act('set_group_card', { group_id: 444444, user_id: 111111, card: '群主大人' });
  check('set_group_card 返回 ok', card.status === 'ok');
  const memberInfo = await act('get_group_member_info', { group_id: 444444, user_id: 111111 });
  check('群名片已写入', memberInfo.data?.card === '群主大人', memberInfo.data?.card);

  const ban = await act('set_group_ban', { group_id: 444444, user_id: 333333, duration: 300 });
  check('set_group_ban 返回 ok', ban.status === 'ok');
  const mutedSend = await call('POST', '/api/groups/444444/messages', { token: memberToken, body: { body: '我被禁言了吗' } });
  check('被禁言后发不出消息 403', mutedSend.status === 403, 'status=' + mutedSend.status);
  await act('set_group_ban', { group_id: 444444, user_id: 333333, duration: 0 });
  const unmutedSend = await call('POST', '/api/groups/444444/messages', { token: memberToken, body: { body: '解禁了' } });
  check('解除禁言后能发', unmutedSend.status === 200, 'status=' + unmutedSend.status);

  await act('set_group_whole_ban', { group_id: 444444, enable: true });
  const wholeBanSend = await call('POST', '/api/groups/444444/messages', { token: memberToken, body: { body: '全员禁言中' } });
  check('全员禁言时普通成员 403', wholeBanSend.status === 403, 'status=' + wholeBanSend.status);
  await act('set_group_whole_ban', { group_id: 444444, enable: false });
  const afterWhole = await call('POST', '/api/groups/444444/messages', { token: memberToken, body: { body: '又能说了' } });
  check('关闭全员禁言后能发', afterWhole.status === 200, 'status=' + afterWhole.status);

  const notice = await act('send_group_notice', { group_id: 444444, content: '本周六晚八点活动' });
  check('send_group_notice 返回 ok', notice.status === 'ok');
  const noticeRead = await act('get_group_notice', { group_id: 444444 });
  check(
    'get_group_notice 读得到公告',
    noticeRead.data?.notices?.[0]?.message?.text === '本周六晚八点活动',
    JSON.stringify(noticeRead.data?.notices?.[0]?.message),
  );

  const renameByBot = await act('set_group_name', { group_id: 444444, group_name: '机器人想改' });
  check('非群主改群名 1403', renameByBot.retcode === 1403, String(renameByBot.retcode));

  /* ---------- 4. 撤回与历史 ---------- */
  const recalled = await act('delete_msg', { message_id: Number(imgMsg.data?.message_id) });
  check('delete_msg 返回 ok', recalled.status === 'ok');
  const recalledRow = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(imgMsg.data?.message_id));
  check('撤回后 recalled=1', recalledRow?.recalled === 1, String(recalledRow?.recalled));

  const gotMsg = await act('get_msg', { message_id: Number(lastGroup.id) });
  check('get_msg 返回 group 类型', gotMsg.data?.message_type === 'group', gotMsg.data?.message_type);

  const history = await act('get_group_msg_history', { group_id: 444444, count: 10 });
  check('get_group_msg_history 有消息', history.status === 'ok' && (history.data?.messages || []).length > 0, String(history.data?.messages?.length));

  const readAck = await act('mark_msg_as_read', { message_id: Number(lastGroup.id) });
  check('mark_msg_as_read 返回 ok', readAck.status === 'ok');

  /* ---------- 5. 媒体与能力查询 ---------- */
  const canImg = await act('can_send_image');
  check('can_send_image 现在返回 yes', canImg.data?.yes === true, JSON.stringify(canImg.data));
  const getImg = await act('get_image', { file: 'base64://' + PNG_1PX });
  check('get_image 返回 /uploads 地址', String(getImg.data?.file || '').startsWith('/uploads/'), getImg.data?.file);

  const friends = await act('get_friend_list');
  check(
    'get_friend_list 里有主人',
    friends.status === 'ok' && (friends.data || []).some((f) => f.user_id === 111111),
    JSON.stringify(friends.data),
  );

  const versionInfo = await act('get_version_info');
  check('get_version_info 报得出产品名', versionInfo.data?.app_name === 'Furry Everpony', versionInfo.data?.app_name);

  /* ---------- 6. 群文件 ---------- */
  const localFile = join(dir, '说明.txt');
  writeFileSync(localFile, '这是群文件测试内容', 'utf8');
  const up = await act('upload_group_file', { group_id: 444444, file: localFile, name: '说明.txt' });
  check('upload_group_file 返回 ok', up.status === 'ok', JSON.stringify(up).slice(0, 120));
  const fileList = await act('get_group_root_files', { group_id: 444444 });
  check(
    '群文件列表里有它',
    (fileList.data?.files || []).some((f) => f.file_name === '说明.txt'),
    JSON.stringify(fileList.data?.files?.map((f) => f.file_name)),
  );
  const fileUrl = await act('get_group_file_url', { group_id: 444444, file_id: String(up.data?.file_id) });
  check('get_group_file_url 返回 /uploads', String(fileUrl.data?.url || '').includes('/uploads/'), fileUrl.data?.url);

  /* ---------- 7. 正在输入 ---------- */
  const dmConv = db
    .prepare("SELECT c.id FROM conversations c JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.account_id = ? JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.account_id = ? WHERE c.kind = 'dm' LIMIT 1")
    .get(botRow.id, db.prepare('SELECT id FROM accounts WHERE number = ?').get('111111').id);
  await call('POST', '/api/messages', { token: userToken, body: { to: '222222', body: '你在吗' } });
  await new Promise((r) => setTimeout(r, 150));
  const typed = await call('GET', '/api/conversations/' + dmConv.id + '/messages', { token: userToken });
  check(
    'Bot 收到消息后用户看到「正在输入」',
    (typed.data?.typing || []).some((t) => t.number === '222222'),
    JSON.stringify(typed.data?.typing),
  );
  await act('send_private_msg', { user_id: 111111, message: [{ type: 'text', data: { text: '我在' } }] });
  const typedAfter = await call('GET', '/api/conversations/' + dmConv.id + '/messages', { token: userToken });
  check(
    'Bot 回话后「正在输入」消失',
    !(typedAfter.data?.typing || []).some((t) => t.number === '222222'),
    JSON.stringify(typedAfter.data?.typing),
  );

  /* ---------- 7b. Bot 自己声明输入状态（set_input_status） ---------- */
  const typingIn = async (convId) => {
    const r = await call('GET', '/api/conversations/' + convId + '/messages', { token: userToken });
    return (r.data?.typing || []).filter((t) => t.number === '222222');
  };
  const ts1 = await act('set_input_status', { user_id: 111111 });
  check('set_input_status 私聊返回 ok', ts1.status === 'ok', JSON.stringify(ts1).slice(0, 120));
  const dmTyping = await typingIn(dmConv.id);
  check('私聊：Bot 声明后用户看到它在输入', dmTyping.length === 1, JSON.stringify(dmTyping));
  check('输入状态标明是 Bot 自己发的', dmTyping[0]?.type === 'bot', JSON.stringify(dmTyping[0]));
  const ts2 = await act('set_input_status', { user_id: 111111, event_type: 2 });
  check('set_input_status 停止返回 ok', ts2.status === 'ok', JSON.stringify(ts2).slice(0, 120));
  const dmTypingStop = await typingIn(dmConv.id);
  check('私聊：Bot 声明停止后提示消失', dmTypingStop.length === 0, JSON.stringify(dmTypingStop));
  const ts3 = await act('set_input_status', { group_id: 444444 });
  check('set_input_status 群聊返回 ok', ts3.status === 'ok', JSON.stringify(ts3).slice(0, 120));
  const gTyping = await typingIn(groupConvId);
  check('群聊：Bot 声明后群里看得到', gTyping.length === 1, JSON.stringify(gTyping));
  await act('set_input_status', { group_id: 444444, event_type: 2 });
  const gTypingStop = await typingIn(groupConvId);
  check('群聊：停止后消失', gTypingStop.length === 0, JSON.stringify(gTypingStop));
  const tsBad = await act('set_input_status', { user_id: 999999 });
  check('对不存在的人声明输入 1404', tsBad.retcode === 1404, tsBad.wording);
  const tsNoParam = await act('set_input_status', {});
  check('不给人也不给群 1404', tsNoParam.retcode === 1404, tsNoParam.wording);

  /* ---------- 8. 错误回执 ---------- */
  const noNumber = await act('send_private_msg', { user_id: 999999, message: [{ type: 'text', data: { text: '喂' } }] });
  check('发到不存在的号码 1404', noNumber.retcode === 1404 && /不存在/.test(noNumber.wording || ''), noNumber.wording);
  const noGroup = await act('send_group_msg', { group_id: 999999, message: [{ type: 'text', data: { text: '喂' } }] });
  check('发到不存在的群 1404', noGroup.retcode === 1404 && /群不存在/.test(noGroup.wording || ''), noGroup.wording);
  const unknown = await act('nonexistent_action');
  check('未知 action 回 1404 并说明', unknown.retcode === 1404 && /不支持的操作/.test(unknown.wording || ''), unknown.wording);
  const strangerInfo = await act('get_group_member_info', { group_id: 444444, user_id: 999999 });
  check('查不存在的成员 1404', strangerInfo.retcode === 1404, String(strangerInfo.retcode));

  /* ---------- 9. 鉴权 ---------- */
  const noToken = await new Promise((resolve) => {
    const bad = new WebSocket('ws://127.0.0.1:' + port + '/onebot/v11/ws');
    bad.on('open', () => {
      bad.close();
      resolve('open');
    });
    bad.on('error', () => resolve('rejected'));
  });
  check('无 token 被拒绝', noToken === 'rejected', noToken);

  ws.close();
} catch (e) {
  console.error('ERR', e && e.stack);
  results.push({ name: '异常中断', ok: false });
} finally {
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log('');
  console.log('RAN ' + results.length + '  PASS ' + pass + '  FAIL ' + fail + '  ERR 0');
  await app.close();
  process.exit(fail ? 1 : 0);
}
