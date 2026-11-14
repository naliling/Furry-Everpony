// 开机登录态测试：端口粘性（fe.local.Ports）+ 各文件接线检查。
// 跑法：node android/test/boot-login-test.mjs（需先有 JDK；本文件自己编译 Ports.java）。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const P = process.cwd();
const JAVA = join(P, '.tools/android/jdk-17.0.21+9/bin/java.exe');
const JAVAC = join(P, '.tools/android/jdk-17.0.21+9/bin/javac.exe');
const CP = join(P, '.tools/tmp-port-test');
const SRC = join(P, 'android/server-src/fe/local/Ports.java');

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, extra) {
  if (ok) { pass++; } else { fail++; fails.push(name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
}

// ---------------- 一、端口顺序 ----------------
rmSync(CP, { recursive: true, force: true });
mkdirSync(CP, { recursive: true });
try {
  execFileSync(JAVAC, ['--release', '8', '-encoding', 'UTF-8', '-nowarn', '-d', CP, SRC], { stdio: 'pipe' });
} catch (e) {
  console.log('RAN 0  PASS 0  FAIL 0  ERR 1');
  console.log('Ports.java 编译失败: ' + String((e.stderr && e.stderr.toString()) || e.message).slice(0, 800));
  process.exit(1);
}

function order(last, first, tries) {
  const out = execFileSync(JAVA, ['-cp', CP, 'fe.local.Ports', String(last), String(first), String(tries)], { encoding: 'utf8' });
  const m = out.match(/PORT_ORDER ([0-9,]*)/);
  if (!m) throw new Error('没拿到端口顺序: ' + out);
  return m[1] === '' ? [] : m[1].split(',').map(Number);
}
function uniq(a) { return new Set(a).size === a.length; }
function range(first, tries) { const r = []; for (let i = 0; i < tries; i++) r.push(first + i); return r; }
function sameSet(a, b) { return a.length === b.length && a.slice().sort((x, y) => x - y).join(',') === b.slice().sort((x, y) => x - y).join(','); }

const o1 = order(0, 7788, 12);
check('首次启动从 7788 起按顺序试', o1.join(',') === range(7788, 12).join(','), o1);
check('首次启动一共 12 个候选', o1.length === 12, o1.length);

const o2 = order(7790, 7788, 12);
check('上次端口排第一', o2[0] === 7790, o2.slice(0, 3));
check('上次端口只出现一次', uniq(o2), o2);
check('其余端口一个不少', sameSet(o2, range(7788, 12)), o2);
check('第二个是 7788（其余按顺序补）', o2[1] === 7788, o2.slice(0, 3));

const o3 = order(9999, 7788, 12);
check('上次端口超出范围就当没记过', o3.join(',') === range(7788, 12).join(','), o3.slice(0, 3));

const o4 = order(-5, 7788, 12);
check('负数端口当没记过', o4[0] === 7788, o4.slice(0, 3));

const o5 = order(7799, 7788, 12);
check('区间最后一个端口也能排第一', o5[0] === 7799 && uniq(o5) && o5.length === 12, o5.slice(0, 3));

const o6 = order(7788, 7788, 12);
check('区间第一个端口排第一且不重复', o6[0] === 7788 && uniq(o6) && o6.length === 12, o6.slice(0, 3));

const o7 = order(7790, 7788, 1);
check('只试 1 个端口时忽略区间外的上次端口', o7.length === 1 && o7[0] === 7788, o7);

const o8 = order(7788, 7788, 1);
check('只试 1 个端口且正好是上次那个', o8.length === 1 && o8[0] === 7788, o8);

// ---------------- 二、接线检查 ----------------
const ma = readFileSync(join(P, 'android/java/dev/furryeverpony/app/MainActivity.java'), 'utf8');
check('MainActivity 用 Ports.order 排端口', ma.includes('Ports.order(prefs().getInt(KEY_LAST_PORT, 0), PORT_FIRST, PORT_TRIES)'), '没找到');
check('MainActivity 绑定成功后写回 last_port', /putInt\(KEY_LAST_PORT, real\)/.test(ma), '没找到 putInt(KEY_LAST_PORT, real)');
check('MainActivity 首选端口会原地重试', /PORT_RETRY_TIMES/.test(ma) && /Thread\.sleep\(PORT_RETRY_SLEEP_MS\)/.test(ma), '没找到重试逻辑');
check('MainActivity 引了 fe.local.Ports', /import fe\.local\.Ports;/.test(ma), '没 import');

const api = readFileSync(join(P, 'android/server-src/fe/local/Api.java'), 'utf8');
const tokenRouteCount = (api.match(/\/api\/native\/token/g) || []).length;
check('Api 注册了 POST 与 GET 两个 native token 路由', tokenRouteCount >= 2, tokenRouteCount);
check('Api 用 boot-token.txt 存 token', api.includes('boot-token.txt'), '没找到文件名');
check('Api 校验 token 形状', /TOKEN_SHAPE\s*=\s*Pattern\.compile/.test(api), '没找到 TOKEN_SHAPE');
check('签发 session 后立即落盘', /issueSession\(long[\s\S]{0,1200}?store\.save\(\)/.test(api), 'issueSession 里没有 store.save()');
check('退出登录时清掉 boot-token', /\/api\/logout[\s\S]{0,1500}?writeBootToken\(""\)/.test(api), 'logout 里没有 writeBootToken("")');
check('登录态请求会把 token 记下来', /rememberBootToken\(token\)/.test(api), 'byToken 里没有 rememberBootToken');

const http = readFileSync(join(P, 'android/server-src/fe/local/Http.java'), 'utf8');
check('Http 只在 index.html 上注入', /equalsIgnoreCase\("index\.html"\)/.test(http), '没找到 index.html 判断');
check('Http 在 </head> 之前插入脚本', /indexOf\("<\/head>"\)/.test(http), '没找到 </head> 定位');
check('Http 注入的是 localStorage 里的 fe_token', http.includes("localStorage.setItem('fe_token'"), '没找到注入脚本');
check('Http 自己再校验一遍 token 形状', /TOKEN_SHAPE/.test(http), '没找到 TOKEN_SHAPE');
check('Http 的 dataDir 取自 webRoot 的上级目录', /getParentFile\(\)/.test(http), '没找到 getParentFile()');

// 界面文案与注释不许出现那个即时通讯软件的名字
const banned = ['Q', 'Q'].join('');
let bannedHits = 0;
for (const rel of ['android/java/dev/furryeverpony/app/MainActivity.java', 'android/java/dev/furryeverpony/app/Notifier.java',
  'android/server-src/fe/local/Api.java', 'android/server-src/fe/local/Http.java', 'android/server-src/fe/local/Ports.java']) {
  if (readFileSync(join(P, rel), 'utf8').includes(banned)) { bannedHits++; fails.push('出现禁用字样: ' + rel); }
}
check('界面文案与注释里没有禁用字样', bannedHits === 0, bannedHits);

rmSync(CP, { recursive: true, force: true });

console.log('');
console.log('RAN ' + (pass + fail) + '  PASS ' + pass + '  FAIL ' + fail + '  ERR 0');
if (fails.length) { console.log('失败项:'); for (const f of fails) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);