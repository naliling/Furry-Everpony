import net from 'node:net';
import tls from 'node:tls';
import { generateKeyPairSync, sign } from 'node:crypto';

/* 动态生成只供回环测试使用的证书，不提交或打印私钥。 */
export function loopbackCertificate() {
  function der(tag, ...parts) {
    const data = Buffer.concat(parts);
    const len = Buffer.alloc(3);
    if (data.length < 128) len[0] = data.length;
    else if (data.length < 256) { len[0] = 0x81; len[1] = data.length; }
    else { len[0] = 0x82; len.writeUInt16BE(data.length, 1); }
    return Buffer.concat([Buffer.from([tag]), len.subarray(0, data.length < 128 ? 1 : data.length < 256 ? 2 : 3), data]);
  }
  const seq = (...parts) => der(0x30, ...parts);
  const hex = (s) => Buffer.from(s, 'hex');
  const algorithm = seq(hex('06092a864886f70d01010b0500')); // sha256WithRSAEncryption
  const name = seq(der(0x31, seq(hex('0603550403'), der(0x0c, Buffer.from('localhost')))));
  const at = (ms) => der(0x18, Buffer.from(new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'));
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const tbs = seq(
    hex('a003020102020101'), algorithm, name, seq(at(Date.now() - 86400000), at(Date.now() + 86400000)), name,
    publicKey.export({ format: 'der', type: 'spki' }),
    der(0xa3, seq(seq(hex('0603551d11'), der(4, seq(der(0x87, Buffer.from([127, 0, 0, 1]))))))),
  );
  const signed = seq(tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  return {
    key: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    cert: '-----BEGIN CERTIFICATE-----\n' + signed.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n',
  };
}

export async function loopbackSmtp(t, certificate, { mode = 'tls', failAt = '', auth = true } = {}) {
  const sockets = new Set();
  const messages = [];
  const events = [];
  const state = { failAt };
  const context = tls.createSecureContext(certificate);
  const track = (sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    sock.once('close', () => sockets.delete(sock));
  };
  const greet = (sock, encrypted) => {
    handle(sock, encrypted);
    if (state.failAt !== 'greeting-timeout') sock.write('220 loopback SMTP ready\r\n');
  };
  function handle(sock, encrypted) {
    let buffer = '';
    let payload = null;
    let loginStep = 0;
    const reply = (line) => sock.write(line + '\r\n');
    // 测试供应商可能在拒绝响应中回显不宜公开的内容。
    const refusal = (code) => reply(code + ' INTERNAL-SHOULD-NOT-LEAK');
    const receive = (chunk) => {
      buffer += chunk.toString();
      for (let i = buffer.indexOf('\r\n'); i !== -1; i = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (payload) {
          if (line !== '.') payload.push(line);
          else {
            if (state.failAt === 'message') refusal(554);
            else { messages.push(payload.join('\r\n')); events.push('accepted'); reply('250 stored'); }
            payload = null;
          }
        } else if (loginStep) {
          if (loginStep === 1) { loginStep = 2; reply('334 second'); }
          else {
            loginStep = 0;
            if (state.failAt === 'auth') refusal(535);
            else reply('235 authenticated');
          }
        } else if (line.startsWith('EHLO ')) {
          events.push(encrypted ? 'ehlo-tls' : 'ehlo-clear');
          let caps = '250-loopback\r\n';
          if (!encrypted && mode === 'starttls') caps += '250-STARTTLS\r\n';
          if (auth) caps += '250-AUTH LOGIN PLAIN\r\n';
          // 特意拆分多行响应，验证客户端不依赖一次 data 拿到完整响应。
          sock.write(caps + '25');
          setImmediate(() => { if (!sock.destroyed) reply('0 SIZE 65536'); });
        } else if (line === 'STARTTLS' && !encrypted) {
          events.push('starttls');
          if (state.failAt === 'starttls') { refusal(454); continue; }
          sock.off('data', receive);
          reply('220 ready for TLS');
          const secured = new tls.TLSSocket(sock, { isServer: true, secureContext: context });
          track(secured);
          handle(secured, true);
          return;
        } else if (line === 'AUTH LOGIN') {
          events.push(encrypted ? 'auth-tls' : 'auth-clear');
          loginStep = 1;
          reply('334 first');
        } else if (line.startsWith('MAIL FROM:')) {
          events.push(encrypted ? 'mail-tls' : 'mail-clear');
          if (state.failAt === 'sender') refusal(550); else reply('250 sender accepted');
        } else if (line.startsWith('RCPT TO:')) {
          events.push('rcpt');
          if (state.failAt === 'recipient') refusal(550); else reply('250 recipient accepted');
        } else if (line === 'DATA') {
          payload = [];
          reply('354 send data');
        } else if (line === 'QUIT') {
          sock.end('221 bye\r\n');
        } else {
          reply('500 unsupported');
        }
      }
    };
    sock.on('data', receive);
  }
  const server = mode === 'tls'
    ? tls.createServer(certificate, (sock) => { track(sock); greet(sock, true); })
    : net.createServer((sock) => { track(sock); greet(sock, false); });
  server.on('connection', track);
  server.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    for (const sock of sockets) sock.destroy();
    server.close(resolve);
  }));
  return { port: server.address().port, messages, events, state };
}
