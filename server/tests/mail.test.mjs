import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import tls from 'node:tls';
import { openDb } from '../db.js';
import { describeMailConfig, readMailConfig } from '../mail-config.js';
import { mailFailure, sendMail } from '../mail.js';
import { loopbackCertificate, loopbackSmtp } from './mail-fixture.mjs';

/* 运行：node --test server/tests/mail.test.mjs。只使用回环、内存库和隔离的临时上传目录。 */
const temp = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.mail-run-'));
const previousDb = process.env.FE_DB;
process.env.FE_DB = join(temp, 'unused.sqlite');
const { buildServer } = await import('../index.js');
after(() => {
  if (previousDb === undefined) delete process.env.FE_DB;
  else process.env.FE_DB = previousDb;
  rmSync(temp, { recursive: true, force: true });
});
const certificate = loopbackCertificate();
const defaultCAs = tls.getCACertificates('default');
tls.setDefaultCACertificates([...defaultCAs, certificate.cert]);
after(() => tls.setDefaultCACertificates(defaultCAs));

const syntheticSender = 'sender@example.invalid';
const syntheticRecipient = 'recipient@example.invalid';
const syntheticAuthorization = 'local-fixture-only';
const syntheticBody = '回环测试邮件。';
const mail = { to: syntheticRecipient, subject: '测试', text: syntheticBody };
const config = (port, secure = true) => ({ host: '127.0.0.1', port, secure, user: syntheticSender, pass: syntheticAuthorization, from: '', fromName: 'Everony' });
const codes = (state) => state.issues.map(({ code }) => code);
const expectMailFailure = (promise, code, smtpStatus) => assert.rejects(promise, (err) => {
  const outcome = mailFailure(err);
  assert.equal(outcome.code, code);
  assert.equal(outcome.smtpStatus, smtpStatus);
  assert.equal(outcome.error.includes('INTERNAL-SHOULD-NOT-LEAK'), false);
  return true;
});
const bodyOf = (message) => {
  assert.equal(typeof message, 'string', '回环应该收到邮件');
  return Buffer.from(message.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
};

test('区分 465 直连、587 STARTTLS、缺授权码、发件人和非法端口', () => {
  const setting = (values) => readMailConfig((key, fallback) => values[key] ?? fallback);
  assert.equal(setting({ smtpPort: '465' }).secure, true);
  assert.equal(setting({ smtpPort: '587' }).secure, false);
  assert.equal(describeMailConfig(config(465)).ready, true);
  assert.equal(describeMailConfig(config(587, false)).ready, true);
  assert.deepEqual(codes(describeMailConfig(config(465, false))), ['SMTP_PORT_MODE_MISMATCH']);
  assert.deepEqual(codes(describeMailConfig(config(587))), ['SMTP_PORT_MODE_MISMATCH']);
  assert.deepEqual(codes(describeMailConfig({ ...config(465), pass: '  ' })), ['SMTP_AUTHORIZATION_REQUIRED']);
  assert.deepEqual(codes(describeMailConfig({ ...config(465), user: '', pass: '' })), ['SMTP_SENDER_REQUIRED']);
  assert.deepEqual(codes(describeMailConfig({ ...config(465), port: 0 })), ['SMTP_PORT_INVALID']);
});

test('465 式 TLS 直连通过认证并写入回环收件箱', async (t) => {
  const smtp = await loopbackSmtp(t, certificate);
  assert.deepEqual(await sendMail(config(smtp.port), mail), { ok: true });
  assert.deepEqual(smtp.events, ['ehlo-tls', 'auth-tls', 'mail-tls', 'rcpt', 'accepted']);
  assert.equal(bodyOf(smtp.messages[0]) === syntheticBody, true);
});

test('587 式 STARTTLS 先升级并重新 EHLO，之后才认证和发信', async (t) => {
  const smtp = await loopbackSmtp(t, certificate, { mode: 'starttls' });
  assert.deepEqual(await sendMail(config(smtp.port, false), mail), { ok: true });
  assert.deepEqual(smtp.events, ['ehlo-clear', 'starttls', 'ehlo-tls', 'auth-tls', 'mail-tls', 'rcpt', 'accepted']);
});

test('无 STARTTLS 广告的服务器不会收到认证信息或邮件', async (t) => {
  const smtp = await loopbackSmtp(t, certificate, { mode: 'clear' });
  await expectMailFailure(sendMail(config(smtp.port, false), mail), 'SMTP_STARTTLS_REQUIRED');
  assert.deepEqual(smtp.events, ['ehlo-clear']);
  assert.equal(smtp.messages.length, 0);
});

test('STARTTLS 升级被拒绝不会降级到明文', async (t) => {
  const smtp = await loopbackSmtp(t, certificate, { mode: 'starttls', failAt: 'starttls' });
  await expectMailFailure(sendMail(config(smtp.port, false), mail), 'SMTP_STARTTLS_REJECTED', 454);
  assert.deepEqual(smtp.events, ['ehlo-clear', 'starttls']);
});

test('不信任的 TLS 证书被拒绝，未触发 SMTP 认证', async (t) => {
  const untrusted = loopbackCertificate();
  const smtp = await loopbackSmtp(t, untrusted);
  await expectMailFailure(sendMail(config(smtp.port), mail), 'SMTP_TLS_FAILED');
  assert.deepEqual(smtp.events, []);
});

test('未收到问候响应时按总超时结束', async (t) => {
  const smtp = await loopbackSmtp(t, certificate, { failAt: 'greeting-timeout' });
  await expectMailFailure(sendMail(config(smtp.port), mail, { timeoutMs: 200 }), 'SMTP_TIMEOUT');
  assert.equal(smtp.messages.length, 0);
});

test('TLS 中继可明确使用免认证，缺 AUTH LOGIN 则拒绝有认证的配置', async (t) => {
  const smtp = await loopbackSmtp(t, certificate, { auth: false });
  await expectMailFailure(sendMail(config(smtp.port), mail), 'SMTP_AUTH_UNSUPPORTED');
  assert.deepEqual(await sendMail({ ...config(smtp.port), user: '', pass: '', from: syntheticSender }, mail), { ok: true });
  assert.equal(smtp.events.includes('auth-tls'), false);
  assert.equal(smtp.messages.length, 1);
});

for (const [phase, code, status] of [
  ['auth', 'SMTP_AUTH_REJECTED', 535],
  ['sender', 'SMTP_SENDER_REJECTED', 550],
  ['recipient', 'SMTP_RECIPIENT_REJECTED', 550],
  ['message', 'SMTP_MESSAGE_REJECTED', 554],
]) {
  test('供应商阶段拒绝：' + code, async (t) => {
    const smtp = await loopbackSmtp(t, certificate, { failAt: phase });
    await expectMailFailure(sendMail(config(smtp.port), mail), code, status);
    assert.equal(smtp.messages.length, 0);
  });
}

async function isolatedApi(t) {
  const dir = mkdtempSync(join(temp, 'api-'));
  const db = openDb(':memory:');
  const warnings = [];
  const log = { info() {}, debug() {}, error() {}, warn(...args) { warnings.push(args); } };
  const app = buildServer({ db, uploadDir: dir, log });
  t.after(async () => {
    try { await app.close(); } finally { db.close(); }
  });
  const request = (method, url, payload, token) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }),
    ...(token ? { headers: { authorization: 'Bearer ' + token } } : {}), remoteAddress: '127.0.0.1' });
  let number = 80000000;
  const register = async (email, extra = {}) => {
    const captchaResponse = await request('GET', '/api/captcha');
    assert.equal(captchaResponse.statusCode, 200);
    const challenge = captchaResponse.json();
    const captcha = [...challenge.svg.matchAll(/<text[^>]*>([A-Z2-9])<\/text>/g)].map((match) => match[1]).join('');
    return request('POST', '/api/register', {
      email, number: String(number++), nickname: '本地测试', password: 'local-only-test-password', captchaId: challenge.id, captcha, ...extra,
    });
  };
  const bootstrap = async () => {
    const reply = await register('admin@example.invalid');
    assert.equal(reply.statusCode, 200);
    assert.equal(reply.json().account.is_admin, true);
    assert.equal(typeof reply.json().token, 'string');
    return reply.json().token;
  };
  const patch = (token, fields) => request('PATCH', '/api/admin/site', fields, token);
  const setup = (token, smtp, secure = true) => patch(token, {
    smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSecure: secure, smtpUser: syntheticSender, smtpPass: syntheticAuthorization,
  });
  return { db, request, register, bootstrap, patch, setup, warnings };
}

