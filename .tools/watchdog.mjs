// Everony 服务端看门狗（2026-11-17）
// 作用：开机后由 Startup 里的 VBS 无窗口拉起；每 20 秒探一次 /api/health，
// 连续 3 次探不到（约 1 分钟）就重启服务端。日志写 data/logs/watchdog.log。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const PORT = Number(process.env.FE_PORT || 7788);
const LOG_DIR = join(root, 'data', 'logs');
const LOG = join(LOG_DIR, 'watchdog.log');

function log(msg) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG, new Date().toISOString() + ' ' + msg + '\n');
  } catch {
    /* 日志写不进去不影响主流程 */
  }
}

let child = null;
let fails = 0;

function startServer() {
  if (child && child.exitCode === null && child.signalCode === null) return;
  child = spawn(process.execPath, ['--env-file=' + join(root, '.tools', 'server.env'), join(root, 'server', 'index.js')], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('exit', (code, sig) => log('server exited code=' + code + ' sig=' + sig));
  log('started pid=' + child.pid);
}

async function healthy() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch('http://127.0.0.1:' + PORT + '/api/health', { signal: ctl.signal });
    clearTimeout(timer);
    return r.ok;
  } catch {
    return false;
  }
}

/* Tailscale/Funnel 守护交给独立的 PowerShell 哨兵（guard-tailscale.ps1），
   因为 node 子进程对 tailscaled 的受保护 pipe 没权限，PowerShell 直调可以。 */
log('watchdog up, port=' + PORT);
startServer();

setInterval(async () => {
  guardTailscale();
  if (await healthy()) {
    if (fails > 0) log('health ok again');
    fails = 0;
    return;
  }
  fails += 1;
  log('health fail x' + fails);
  if (fails >= 3) {
    fails = 0;
    log('restarting server');
    try {
      child?.kill();
    } catch {
      /* 已经死了就算了 */
    }
    startServer();
  }
}, 20000);
