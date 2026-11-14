// 端到端测「Bot 内置模型」：配好接口 → 发消息 → Bot 自己回话
// 用一个本地的假模型服务器，不联网、不花钱
import { createServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from '../index.js';
import { openDb } from '../db.js';

const DIR = `.tools/test-model-${process.pid}`;
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

let ran = 0;
let passed = 0;
let failed = 0;
let errors = 0;

function ok(name, cond, extra = '') {
  ran += 1;
  if (cond) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
}

async function main() {
  // ---- 假模型服务器 ----
  let lastAuth = '';
  let lastBody = null;
  let chatHits = 0;
  // 慢模型 / 坏模型的开关：用来测「正在输入」会不会一直挂着、报错有没有收尾
  let delayMs = 0;
  let failMode = false;
  const fake = createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      chatHits += 1;
      lastAuth = req.headers.authorization || '';
      try {
        lastBody = JSON.parse(buf);
      } catch {
        lastBody = null;
      }
      const reply = () => {
        if (failMode) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: '模型炸了' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: '我是娜莉灵，你好呀' } }],
          }),
        );
      };
      if (delayMs > 0) setTimeout(reply, delayMs);
      else reply();
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const fakeBase = `http://127.0.0.1:${fake.address().port}`;

  const db = openDb(`${DIR}/t.db`);
  const app = buildServer({ db, uploadDir: join(DIR, 'uploads') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const call = async (path, { method = 'GET', body, token } = {}) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };

  const owner = await call('/api/register', {
    method: 'POST',
    body: { number: '500001', password: 'fe-test-2026', nickname: '主人' },
  });
  ok('注册主人', owner.status === 200 && !!owner.data.token);
  const ot = owner.data.token;

  const bot = await call('/api/bots', {
    method: 'POST',
    token: ot,
    body: { number: '500002', nickname: '娜莉灵', bio: '小马 Bot' },
  });
  ok('创建 Bot', bot.status === 200 && bot.data.bot.number === '500002');
  const botNum = '500002';
  const botId = bot.data.bot.id;

  // ---- 未配置时 ----
  const empty = await call(`/api/bots/${botNum}/model`, { token: ot });
  ok('未配置时 configured=false', empty.status === 200 && empty.data.config.configured === false);
  ok('未配置时 enabled=false', empty.data.config.enabled === false);

  // ---- 权限 ----
  const noToken = await call(`/api/bots/${botNum}/model`);
  ok('没登录 → 401', noToken.status === 401);

  const other = await call('/api/register', {
    method: 'POST',
    body: { number: '500003', password: 'fe-test-2026', nickname: '路人' },
  });
  const otherGet = await call(`/api/bots/${botNum}/model`, { token: other.data.token });
  ok('不是主人 → 403', otherGet.status === 403);
  const otherPut = await call(`/api/bots/${botNum}/model`, {
    method: 'PUT',
    token: other.data.token,
    body: { model: 'x' },
  });
  ok('不是主人不能改 → 403', otherPut.status === 403);

  const notBot = await call('/api/bots/500001/model', { token: ot });
  ok('对个人号取模型配置 → 404', notBot.status === 404);

  // ---- 保存配置 ----
  const saved = await call(`/api/bots/${botNum}/model`, {
    method: 'PUT',
    token: ot,
    body: {
      base_url: fakeBase,
      api_key: 'sk-test-1234567890',
      model: 'test-model',
      persona: '你是娜莉灵',
      temperature: 0.5,
      enabled: true,
    },
  });
  ok('保存配置成功', saved.status === 200 && saved.data.ok === true);
  ok('保存后 configured=true', saved.data.config.configured === true);
  ok('密钥被打码', saved.data.config.api_key === 'sk-t••••7890', saved.data.config.api_key);
  ok('不回传明文密钥', !JSON.stringify(saved.data).includes('sk-test-1234567890'));

  const reread = await call(`/api/bots/${botNum}/model`, { token: ot });
  ok('重新读取仍是打码', reread.data.config.api_key === 'sk-t••••7890');
  ok('人设保存住了', reread.data.config.persona === '你是娜莉灵');

  // 传打码串回来 = 不改密钥
  const keep = await call(`/api/bots/${botNum}/model`, {
    method: 'PUT',
    token: ot,
    body: { api_key: 'sk-t••••7890', temperature: 0.9 },
  });
  ok('回传打码串保留原密钥', keep.data.config.api_key === 'sk-t••••7890');
  ok('温度改成功', keep.data.config.temperature === 0.9);

  // ---- 连通性测试 ----
  const tested = await call(`/api/bots/${botNum}/model/test`, { method: 'POST', token: ot });
  ok('测试接口返回 ok', tested.status === 200 && tested.data.ok === true, JSON.stringify(tested.data));
  ok('测试拿到了模型回复', tested.data.reply === '我是娜莉灵，你好呀');
  ok('测试带了 Authorization', lastAuth === 'Bearer sk-test-1234567890', lastAuth);
  ok('测试用了配置的模型名', lastBody?.model === 'test-model');

  // ---- 真发一条消息，看 Bot 自己回 ----
  await call('/api/messages', { method: 'POST', token: ot, body: { to: botNum, body: '你好呀' } });

  let botReply = null;
  for (let i = 0; i < 50; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const convs = await call('/api/conversations', { token: ot });
    const conv = convs.data.conversations.find((c) => c.peer && c.peer.number === botNum);
    if (!conv) continue;
    const msgs = await call(`/api/conversations/${conv.id}/messages`, { token: ot });
    const found = msgs.data.messages.find((m) => m.mine === false);
    if (found) {
      botReply = found;
      break;
    }
  }
  ok('Bot 自己回话了', !!botReply, botReply ? '' : '5 秒内没有收到 Bot 的消息');
  ok('回复内容来自模型', botReply?.body === '我是娜莉灵，你好呀', botReply?.body);
  ok('回复是对方发的（不是我自己）', botReply?.mine === false);

  // 历史里应该同时有「用户那句」和系统人设
  const sysMsg = lastBody?.messages?.[0];
  ok('请求带了 system 人设', sysMsg?.role === 'system' && sysMsg.content.includes('娜莉灵'));

  // ---- 关掉开关就不回 ----
  await call(`/api/bots/${botNum}/model`, { method: 'PUT', token: ot, body: { enabled: false } });
  const beforeHits = chatHits;
  await call('/api/messages', { method: 'POST', token: ot, body: { to: botNum, body: '再试一次' } });
  await new Promise((r) => setTimeout(r, 1200));
  ok('关掉开关后不再调用模型', chatHits === beforeHits, `多调了 ${chatHits - beforeHits} 次`);

  // ---- 清空密钥 ----
  const cleared = await call(`/api/bots/${botNum}/model`, {
    method: 'PUT',
    token: ot,
    body: { api_key: '' },
  });
  ok('空串清空密钥', cleared.data.config.has_key === false);
  ok('清空后 configured=false', cleared.data.config.configured === false);

  // ---- 慢模型：15 秒 ttl 撑不住，心跳必须一直续期 ----
  await call(`/api/bots/${botNum}/model`, {
    method: 'PUT',
    token: ot,
    body: { api_key: 'sk-test-1234567890', enabled: true },
  });
  const convList = await call('/api/conversations', { token: ot });
  const slowConv = convList.data.conversations.find((c) => c.peer && c.peer.number === botNum);
  ok('找到与 Bot 的会话', !!slowConv);

  const beforeIds = await call(`/api/conversations/${slowConv.id}/messages`, { token: ot });
  const lastIdBefore = Math.max(0, ...(beforeIds.data.messages || []).map((m) => m.id));

  delayMs = 17000;
  const slowStart = Date.now();
  await call('/api/messages', { method: 'POST', token: ot, body: { to: botNum, body: '慢一点回我' } });

  await new Promise((r) => setTimeout(r, 3000));
  const t3 = await call(`/api/conversations/${slowConv.id}/messages`, { token: ot });
  ok('慢模型 3 秒时显示「正在输入」', (t3.data.typing || []).length === 1, JSON.stringify(t3.data.typing));
  ok('typing 带 type=bot（前端据此显示「正在思考」）', t3.data.typing?.[0]?.type === 'bot', JSON.stringify(t3.data.typing));

  await new Promise((r) => setTimeout(r, 13000));
  const t16 = await call(`/api/conversations/${slowConv.id}/messages`, { token: ot });
  const waited = Math.round((Date.now() - slowStart) / 1000);
  ok(`慢模型 ${waited} 秒时提示仍然在（心跳续期生效）`, (t16.data.typing || []).length === 1, JSON.stringify(t16.data.typing));

  let slowReply = null;
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 400));
    const msgs = await call(`/api/conversations/${slowConv.id}/messages`, { token: ot });
    const found = (msgs.data.messages || []).find((m) => m.mine === false && m.id > lastIdBefore);
    if (found) {
      slowReply = found;
      break;
    }
  }
  ok('慢模型最终也把回复送到了', !!slowReply, slowReply ? '' : '超时没收到');
  ok('慢模型回复内容正确', slowReply?.body === '我是娜莉灵，你好呀', slowReply?.body);

  const afterSlow = await call(`/api/conversations/${slowConv.id}/messages`, { token: ot });
  ok('回复落地后提示立刻消失（不是等 15 秒自然过期）', (afterSlow.data.typing || []).length === 0, JSON.stringify(afterSlow.data.typing));

  // ---- 坏模型：必须有可见收尾，不能静默卡住 ----
  delayMs = 0;
  failMode = true;
  const beforeFail = await call(`/api/conversations/${slowConv.id}/messages`, { token: ot });
  const lastIdBeforeFail = Math.max(0, ...(beforeFail.data.messages || []).map((m) => m.id));
  await call('/api/messages', { method: 'POST', token: ot, body: { to: botNum, body: '你还在吗' } });
  let failNote = null;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    const msgs = await call(`/api/conversations/${slowConv.id}/messages`, { token: ot });
    const found = (msgs.data.messages || []).find((m) => m.mine === false && m.id > lastIdBeforeFail);
    if (found) {
      failNote = found;
      break;
    }
  }
  ok('模型报错时 Bot 会发一条提示', !!failNote, failNote ? '' : '10 秒内没有任何收尾');
  ok('提示文案是「没接上话」', (failNote?.body || '').includes('没接上话'), failNote?.body);
  const afterFail = await call(`/api/conversations/${slowConv.id}/messages`, { token: ot });
  ok('报错后「正在输入」也收掉了', (afterFail.data.typing || []).length === 0, JSON.stringify(afterFail.data.typing));
  failMode = false;

  await app.close();
  fake.close();
  db.close();
  rmSync(DIR, { recursive: true, force: true });
}

main()
  .catch((err) => {
    errors += 1;
    console.error('  ERR', err);
  })
  .finally(() => {
    console.log(`\nRAN ${ran} PASS ${passed} FAIL ${failed} ERR ${errors}`);
    process.exit(failed + errors ? 1 : 0);
  });
