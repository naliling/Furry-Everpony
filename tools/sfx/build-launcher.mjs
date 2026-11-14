// 编译单文件 exe 的启动器（tools/sfx/Launcher.cs → .tools/sfx/launcher.exe）
// 版本号从 package.json 取，直接写进生成的源码，避免「源码改了但启动器没重编」的坑。
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const P = process.cwd();
const pkg = JSON.parse(await readFile(join(P, 'package.json'), 'utf8'));
const ver = pkg.version;                       // 2026.11.15.0.10.11
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
try {
  execFileSync(csc, [
    '/nologo', '/target:winexe', '/optimize+',
    '/out:' + target,
    '/win32icon:' + join(P, 'build', 'icon.ico'),
    out,
  ], { cwd: P, stdio: 'pipe', encoding: 'buffer', timeout: 180000 });
} catch (e) {
  const raw = Buffer.concat([e.stdout || Buffer.alloc(0), e.stderr || Buffer.alloc(0)]);
  const msg = new TextDecoder('gbk').decode(raw);   // csc 输出是 GBK，Node 的 Buffer 不支持 gbk 编码，只能走 TextDecoder
  throw new Error('启动器编译失败：\n' + msg);
}
const st = await stat(target);
console.log('[launcher] 版本', ver, '字节', st.size);
