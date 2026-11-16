import net from 'node:net';
import tls from 'node:tls';

/**
 * 零依赖 SMTP 发信（不引 nodemailer，打包不需要额外模块）。
 * 支持三种常见配置：
 *   - 465 端口：连上就是 TLS（secure = true）
 *   - 587 端口：明文连上后 STARTTLS 升级（secure = false，但服务器支持就升级）
 *   - 25 端口：明文，一般不认证（内网自建邮件服务器）
 * 只做最小可用集：EHLO / STARTTLS / AUTH LOGIN / MAIL / RCPT / DATA / QUIT。
 */

function makeReader(sock) {
  let buf = '';
  const queue = [];
  let waiter = null;
  let closed = false;

  const feed = () => {
    /* SMTP 多行响应：250-xxx 继续，250 xxx 结束 */
    for (;;) {
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      const line = buf.slice(0, idx + 1);
      buf = buf.slice(idx + 1);
      queue.push(line);
      const m = /^(\d{3})([ -])/.exec(line);
      if (m && m[2] === ' ') {
        const all = queue.join('');
        queue.length = 0;
        const code = Number(m[1]);
        if (waiter) {
          const w = waiter;
          waiter = null;
          w.resolve({ code, text: all });
        } else {
          pending.push({ code, text: all });
        }
      }
    }
  };
  const pending = [];

  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    feed();
  });
  sock.on('error', (err) => {
    closed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.reject(err);
    }
  });
  sock.on('close', () => {
    closed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.reject(new Error('连接被服务器关闭'));
    }
  });

  return {
    read(timeoutMs = 15000) {
      if (pending.length) return Promise.resolve(pending.shift());
      if (closed) return Promise.reject(new Error('连接已关闭'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = null;
          reject(new Error('等待服务器响应超时'));
        }, timeoutMs);
        waiter = {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        };
      });
    },
    reset() {
      buf = '';
      queue.length = 0;
      pending.length = 0;
    },
  };
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, (...args) => resolve(args));
    emitter.once('error', reject);
  });
}

/**
 * 发一封纯文本邮件。
 * cfg: { host, port, secure, user, pass, from, fromName }
 * 返回 { ok: true } 或抛错（错误信息直接给前端看）。
 */
export async function sendMail(cfg, { to, subject, text }) {
  const host = String(cfg.host || '').trim();
  const port = Number(cfg.port) || (cfg.secure ? 465 : 587);
  const user = String(cfg.user || '').trim();
  const pass = String(cfg.pass || '');
  const from = String(cfg.from || user || '').trim();
  if (!host) throw new Error('没配 SMTP 服务器地址');
  if (!from) throw new Error('没配发件邮箱');
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('收件邮箱格式不对');

  let sock;
  if (cfg.secure || port === 465) {
    sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false });
    await once(sock, 'secureConnect');
  } else {
    sock = net.connect({ host, port });
    await once(sock, 'connect');
  }

  let reader = makeReader(sock);
  const send = (line) => new Promise((resolve) => sock.write(line + '\r\n', resolve));

  const expect = async (codes, what) => {
    const r = await reader.read();
    if (!codes.includes(r.code)) {
      throw new Error(what + '失败（' + r.code + '）：' + r.text.trim().slice(0, 200));
    }
    return r;
  };

  try {
    await expect([220], '连接');
    await send('EHLO everony.local');
    let ehlo = await expect([250], 'EHLO');

    const supportsStartTls = /STARTTLS/i.test(ehlo.text);
    if (!cfg.secure && port !== 465 && supportsStartTls) {
      await send('STARTTLS');
      await expect([220], 'STARTTLS');
      sock = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false });
      await once(sock, 'secureConnect');
      reader = makeReader(sock);
      await send('EHLO everony.local');
      ehlo = await expect([250], 'EHLO');
    }

    if (user) {
      await send('AUTH LOGIN');
      await expect([334], 'AUTH');
      await send(Buffer.from(user, 'utf8').toString('base64'));
      await expect([334], 'AUTH 用户名');
      await send(Buffer.from(pass, 'utf8').toString('base64'));
      await expect([235], '登录');
    }

    await send('MAIL FROM:<' + from + '>');
    await expect([250], 'MAIL FROM');
    await send('RCPT TO:<' + to + '>');
    await expect([250, 251], 'RCPT TO');
    await send('DATA');
    await expect([354], 'DATA');

    const fromName = String(cfg.fromName || 'Everony').trim();
    const subjectEncoded = '=?UTF-8?B?' + Buffer.from(String(subject), 'utf8').toString('base64') + '?=';
    const body = Buffer.from(String(text), 'utf8').toString('base64');
    const headers = [
      'From: ' + subjectEncodedFrom(fromName, from),
      'To: <' + to + '>',
      'Subject: ' + subjectEncoded,
      'Date: ' + new Date().toUTCString(),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      'Message-ID: <' + Date.now() + '.' + Math.random().toString(36).slice(2) + '@everony.local>',
    ];
    /* 正文按 76 字符折行，某些老邮件服务器会截断超长行 */
    const bodyLines = body.match(/.{1,76}/g) || [''];
    await send(headers.join('\r\n') + '\r\n\r\n' + bodyLines.join('\r\n') + '\r\n.');
    await expect([250], '投递');

    try {
      await send('QUIT');
    } catch {
      /* QUIT 失败不影响已投递的邮件 */
    }
    return { ok: true };
  } finally {
    try {
      sock.destroy();
    } catch {
      /* 已关闭 */
    }
  }
}

/** From 头里带中文昵称要按 RFC 2047 编码 */
function subjectEncodedFrom(name, email) {
  const encoded = '=?UTF-8?B?' + Buffer.from(String(name), 'utf8').toString('base64') + '?=';
  return encoded + ' <' + email + '>';
}
