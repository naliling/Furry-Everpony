// 校验打出来的 APK：版本号与 package.json 一致、minSdk/targetSdk 对、dex 里真的有新写的类。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

const ROOT = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const parts = version.split('.');
const [major, minor, fix] = parts.slice(-3).map((n) => parseInt(n, 10));
const wantCode = 100000 + major * 10000 + minor * 100 + fix;
const apk = path.join(ROOT, 'android', 'dist', 'FurryEverpony-' + version + '.apk');
const AAPT2 = path.join(ROOT, '.tools', 'android', 'sdk', 'build-tools', '34.0.0', 'aapt2.exe');

// apksigner.bat 内部要调 java，得把 JDK 喂给它
const jdkRoot = path.join(ROOT, '.tools', 'android');
const jdkName = fs.existsSync(jdkRoot) ? fs.readdirSync(jdkRoot).filter((n) => n.startsWith('jdk-17')).sort().pop() : '';
const JDK = jdkName ? path.join(jdkRoot, jdkName) : '';
const toolEnv = JDK
  ? { ...process.env, JAVA_HOME: JDK, PATH: path.join(JDK, 'bin') + ';' + (process.env.PATH || '') }
  : { ...process.env };

let ran = 0, pass = 0, fail = 0;
const ok = (name, cond, extra) => { ran++; if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); } };

if (!fs.existsSync(apk)) {
  console.log('  SKIP  没有找到 ' + path.relative(ROOT, apk) + '（还没打 APK，跳过产物校验）');
  console.log();
  console.log('RAN=0 PASS=0 FAIL=0');
  process.exit(0);
}

console.log('== APK 基本信息');
const size = fs.statSync(apk).size;
ok('产物存在且大于 60KB', size > 60 * 1024, size + ' 字节');

const badging = execFileSync(AAPT2, ['dump', 'badging', apk], { encoding: 'utf8', maxBuffer: 1e7 });
const pick = (re) => { const m = badging.match(re); return m ? m[1] : ''; };
const gotVersion = pick(/versionName='([^']*)'/);
const gotCode = parseInt(pick(/versionCode='(\d+)'/) || '0', 10);
const gotMin = pick(/sdkVersion:'(\d+)'/);
const gotTarget = pick(/targetSdkVersion:'(\d+)'/);
const gotPkg = pick(/package: name='([^']*)'/);

console.log('  versionName=' + gotVersion + '  versionCode=' + gotCode + '  minSdk=' + gotMin + '  targetSdk=' + gotTarget);
ok('包名是 dev.furryeverpony.app', gotPkg === 'dev.furryeverpony.app', gotPkg);
ok('versionName 与 package.json 一致', gotVersion === version, gotVersion + ' vs ' + version);
ok('versionCode 按 主/次/修 计算', gotCode === wantCode, gotCode + ' vs ' + wantCode);
ok('minSdk 24', gotMin === '24', gotMin);
ok('targetSdk 34', gotTarget === '34', gotTarget);
ok('声明了通知权限', badging.indexOf('android.permission.POST_NOTIFICATIONS') >= 0);
ok('声明了联网权限', badging.indexOf('android.permission.INTERNET') >= 0);
ok('应用名是 Furry Everpony', /application-label:'Furry Everpony'/.test(badging) || /application-label-zh[^:]*:'Furry Everpony'/.test(badging));
ok('启动 Activity 存在', /launchable-activity: name='dev\.furryeverpony\.app\.MainActivity'/.test(badging));

console.log('== dex 里真有新代码');
const buf = fs.readFileSync(apk);

