import net from 'node:net';
import tls from 'node:tls';
import { describeMailConfig, isMailAddress } from './mail-config.js';

const ERRORS = {
  SMTP_DNS_FAILED: '无法解析 SMTP 主机名，请检查服务器地址和 DNS。',
  SMTP_CONNECTION_FAILED: '连接 SMTP 服务器失败，请检查端口、出站网络和防火墙。',
  SMTP_TIMEOUT: 'SMTP 响应超时，请检查出站网络和端口对应的加密方式。',
  SMTP_TLS_FAILED: 'SMTP TLS 握手或证书校验失败，请核对主机名、端口和证书链。',
  SMTP_STARTTLS_REQUIRED: '服务器未声明 STARTTLS，未发送登录信息或邮件。请核对端口和加密方式。',
  SMTP_STARTTLS_REJECTED: '服务器拒绝升级到 STARTTLS，请核对端口及服务商设置。',
  SMTP_AUTH_UNSUPPORTED: 'SMTP 服务器未声明 AUTH LOGIN；请检查服务商的 SMTP 认证设置。',
  SMTP_AUTH_REJECTED: 'SMTP 服务商拒绝认证。请确认已启用 SMTP、授权码或应用专用密码仍有效，且与登录名匹配。',
  SMTP_SENDER_REJECTED: 'SMTP 服务商拒绝发件人，请核对发件地址是否经登录账号授权。',
  SMTP_RECIPIENT_REJECTED: 'SMTP 服务商拒绝收件人，请检查收件地址、转发权限或服务商限制。',
  SMTP_MESSAGE_REJECTED: 'SMTP 服务商拒收邮件，请检查发送额度、内容策略和发信权限。',
  SMTP_PROTOCOL_FAILED: 'SMTP 服务器响应异常，请核对服务器地址、端口和服务商状态。',
  SMTP_RECIPIENT_INVALID: '收件邮箱格式不对。',
};

class MailError extends Error {
  constructor(code, message = ERRORS[code], smtpStatus) {
    super(message);
    this.code = code;
    this.smtpStatus = smtpStatus;
  }
}

/* 不透传服务端响应正文或低层异常：可能含邮箱、账号或供应商诊断数据。 */
export function mailFailure(err) {
  const safe = err instanceof MailError ? err : new MailError('SMTP_PROTOCOL_FAILED');
  return { code: safe.code, error: safe.message, ...(safe.smtpStatus ? { smtpStatus: safe.smtpStatus } : {}) };
}

function makeReader(sock) {
  let buf = '';
  let responseCode = 0;
  let size = 0;
  let lines = [];
  const pending = [];
  let waiter;
  let failure;

  function fail(err) {
    failure ||= err;
    if (waiter) {
      const { reject } = waiter;
      waiter = undefined;
      reject(failure);
    }
  }
  const close = () => fail(new MailError('SMTP_CONNECTION_FAILED'));
  function feed(chunk) {
    buf += chunk.toString('utf8');
    if (size + buf.length > 32768) return fail(new MailError('SMTP_PROTOCOL_FAILED'));
    while (!failure) {
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      const match = /^(\d{3})(?:([ -])(.*))?$/.exec(line);
      const code = Number(match?.[1]);
      if (!match || (responseCode && code !== responseCode) || pending.length >= 4) {
        return fail(new MailError('SMTP_PROTOCOL_FAILED'));
      }
      responseCode = code;
      size += idx + 1;
      lines.push(match[3] || '');
      if (match[2] === '-') continue;
      const response = { code, lines };
      lines = [];
      size = 0;
      responseCode = 0;
      if (waiter) {
        const { resolve } = waiter;
        waiter = undefined;
        resolve(response);
      } else {
        pending.push(response);
      }
    }
  }
  sock.on('data', feed);
  sock.on('error', fail);
  sock.on('close', close);
  return {
    read() {
      if (pending.length) return Promise.resolve(pending.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    },
    detach() {
      sock.off('data', feed);
      sock.off('error', fail);
      sock.off('close', close);
    },
  };
}

function waitFor(sock, event) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      sock.off(event, done);
      sock.off('error', fail);
      sock.off('close', close);
    };
    const done = () => { cleanup(); resolve(); };
    const fail = (err) => { cleanup(); reject(err); };
    const close = () => fail(new MailError('SMTP_CONNECTION_FAILED'));
    sock.once(event, done);
    sock.once('error', fail);
    sock.once('close', close);
  });
}

const write = (sock, line) => new Promise((resolve, reject) => {
  sock.write(line + '\r\n', (err) => err ? reject(err) : resolve());
});

