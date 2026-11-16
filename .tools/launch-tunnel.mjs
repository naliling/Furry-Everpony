import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, 'tunnel.mjs')], {
  cwd: dirname(here),
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();
console.log('tunnel launcher pid=' + child.pid);