const statusCode = (reply, status, errorCode) => {
  assert.equal(reply.statusCode, status);
  if (errorCode) assert.equal(reply.json().code, errorCode);
};
const extractCode = (smtp) => {
  const code = bodyOf(smtp.messages.at(-1)).match(/验证码是 (\d{6})，/)?.[1];
  assert.equal(typeof code, 'string', '本地测试邮件应包含六位验证码');
  return code;
};

test('空库兼容首位站长；未配置时公开状态不冒充就绪且不降邮箱门禁', async (t) => {
  const f = await isolatedApi(t);
  const site = () => f.request('GET', '/api/site');
  let res = await site();
  statusCode(res, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.json().registerBootstrap, true);
  assert.equal(res.json().emailCodeAvailable, false);
  statusCode(await f.request('POST', '/api/email-code', { email: syntheticRecipient }), 403, 'EMAIL_GATE_DISABLED');
  const admin = await f.bootstrap();
  res = await site();
  assert.equal(res.json().registerGate, 'email');
  assert.equal(res.json().registerBootstrap, false);
  assert.equal(res.json().smtpReady, false);
  assert.equal(res.json().emailCodeAvailable, false);
  assert.match(res.json().emailCodeUnavailableReason, /管理员/);
  statusCode(await f.request('POST', '/api/email-code', { email: syntheticRecipient }), 503, 'SMTP_UNAVAILABLE');
  statusCode(await f.register(syntheticRecipient, { invite: 'ONLYINVITE' }), 503, 'SMTP_UNAVAILABLE');
  statusCode(await f.request('POST', '/api/admin/site/test-mail', { to: syntheticRecipient }, admin), 503, 'SMTP_HOST_REQUIRED');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM email_codes').get().n, 0);
});

