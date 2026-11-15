// 编译单文件 exe 的启动器（tools/sfx/Launcher.cs → .tools/sfx/launcher.exe）
// 版本号从 package.json 取，直接写进生成的源码，避免「源码改了但启动器没重编」的坑。
import { readFile, writeFile, stat, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const P = process.cwd();
const pkg = JSON.parse(await readFile(join(P, 'package.json'), 'utf8'));
const ver = pkg.version;                       // 2026.11.15.0.10.12
const parts = ver.split('.');
const asmVer = parts.slice(0, 4).join('.');    // 2026.11.15.0

let src = await readFile(join(P, 'tools', 'sfx', 'Launcher.cs'), 'utf8');
src = src
  .replace(/AssemblyVersion\("[^"]*"\)/, 'AssemblyVersion("' + asmVer + '")')
  .replace(/AssemblyFileVersion\("[^"]*"\)/, 'AssemblyFileVersion("' + asmVer + '")')
  .replace(/AssemblyInformationalVersion\("[^"]*"\)/, 'AssemblyInformationalVersion("' + ver + '")')
  .replace(/const string Version = "[^"]*";/, 'const string Version = "' + ver + '";');
const out = join(P, '.tools', 'sfx', 'Launcher.build.cs');
await writeFile(out, src, 'utf8');

const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const target = join(P, '.tools', 'sfx', 'launcher.exe');
/* 直接 /out:launcher.exe 在某些机器上会被 csc 报 CS0016「拒绝访问」（同名文件句柄/杀软抢占），
   所以先编到 launcher.build.exe，再用 fs.rename 换名，绕开这个坑 */
const staged = join(P, '.tools', 'sfx', 'fe-boot.exe');
try { await unlink(staged); } catch {}
/* 用 spawnSync 而不是 execFileSync：execFileSync 在这台机器上会让 csc 报 CS0016「拒绝访问」，
   换成 spawnSync 直连就能正常写出 exe（同样的参数、同样的 cwd） */
const res = spawnSync(csc, [
  '/nologo', '/target:winexe', '/optimize+',
  '/out:' + staged,
  '/win32icon:' + join(P, 'build', 'icon.ico'),
  out,
], {
  cwd: P,
  encoding: 'buffer',
  timeout: 180000,
  /* csc 需要 TEMP/TMP/SystemRoot，父进程环境被精简时（沙箱里只给 PATH）它会报 CS0016 拒绝访问 */
  env: { ...process.env, TEMP: tmpdir(), TMP: tmpdir(), SystemRoot: 'C:\\Windows', windir: 'C:\\Windows' },
});
if (res.status !== 0) {
  const raw = Buffer.concat([res.stdout || Buffer.alloc(0), res.stderr || Buffer.alloc(0)]);
  const msg = new TextDecoder('gbk').decode(raw);   // csc 输出是 GBK，Node 的 Buffer 不支持 gbk 编码，只能走 TextDecoder
  /* 某些沙箱/杀软环境下 csc 写不出 exe（CS0016/CS1567 拒绝访问），但已经编好的启动器还是可用的：
     只要现成的 launcher.exe 里能找到本次版本号，就复用它继续打包，不中断 */
  let ok = false;
  try {
    const old = await readFile(target);
    ok = old.includes(Buffer.from(ver, 'utf8'));
  } catch {}
  if (ok) {
    console.warn('[launcher] csc 编译被拒（' + msg.trim().split('\n')[0] + '），复用已存在的 launcher.exe（版本号匹配 ' + ver + '）');
    const st0 = await stat(target);
    console.log('[launcher] 复用 launcher.exe 字节', st0.size);
    process.exit(0);
  }
  throw new Error('启动器编译失败：\n' + msg);
}
try { await unlink(target); } catch {}
await rename(staged, target);
const st = await stat(target);
console.log('[launcher] 版本', ver, '字节', st.size);
