#!/usr/bin/env node
/**
 * 构建 Furry Everpony 手机端 APK。
 *
 * 不用 Gradle / Android Gradle Plugin：直接用 SDK 自带的
 * aapt2（编资源）→ javac（编 Java）→ d8（转 dex）→ zipalign → apksigner，
 * 整条链路离线可重复，产物就是一个能装到手机上的 apk。
 *
 * 用法： node android/build-apk.mjs
 * 依赖： ../.tools/android/sdk（build-tools;34.0.0 + platforms;android-34）
 *        ../.tools/android/jdk-17*（JDK 17）
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const TOOLS = path.join(PROJECT, '.tools', 'android');
const BUILD = path.join(HERE, 'build');
const OUT = path.join(HERE, 'dist');
const DIST = path.join(PROJECT, 'dist-apk');

const log = (m) => console.log('[apk] ' + m);
const fail = (m) => { console.error('[apk] 失败：' + m); process.exit(1); };

function findDir(parent, prefix) {
  if (!fs.existsSync(parent)) return '';
  const hit = fs.readdirSync(parent).filter((n) => n.startsWith(prefix)).sort().pop();
  return hit ? path.join(parent, hit) : '';
}

const JDK = findDir(TOOLS, 'jdk-17');
const SDK = path.join(TOOLS, 'sdk');
const BT = path.join(SDK, 'build-tools', '34.0.0');
const PLATFORM = path.join(SDK, 'platforms', 'android-34', 'android.jar');
if (!JDK) fail('找不到 JDK 17（期望 ' + TOOLS + '\\jdk-17*）');
if (!fs.existsSync(BT)) fail('找不到 build-tools 34.0.0（' + BT + '）');
if (!fs.existsSync(PLATFORM)) fail('找不到 android-34 的 android.jar（' + PLATFORM + '）');

const exe = (name) => {
  const win = path.join(BT, name + '.exe');
  if (fs.existsSync(win)) return { cmd: win, args: [] };
  const bat = path.join(BT, name + '.bat');
  if (fs.existsSync(bat)) return { cmd: 'cmd.exe', args: ['/c', bat] };
  fail('找不到工具 ' + name);
};

const JAVA = path.join(JDK, 'bin', 'java.exe');
const JAVAC = path.join(JDK, 'bin', 'javac.exe');
const JAR = path.join(JDK, 'bin', 'jar.exe');
const KEYTOOL = path.join(JDK, 'bin', 'keytool.exe');

// d8.bat / apksigner.bat 都要靠 JAVA_HOME 找 java，而且必须是 Windows 路径
const ENV = {
  ...process.env,
  JAVA_HOME: JDK,
  PATH: path.join(JDK, 'bin') + ';' + (process.env.PATH || ''),
};

function run(cmd, args, opts = {}) {
  log('$ ' + path.basename(cmd) + ' ' + args.map((a) => (a.includes(' ') ? '"' + a + '"' : a)).join(' ').slice(0, 220));
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: ENV, ...opts });
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).toString();
    fail(path.basename(cmd) + ' 出错：\n' + out.slice(-4000));
  }
}

// ---- 版本号：跟 package.json 走，versionCode 由 主.次.修 推出来（单调递增）
const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf8'));
const version = pkg.version;
const parts = version.split('.');
if (parts.length !== 6) fail('版本号格式应为 YYYY.MM.DD.主.次.修，实际 ' + version);
const major = Number(parts[3]);
const minor = Number(parts[4]);
const fix = Number(parts[5]);
const versionCode = 100000 + major * 10000 + minor * 100 + fix;
log('版本 ' + version + ' → versionCode ' + versionCode);

// ---- 清理
fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(path.join(BUILD, 'gen'), { recursive: true });

// ---- 界面文件打进 assets/web（手机端自己就是服务端，网页从 assets 解压到私有目录）
const WEB_SRC = path.join(PROJECT, 'dist', 'web');
const ASSETS = path.join(HERE, 'assets');
if (!fs.existsSync(path.join(WEB_SRC, 'index.html'))) fail('没有 ' + WEB_SRC + '，先跑 vite build');
fs.rmSync(ASSETS, { recursive: true, force: true });
fs.mkdirSync(path.join(ASSETS, 'web'), { recursive: true });
fs.cpSync(WEB_SRC, path.join(ASSETS, 'web'), { recursive: true });
const assetCount = (function walkCount(d) {
  let n = 0;
  for (const name of fs.readdirSync(d)) {
    const p = path.join(d, name);
    if (fs.statSync(p).isDirectory()) n += walkCount(p); else n += 1;
  }
  return n;
})(path.join(ASSETS, 'web'));
log('界面文件 ' + assetCount + ' 个 → assets/web');

// ---- 版本号写进 BuildInfo.java，Java 侧只认这一个来源
fs.writeFileSync(path.join(BUILD, 'gen', 'BuildInfo.java'),
  'package dev.furryeverpony.app;\n\nfinal class BuildInfo {\n    static final String VERSION = ' + JSON.stringify(version) + ';\n}\n');
fs.mkdirSync(path.join(BUILD, 'classes'), { recursive: true });
fs.mkdirSync(path.join(BUILD, 'dex'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

// ---- 1. 编资源
const aapt2 = exe('aapt2');
run(aapt2.cmd, [...aapt2.args, 'compile', '--dir', path.join(HERE, 'res'), '-o', path.join(BUILD, 'res.zip')]);

// ---- 2. 链接资源 + 生成 R.java
const unsigned = path.join(BUILD, 'app-unsigned.apk');
run(aapt2.cmd, [...aapt2.args, 'link',
  '-o', unsigned,
  '-I', PLATFORM,
  '--manifest', path.join(HERE, 'AndroidManifest.xml'),
  '-R', path.join(BUILD, 'res.zip'),
  '--java', path.join(BUILD, 'gen'),
  '--min-sdk-version', '24',
  '--target-sdk-version', '34',
  '--version-code', String(versionCode),
  '--version-name', version,
  '--auto-add-overlay']);

// ---- 3. javac
function walk(dir, ext, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, ext, acc);
    else if (p.endsWith(ext)) acc.push(p);
  }
  return acc;
}
const sources = [
  ...walk(path.join(HERE, 'java'), '.java'),
  ...walk(path.join(HERE, 'server-src'), '.java'),
  ...walk(path.join(BUILD, 'gen'), '.java'),
];
log('Java 源文件 ' + sources.length + ' 个');
run(JAVAC, ['--release', '11', '-encoding', 'UTF-8', '-classpath', PLATFORM, '-d', path.join(BUILD, 'classes'), ...sources]);

// ---- 4. d8 → classes.dex
const classes = walk(path.join(BUILD, 'classes'), '.class');
log('class 文件 ' + classes.length + ' 个');
// class 太多时直接列在命令行会超长（Windows 命令行上限），先打成 jar 再交给 d8
const classJar = path.join(BUILD, 'classes.jar');
run(JAR, ['--create', '--file', classJar, '-C', path.join(BUILD, 'classes'), '.']);
const d8 = exe('d8');
run(d8.cmd, [...d8.args, '--release', '--min-api', '24', '--lib', PLATFORM, '--output', path.join(BUILD, 'dex'), classJar]);

// ---- 5. 把 dex 塞进 apk
run(JAR, ['--update', '--file', unsigned, '-C', path.join(BUILD, 'dex'), 'classes.dex']);

// 界面文件不能交给 aapt2 -A：Windows 上 aapt2 会把子目录写成反斜杠路径（assets/web\assets\x.js），
// 安卓按正斜杠找资源，结果运行时一个都读不到。改用 jar 塞进去，jar 一律用正斜杠。
const stage = path.join(BUILD, 'stage');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'assets'), { recursive: true });
fs.cpSync(ASSETS, path.join(stage, 'assets'), { recursive: true });
run(JAR, ['--update', '--file', unsigned, '-C', stage, '.']);

// ---- 6. zipalign
const aligned = path.join(BUILD, 'app-aligned.apk');
const zipalign = exe('zipalign');
run(zipalign.cmd, [...zipalign.args, '-f', '-p', '4', unsigned, aligned]);

// ---- 7. 签名（keystore 只生成一次，之后一直复用，否则升级装不上去）
const ksDir = path.join(HERE, 'keystore');
fs.mkdirSync(ksDir, { recursive: true });
const ks = path.join(ksDir, 'fe-release.jks');
const KS_PASS = 'furryeverpony';
if (!fs.existsSync(ks)) {
  log('生成签名密钥 ' + ks);
  run(KEYTOOL, ['-genkeypair', '-keystore', ks, '-alias', 'fe', '-keyalg', 'RSA', '-keysize', '2048',
    '-validity', '10000', '-storepass', KS_PASS, '-keypass', KS_PASS,
    '-dname', 'CN=Furry Everpony, OU=Self-Hosted, O=Furry Everpony, L=Local, C=CN']);
}

const apkName = 'FurryEverpony-' + version + '.apk';
const apkOut = path.join(OUT, apkName);
const apksigner = exe('apksigner');
run(apksigner.cmd, [...apksigner.args, 'sign', '--ks', ks, '--ks-pass', 'pass:' + KS_PASS,
  '--key-pass', 'pass:' + KS_PASS, '--ks-key-alias', 'fe', '--out', apkOut, aligned]);

const verify = run(apksigner.cmd, [...apksigner.args, 'verify', '--print-certs', apkOut]);
const sha = crypto.createHash('sha256').update(fs.readFileSync(apkOut)).digest('hex');
const size = fs.statSync(apkOut).size;
const distPath = path.join(DIST, apkName);
fs.copyFileSync(apkOut, distPath);

log('签名校验：\n' + verify.trim().split('\n').slice(0, 4).join('\n'));
log('产物 ' + apkOut);
log('大小 ' + (size / 1024).toFixed(1) + ' KB');
log('sha256 ' + sha);
log('已复制到 ' + distPath);