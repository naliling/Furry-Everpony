// 无窗口、脱离父进程地拉起服务端。
// 用 spawn + detached + windowsHide：父进程（这个脚本）立即退出，服务端独立常驻且不弹黑窗。
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

const child = spawn(process.execPath, ['--env-file=' + join(root, '.tools', 'server.env'), join(root, 'server', 'index.js')], {
  cwd: root,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();
console.log('spawned pid=' + child.pid);