test('管理站点 GET/PATCH/试发均拒绝匿名和普通用户', async (t) => {
  const f = await isolatedApi(t);
  const admin = await f.bootstrap();
  statusCode(await f.patch(admin, { registerGate: 'none' }), 200);
  const reply = await f.register(syntheticRecipient);
  statusCode(reply, 200);
  const member = reply.json().token;
  for (const [method, url, payload] of [['GET', '/api/admin/site'], ['PATCH', '/api/admin/site', {}], ['POST', '/api/admin/site/test-mail', { to: syntheticRecipient }]]) {
    statusCode(await f.request(method, url, payload), 401);
    statusCode(await f.request(method, url, payload, member), 403);
  }
});

test('保存与读取不回显授权码，端口与模式冲突不落盘，旧授权码不可跨主机复用', async (t) => {
  const f = await isolatedApi(t);
  const admin = await f.bootstrap();
  let reply = await f.patch(admin, { smtpHost: '127.0.0.1', smtpPort: 465, smtpSecure: true, smtpUser: syntheticSender });
  statusCode(reply, 200);
  assert.equal(reply.json().smtpReady, false);
  assert.equal(reply.json().smtpIssues.some((issue) => issue.code === 'SMTP_AUTHORIZATION_REQUIRED'), true);
  reply = await f.patch(admin, { smtpPass: syntheticAuthorization });
  statusCode(reply, 200);
  assert.equal(reply.json().smtpReady, true);
  assert.equal(reply.body.includes(syntheticAuthorization), false);
  statusCode(await f.patch(admin, { smtpPort: 587 }), 400, 'SMTP_PORT_MODE_MISMATCH');
  statusCode(await f.patch(admin, { smtpHost: 'changed.example.invalid' }), 400, 'SMTP_REAUTHORIZE_REQUIRED');
  statusCode(await f.patch(admin, { smtpHost: 'https://example.invalid' }), 400, 'SITE_SETTINGS_INVALID');
  reply = await f.patch(admin, { smtpFromName: '新名称', smtpPass: '' });
  statusCode(reply, 200);
  assert.equal(reply.json().smtp.hasPass, true);
  const privateSite = await f.request('GET', '/api/admin/site', undefined, admin);
  assert.equal(privateSite.json().smtp.port, 465);
  assert.equal(privateSite.body.includes(syntheticAuthorization), false);
  const publicSite = await f.request('GET', '/api/site');
  assert.equal(Object.hasOwn(publicSite.json(), 'smtp'), false);
  for (const hidden of [syntheticSender, syntheticAuthorization, '127.0.0.1']) {
    assert.equal(publicSite.body.includes(hidden), false);
  }
  statusCode(await f.patch(admin, { smtpClearPass: true, smtpPass: syntheticAuthorization }), 400, 'SMTP_AUTHORIZATION_CONFLICT');
  reply = await f.patch(admin, { smtpClearPass: true });
  statusCode(reply, 200);
  assert.equal(reply.json().smtp.hasPass, false);
  assert.equal(reply.json().smtpReady, false);
});

