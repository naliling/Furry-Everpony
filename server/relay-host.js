import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { buildRelay } from './relay.js';

/**
 * 本机当中转站（relay host）
 *
 * 为什么要有它：普通家用宽带大多在多层 NAT 后面（光猫 → 路由器 → …），
 * 端口映射走不通，别人永远连不进来。这里用「本地中继 + 免费出站隧道」绕开这件事：
 *   1. 在本机起一台中继（局域网内可直接用）；
 *   2. 起 cloudflared 快速隧道，把中继暴露成一个 https 地址（不需要公网 IP、不需要账号）；
 *   3. 把这个地址显示出来，手机扫一下二维码就配好了。
 *
 * 隧道地址每次重启会变（免费快速隧道的限制），所以界面上要能随时看到当前地址。
 */

const CF_DOWNLOAD = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export function createRelayHost({ db, log = console, version = '', dataDir, onUrl = null }) {
  const binDir = join(dataDir, 'bin');
  const cfPath = join(binDir, 'cloudflared.exe');
  const relayDb = join(dataDir, 'relay-host.db');
  const port = Number(process.env.FE_RELAY_HOST_PORT || 7801);

  let relayApp = null;
  let child = null;
  let url = '';
  let state = 'off'; // off | starting | running | error
  let error = '';
  let since = 0;
  let watchdog = null;
  let starting = false;

  /* 注意：instance_meta 的列名是 key / value（和 federation.js 的 meta() 保持一致） */
  function meta(key, value) {
    if (value === undefined) {
      const row = db.prepare('SELECT value FROM instance_meta WHERE key = ?').get(key);
      return row ? row.value : '';
    }
    db.prepare(
      'INSERT INTO instance_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, String(value));
    return value;
  }

  function status() {
    return {
      enabled: meta('host_relay') === '1',
      state,
      url,
      relayPort: port,
      localUrl: 'http://127.0.0.1:' + port,
      cloudflared: existsSync(cfPath) ? statSync(cfPath).size : 0,
      error,
      since,
      version,
    };
  }

  async function ensureCloudflared() {
    if (existsSync(cfPath) && statSync(cfPath).size > 5 * 1024 * 1024) return true;
    mkdirSync(binDir, { recursive: true });
    log.info?.('[relay-host] 首次使用，正在下载 cloudflared（约 55MB）…');
    const ok = await new Promise((resolve) => {
      const p = spawn('curl.exe', ['--ssl-no-revoke', '-sSL', '-m', '600', '-o', cfPath, CF_DOWNLOAD], {
        windowsHide: true,
      });
      p.on('error', () => resolve(false));
      p.on('exit', (code) => resolve(code === 0));
    });
    if (!ok || !existsSync(cfPath)) {
      try { unlinkSync(cfPath); } catch { /* 忽略 */ }
      return false;
    }
    return statSync(cfPath).size > 5 * 1024 * 1024;
  }

  async function startRelay() {
    if (relayApp) return;
    relayApp = buildRelay({ dbFile: relayDb, log, version });
    await relayApp.listen({ port, host: '0.0.0.0' });
  }

  function startTunnel() {
    if (child) return;
    child = spawn(cfPath, ['tunnel', '--url', 'http://127.0.0.1:' + port, '--no-autoupdate'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (buf) => {
      const text = String(buf);
      const m = text.match(URL_RE);
      if (m && m[0] !== url) {
        url = m[0];
        state = 'running';
        error = '';
        since = Date.now();
        meta('host_relay_url', url);
        log.info?.('[relay-host] 公网地址：' + url);
        /* 告诉中继客户端「对外是这个地址」，这样邀请码/二维码里带的就是公网隧道地址 */
        try { onUrl?.(url); } catch { /* 忽略 */ }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      child = null;
      url = '';
      if (meta('host_relay') === '1') {
        state = 'starting';
        error = '隧道断开，正在重连（退出码 ' + code + '）';
        setTimeout(() => { if (meta('host_relay') === '1') startTunnel(); }, 3000);
      } else {
        state = 'off';
      }
    });
  }

  async function start() {
    if (starting) return status();
    starting = true;
    try {
      state = 'starting';
      error = '';
      meta('host_relay', '1');
      const ok = await ensureCloudflared();
      if (!ok) {
        state = 'error';
        error = '下载 cloudflared 失败（需要能访问 github.com），可以稍后重试';
        return status();
      }
      await startRelay();
      startTunnel();
      /* 重启后先用上次记住的地址兜底，隧道起来后会被 onUrl 覆盖 */
      const last = meta('host_relay_url');
      if (last) { try { onUrl?.(last); } catch { /* 忽略 */ } }
      if (!watchdog) {
        watchdog = setInterval(() => {
          if (meta('host_relay') !== '1') return;
          if (!child && !starting) startTunnel();
        }, 30000);
        watchdog.unref?.();
      }
      return status();
    } catch (err) {
      state = 'error';
      error = '启动失败：' + (err && err.message ? err.message : String(err));
      return status();
    } finally {
      starting = false;
    }
  }

  async function stop() {
    meta('host_relay', '0');
    state = 'off';
    url = '';
    error = '';
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
    if (child) { try { child.kill(); } catch { /* 已退出 */ } child = null; }
    if (relayApp) { try { await relayApp.close(); } catch { /* 已关闭 */ } relayApp = null; }
    return status();
  }

  async function setEnabled(on) {
    return on ? start() : stop();
  }

  return { status, start, stop, setEnabled, port };
}
