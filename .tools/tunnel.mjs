import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const CF = join(here, 'bin', 'cloudflared.exe');
const OUT = join(root, 'data', 'tunnel.json');
const LOG = join(root, 'data', 'logs', 'tunnel.log');

mkdirSync(dirname(LOG), { recursive: true });

function log(line) {
  try { appendFileSync(LOG, new Date().toISOString() + ' ' + line + '\n'); } catch { /* 日志写不进就算了 */ }
}

let lastUrl = '';
let child = null;

function start() {
  log('starting cloudflared');
  child = spawn(CF, ['tunnel', '--url', 'http://127.0.0.1:7788', '--no-autoupdate'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  const onData = (chunk) => {
    const text = chunk.toString();
    buf = (buf + text).slice(-8000);
    const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== lastUrl) {
      lastUrl = m[0];
      try {
        writeFileSync(OUT, JSON.stringify({ url: lastUrl, ts: Date.now() }, null, 2));
      } catch { /* 写不进也没关系，页面会显示准备中 */ }
      log('url ' + lastUrl);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => {
    log('cloudflared exited code=' + code);
    setTimeout(start, 5000);
  });
  child.on('error', (err) => {
    log('spawn error ' + err.message);
    setTimeout(start, 8000);
  });
}

process.on('uncaughtException', (err) => log('uncaught ' + err.message));
start();