test('试发必须明确收件邮箱；管理台安全区分投递成功与服务商拒绝', async (t) => {
  const smtp = await loopbackSmtp(t, certificate);
  const f = await isolatedApi(t);
  const admin = await f.bootstrap();
  statusCode(await f.setup(admin, smtp), 200);
  const attempt = (body) => f.request('POST', '/api/admin/site/test-mail', body, admin);
  statusCode(await attempt({}), 400, 'EMAIL_INVALID');
  assert.equal(smtp.events.length, 0);
  const success = await attempt({ to: syntheticRecipient });
  statusCode(success, 200);
  assert.deepEqual(success.json(), { ok: true });
  assert.equal(smtp.messages.length, 1);
  smtp.state.failAt = 'auth';
  const fail = await attempt({ to: syntheticRecipient });
  statusCode(fail, 502, 'SMTP_AUTH_REJECTED');
  assert.equal(fail.json().smtpStatus, 535);
  assert.equal(/INTERNAL-SHOULD-NOT-LEAK|example\.invalid|local-fixture-only/.test(fail.body + JSON.stringify(f.warnings)), false);
  assert.equal(smtp.messages.length, 1);
});

test('STARTTLS 发码→为错误码计数→正确注册，同邮件仅一个有效码', async (t) => {
  const smtp = await loopbackSmtp(t, certificate, { mode: 'starttls' });
  const f = await isolatedApi(t);
  const admin = await f.bootstrap();
  statusCode(await f.setup(admin, smtp, false), 200);
  const website = await f.request('GET', '/api/site');
  assert.equal(website.json().emailCodeAvailable, true);
  assert.equal(website.json().emailCodeUnavailableReason, null);
  const mailCode = () => f.request('POST', '/api/email-code', { email: syntheticRecipient });
  const sent = await mailCode();
  statusCode(sent, 200);
  assert.deepEqual(sent.json(), { ok: true, expiresIn: 600, cooldownSeconds: 60 });
  assert.equal(smtp.messages.length, 1);
  assert.equal(smtp.events.includes('auth-clear'), false);
  const rate = await mailCode();
  statusCode(rate, 429, 'EMAIL_RATE_LIMITED');
  assert.equal(rate.headers['retry-after'], String(rate.json().retryAfter));
  assert.ok(rate.json().retryAfter > 0);
  assert.equal(smtp.messages.length, 1);
  const code = extractCode(smtp);
  const wrong = code === '100000' ? '200000' : '100000';
  statusCode(await f.register(syntheticRecipient, { emailCode: wrong }), 400, 'EMAIL_CODE_INVALID');
  assert.equal(f.db.prepare('SELECT tries FROM email_codes').get().tries, 1);
  const signedUp = await f.register(syntheticRecipient, { emailCode: code });
  statusCode(signedUp, 200);
  assert.equal(signedUp.json().account.is_admin, false);
  assert.equal(typeof signedUp.json().token, 'string');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM email_codes').get().n, 0);
  statusCode(await mailCode(), 409, 'EMAIL_ALREADY_REGISTERED');
  assert.equal(smtp.messages.length, 1);
});

