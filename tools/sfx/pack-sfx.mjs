import { cp, rm, readdir, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const P = process.cwd();
const APP = join(P, 'release', 'win-unpacked', 'resources', 'app');
const SRC = join(P, 'release', 'win-unpacked');
const SFX = join(P, '.tools', 'sfx');
const pkg = JSON.parse(await readFile(join(P, 'package.json'), 'utf8'));
const ver = pkg.version;

// 0) 先重编启动器：版本号从 package.json 同步进去，避免用上一版的启动器
console.log('重编启动器…');
execFileSync(process.execPath, [join(P, 'tools', 'sfx', 'build-launcher.mjs')], { cwd: P, stdio: 'inherit' });

// 1) 把最新代码同步进打包目录
await rm(join(APP, 'dist', 'web'), { recursive: true, force: true });
await mkdir(join(APP, 'dist'), { recursive: true });
await cp(join(P, 'dist', 'web'), join(APP, 'dist', 'web'), { recursive: true });
await rm(join(APP, 'dist-apk'), { recursive: true, force: true });
await cp(join(P, 'dist-apk'), join(APP, 'dist-apk'), { recursive: true });
for (const f of await readdir(join(P, 'server'))) {
  if (f.endsWith('.js')) await cp(join(P, 'server', f), join(APP, 'server', f));
}
for (const f of await readdir(join(P, 'electron'))) {
  if (/\.(cjs|js|html)$/.test(f)) await cp(join(P, 'electron', f), join(APP, 'electron', f));
}
await cp(join(P, 'package.json'), join(APP, 'package.json'));
console.log('同步完成，app/dist-apk =', (await readdir(join(APP, 'dist-apk'))).join(','));

// 2) 载荷 zip
await rm(join(SFX, 'payload.zip'), { force: true });
execFileSync(join(SFX, '7za.exe'), ['a', '-tzip', '-mx=5', join(SFX, 'payload.zip'), '*'], {
  cwd: SRC, stdio: 'ignore', timeout: 540000,
});
const payload = await readFile(join(SFX, 'payload.zip'));
console.log('载荷字节:', payload.length);

// 3) 启动器 + 载荷 + 长度 + 魔数
const launcher = await readFile(join(SFX, 'launcher.exe'));
const len = Buffer.alloc(8);
len.writeUInt32LE(payload.length, 0);
len.writeUInt32LE(0, 4);
const out = join(P, 'release', 'FurryEverpony-' + ver + '.exe');
await writeFile(out, Buffer.concat([launcher, payload, len, Buffer.from('FESFX001', 'latin1')]));
const st = await stat(out);
console.log('exe:', out, st.size);
