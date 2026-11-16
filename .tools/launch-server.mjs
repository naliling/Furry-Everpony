// 无窗口、脱离父进程地拉起「看门狗」——看门狗负责起服务端并自动重启。
// 用 spawn + detached + windowsHide：父进程（这个脚本）立即退出，看门狗独立常驻且不弹黑窗。
// 已有实例在监听时直接退出，避免开机自启 + 手动重启撞端口。
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.FE_PORT || 7788);

const already = await new Promise((resolve) => {
  const sock = connect({ host: '127.0.0.1', port: PORT });
  const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
  sock.once('connect', () => done(true));
  sock.once('error', () => done(false));
  setTimeout(() => done(false), 800);
});
if (already) {
  console.log('already running on ' + PORT + ', skip');
  process.exit(0);
}

const child = spawn(process.execPath, [join(root, '.tools', 'watchdog.mjs')], {
  cwd: root,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();
console.log('spawned watchdog pid=' + child.pid);