test('补发失败不删除旧码，配置之后不可用也能验证已收到的码', async (t) => {
  const smtp = await loopbackSmtp(t, certificate);
  const f = await isolatedApi(t);
  const admin = await f.bootstrap();
  statusCode(await f.setup(admin, smtp), 200);
  const send = () => f.request('POST', '/api/email-code', { email: syntheticRecipient });
  statusCode(await send(), 200);
  const code = extractCode(smtp);
  f.db.transaction(() => f.db.prepare('UPDATE email_codes SET created_at = ?').run(Date.now() - 61000))();
  smtp.state.failAt = 'recipient';
  const failure = await send();
  statusCode(failure, 502, 'SMTP_DELIVERY_FAILED');
  assert.equal(/INTERNAL-SHOULD-NOT-LEAK|SMTP_RECIPIENT_REJECTED|example\.invalid/.test(failure.body), false);
  assert.equal(smtp.messages.length, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM email_codes').get().n, 1);
  statusCode(await f.patch(admin, { smtpClearPass: true }), 200);
  statusCode(await f.register(syntheticRecipient, { emailCode: code }), 200);
});

test('在 invite 或 closed 门禁下不能发邮箱码，both 仅接受显式有效的邀请码或邮箱码', async (t) => {
  const smtp = await loopbackSmtp(t, certificate);
  const f = await isolatedApi(t);
  const admin = await f.bootstrap();
  statusCode(await f.setup(admin, smtp), 200);
  const send = () => f.request('POST', '/api/email-code', { email: syntheticRecipient });
  statusCode(await f.patch(admin, { registerGate: 'invite' }), 200);
  statusCode(await send(), 403, 'EMAIL_GATE_DISABLED');
  statusCode(await f.register(syntheticRecipient, { emailCode: '123456' }), 400, 'INVITE_REQUIRED');
  statusCode(await f.patch(admin, { registerGate: 'both', registerMode: 'closed' }), 200);
  statusCode(await send(), 403, 'REGISTRATION_CLOSED');
  statusCode(await f.register(syntheticRecipient), 403, 'REGISTRATION_CLOSED');
  statusCode(await f.patch(admin, { registerMode: 'open', smtpClearPass: true }), 200);
  statusCode(await f.register(syntheticRecipient), 400, 'REGISTRATION_VERIFICATION_REQUIRED');
  const issued = await f.request('POST', '/api/admin/invites', { count: 1 }, admin);
  statusCode(issued, 200);
  statusCode(await f.register(syntheticRecipient, { invite: issued.json().codes[0] }), 200);
  assert.equal(smtp.events.length, 0);
});

test('拒绝试图在收件地址中注入 SMTP 指令的输入，且从未连接回环', async (t) => {
  const smtp = await loopbackSmtp(t, certificate);
  const f = await isolatedApi(t);
  const admin = await f.bootstrap();
  statusCode(await f.setup(admin, smtp), 200);
  const invalid = 'fixture\r\nSMTP@example.invalid';
  statusCode(await f.request('POST', '/api/email-code', { email: invalid }), 400, 'EMAIL_INVALID');
  statusCode(await f.request('POST', '/api/admin/site/test-mail', { to: invalid }, admin), 400, 'EMAIL_INVALID');
  assert.equal(smtp.events.length, 0);
});