// dex 在 zip 里是压缩存放的，整包搜字符串搜不到，先解出来再搜
function unzipEntry(apkBuf, wanted) {
  let eocd = -1;
  const floor = Math.max(0, apkBuf.length - 66000);
  for (let i = apkBuf.length - 22; i >= floor; i--) {
    if (apkBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip');
  const count = apkBuf.readUInt16LE(eocd + 10);
  let off = apkBuf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (apkBuf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = apkBuf.readUInt16LE(off + 10);
    const csize = apkBuf.readUInt32LE(off + 20);
    const nameLen = apkBuf.readUInt16LE(off + 28);
    const extraLen = apkBuf.readUInt16LE(off + 30);
    const commentLen = apkBuf.readUInt16LE(off + 32);
    const localOff = apkBuf.readUInt32LE(off + 42);
    const name = apkBuf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === wanted) {
      const ln = apkBuf.readUInt16LE(localOff + 26);
      const le = apkBuf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + ln + le;
      const raw = apkBuf.subarray(dataStart, dataStart + csize);
      return method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function listEntries(apkBuf) {
  let eocd = -1;
  const floor = Math.max(0, apkBuf.length - 66000);
  for (let i = apkBuf.length - 22; i >= floor; i--) {
    if (apkBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip');
  const count = apkBuf.readUInt16LE(eocd + 10);
  let off = apkBuf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (apkBuf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录损坏');
    const nameLen = apkBuf.readUInt16LE(off + 28);
    const extraLen = apkBuf.readUInt16LE(off + 30);
    const commentLen = apkBuf.readUInt16LE(off + 32);
    names.push(apkBuf.toString('utf8', off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

const dex = unzipEntry(buf, 'classes.dex');
ok('APK 里有 classes.dex', !!dex, String(dex && dex.length));
const text = dex ? dex.toString('latin1') : '';
const has = (s) => text.indexOf(s) >= 0;
ok('MainActivity 被打进包', has('MainActivity'));
ok('本机服务端 Api 被打进包', has('fe/local/Api'));
ok('本机 HTTP 服务 Http 被打进包', has('fe/local/Http'));
ok('群功能 Groups 被打进包', has('fe/local/Groups'));
ok('Notifier 被打进包', has('Notifier'));
ok('通知渠道名 fe_messages 在包里', has('fe_messages'));
const hasUtf8 = (s) => !!dex && dex.indexOf(Buffer.from(s, 'utf8')) >= 0;
ok('启动页文案在包里（dex 里的中文字符串是 UTF-8）', hasUtf8('正在启动'));
ok('独立运行说明在包里', hasUtf8('数据都在手机里'));
ok('错误页文案在包里', hasUtf8('本机服务没起来'));
ok('BuildInfo 版本常量在包里', has(version));
ok('没有把测试类打进去', !has('LogicTest'));

console.log('== 界面文件在包里（assets/web）');
const webIndex = unzipEntry(buf, 'assets/web/index.html');
ok('assets/web/index.html 存在', !!webIndex, String(webIndex && webIndex.length));
ok('index.html 是真正的界面', !!webIndex && webIndex.toString('utf8').indexOf('<div id="root">') >= 0);
const webJs = listEntries(buf).filter((n) => /^assets\/web\/assets\/.*\.js$/.test(n));
const webCss = listEntries(buf).filter((n) => /^assets\/web\/assets\/.*\.css$/.test(n));
ok('assets/web 里带前端 JS 与 CSS', webJs.length >= 1 && webCss.length >= 1, webJs.concat(webCss).join(','));
const badSlash = listEntries(buf).filter((n) => n.indexOf('\\') >= 0);
ok('包内路径全是正斜杠（反斜杠安卓读不到）', badSlash.length === 0, badSlash.join(','));
ok('没有把电脑端服务端打进去', !has('node:sqlite'));

console.log('== 签名');
let signOut = '';
try {
  signOut = execFileSync(path.join(ROOT, '.tools', 'android', 'sdk', 'build-tools', '34.0.0', 'apksigner.bat'),
    ['verify', '--print-certs', apk], { encoding: 'utf8', maxBuffer: 1e7, shell: true, env: toolEnv });
} catch (e) { signOut = String(e.stdout || '') + String(e.stderr || ''); }
ok('签名校验通过', /Verified using v2 scheme|Verified using v3 scheme|Signer #1 certificate DN/.test(signOut), signOut.slice(0, 200));
ok('证书是 Furry Everpony', signOut.indexOf('CN=Furry Everpony') >= 0);

console.log();
console.log('RAN=' + ran + ' PASS=' + pass + ' FAIL=' + fail);
process.exit(fail > 0 ? 1 : 0);