function transportError(err, inTlsHandshake) {
  if (err instanceof MailError) return err;
  const code = String(err?.code || '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new MailError('SMTP_DNS_FAILED');
  if (code === 'ETIMEDOUT') return new MailError('SMTP_TIMEOUT');
  if (/^(ECONN|EHOST|ENET|EPIPE)/.test(code)) return new MailError('SMTP_CONNECTION_FAILED');
  if (inTlsHandshake || /^(ERR_SSL|ERR_TLS|CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO)/.test(code)) {
    return new MailError('SMTP_TLS_FAILED');
  }
  return new MailError('SMTP_PROTOCOL_FAILED');
}

/** 使用 TLS 直连或强制 STARTTLS；只有配置明确不需要认证时才跳过 AUTH。 */
export async function sendMail(cfg, { to, subject, text }, { timeoutMs = 12000 } = {}) {
  const { ready, issues, from } = describeMailConfig(cfg);
  if (!ready) throw new MailError(issues[0].code, issues[0].message);
  if (!isMailAddress(to)) throw new MailError('SMTP_RECIPIENT_INVALID');
  const { host, port, user, pass, secure } = cfg;
  const tlsOptions = { host, port, servername: net.isIP(host) ? undefined : host.replace(/\.$/, ''), rejectUnauthorized: true };
  let sock;
  let reader;
  let inTlsHandshake = secure;
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    /* 升级和关闭期间也要接收异步错误；实际错误由 reader / waitFor 分类。 */
    socket.on('error', () => {});
    sock = socket;
    reader = makeReader(socket);
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    for (const socket of sockets) socket.destroy(new MailError('SMTP_TIMEOUT'));
  }, timeoutMs);
  const expect = async (codes, failureCode = 'SMTP_PROTOCOL_FAILED') => {
    const response = await reader.read();
    if (!codes.includes(response.code)) throw new MailError(failureCode, undefined, response.code);
    return response;
  };
  const command = async (line, codes, failureCode) => {
    await write(sock, line);
    return expect(codes, failureCode);
  };
  try {
    track(secure ? tls.connect(tlsOptions) : net.connect({ host, port }));
    await waitFor(sock, secure ? 'secureConnect' : 'connect');
    inTlsHandshake = false;
    await expect([220]);
    let ehlo = await command('EHLO everony.local', [250]);
    if (!secure) {
      if (!ehlo.lines.some((line) => /^STARTTLS(?:\s|$)/i.test(line))) throw new MailError('SMTP_STARTTLS_REQUIRED');
      await command('STARTTLS', [220], 'SMTP_STARTTLS_REJECTED');
      reader.detach();
      inTlsHandshake = true;
      track(tls.connect({ ...tlsOptions, socket: sock }));
      await waitFor(sock, 'secureConnect');
      inTlsHandshake = false;
      ehlo = await command('EHLO everony.local', [250]);
    }

    if (user) {
      const login = ehlo.lines.some((line) => /^AUTH[= \t]/i.test(line) && line.slice(5).toUpperCase().split(/\s+/).includes('LOGIN'));
      if (!login) throw new MailError('SMTP_AUTH_UNSUPPORTED');
      await command('AUTH LOGIN', [334], 'SMTP_AUTH_REJECTED');
      await command(Buffer.from(user, 'utf8').toString('base64'), [334], 'SMTP_AUTH_REJECTED');
      await command(Buffer.from(pass, 'utf8').toString('base64'), [235], 'SMTP_AUTH_REJECTED');
    }

    await command('MAIL FROM:<' + from + '>', [250], 'SMTP_SENDER_REJECTED');
    await command('RCPT TO:<' + to + '>', [250, 251], 'SMTP_RECIPIENT_REJECTED');
    await command('DATA', [354], 'SMTP_MESSAGE_REJECTED');

    const encoded = (value) => '=?UTF-8?B?' + Buffer.from(String(value), 'utf8').toString('base64') + '?=';
    const body = Buffer.from(String(text), 'utf8').toString('base64');
    const headers = [
      'From: ' + encoded(cfg.fromName || 'Everony') + ' <' + from + '>',
      'To: <' + to + '>',
      'Subject: ' + encoded(subject),
      'Date: ' + new Date().toUTCString(),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      'Message-ID: <' + Date.now() + '.' + Math.random().toString(36).slice(2) + '@everony.local>',
    ];
    /* 正文按 76 字符折行；base64 不会产生需要点转义的行。 */
    const bodyLines = body.match(/.{1,76}/g) || [''];
    await command(headers.join('\r\n') + '\r\n\r\n' + bodyLines.join('\r\n') + '\r\n.', [250], 'SMTP_MESSAGE_REJECTED');
    await write(sock, 'QUIT').catch(() => {});
    return { ok: true };
  } catch (err) {
    throw timedOut ? new MailError('SMTP_TIMEOUT') : transportError(err, inTlsHandshake);
  } finally {
    clearTimeout(timer);
    reader?.detach();
    for (const socket of sockets) socket.destroy();
  }
}
