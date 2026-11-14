// APK 注入的 SHIM 脚本测试：从 MainActivity.java 里把字符串取出来，在 Node 里真跑一遍。
import fs from 'node:fs';
import vm from 'node:vm';

const JAVA = 'android/java/dev/furryeverpony/app/MainActivity.java';
const src = fs.readFileSync(JAVA, 'utf8');
const m = src.match(/private static final String SHIM =([\s\S]*?);\n/);
if (!m) { console.log('FAIL 没在源码里找到 SHIM'); process.exit(1); }
const parts = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
const shim = parts.join('')
  .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');

let ran = 0, pass = 0, fail = 0;
const ok = (name, cond, extra) => { ran++; if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); } };
const tick = () => new Promise((r) => setTimeout(r, 20));

function makeCtx(opts = {}) {
  const copied = [];
  const notes = [];
  // 浏览器里 window 就是全局对象本身，这里也让它自引用，才能直接写 new Notification(...)
  const sandbox = { Uint8Array, Promise, console, navigator: opts.navigator || {} };
  sandbox.window = sandbox;
  sandbox.crypto = opts.crypto === undefined
    ? (() => { let s = 0x2545f491; return { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; a[i] = s & 255; } return a; } }; })()
    : opts.crypto;
  sandbox.msCrypto = sandbox.crypto;
  sandbox.feAndroid = { copy: (t) => copied.push(t), notify: (t, b) => notes.push([t, b]) };
  if (opts.fetch) sandbox.fetch = opts.fetch;
  if (opts.document) sandbox.document = opts.document;
  vm.createContext(sandbox);
  return { sandbox, copied, notes };
}

function fakeFetch(body) {
  return () => Promise.resolve({ clone: () => ({ text: () => Promise.resolve(body) }) });
}

console.log('== 补齐 randomUUID');
{
  const { sandbox } = makeCtx();
  vm.runInContext(shim, sandbox);
  const uuid = vm.runInContext('crypto.randomUUID()', sandbox);
  ok('randomUUID 被补上', typeof uuid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid), uuid);
  const set = new Set();
  for (let i = 0; i < 200; i++) set.add(vm.runInContext('crypto.randomUUID()', sandbox));
  ok('200 次不重复', set.size === 200, 'size=' + set.size);
  ok('长度 36', uuid.length === 36, String(uuid.length));
}

console.log('== 补齐 clipboard');
{
  const { sandbox, copied } = makeCtx();
  vm.runInContext(shim, sandbox);
  const r = vm.runInContext('navigator.clipboard.writeText("你好 FE")', sandbox);
  ok('writeText 返回 Promise', r && typeof r.then === 'function');
  await r;
  ok('内容转给了 Android 桥', copied.length === 1 && copied[0] === '你好 FE', JSON.stringify(copied));
  const empty = await vm.runInContext('navigator.clipboard.readText()', sandbox);
  ok('readText 兜底空串', empty === '');
  ok('非字符串入参不炸', await (async () => { try { await vm.runInContext('navigator.clipboard.writeText(12345)', sandbox); return copied[copied.length - 1] === '12345'; } catch (e) { return false; } })());
}

console.log('== 补齐 serviceWorker');
{
  const { sandbox } = makeCtx();
  vm.runInContext(shim, sandbox);
  ok('serviceWorker 存在', vm.runInContext("'serviceWorker' in navigator", sandbox) === true);
  const reg = vm.runInContext('navigator.serviceWorker.register("/sw.js")', sandbox);
  ok('register 返回 Promise', reg && typeof reg.then === 'function');
  ok('register 解析为 null', (await reg) === null);
  const list = await vm.runInContext('navigator.serviceWorker.getRegistrations()', sandbox);
  ok('getRegistrations 解析为空数组', Array.isArray(list) && list.length === 0);
}

console.log('== 原生通知接管');
{
  const { sandbox, notes } = makeCtx();
  vm.runInContext(shim, sandbox);
  ok('Notification 被补上', typeof vm.runInContext('window.Notification', sandbox) === 'function');
  ok('permission 直接是 granted', vm.runInContext('window.Notification.permission', sandbox) === 'granted');
  vm.runInContext("new Notification('甲',{body:'在吗'})", sandbox);
  ok('转到 feAndroid.notify', notes.length === 1 && notes[0][0] === '甲' && notes[0][1] === '在吗', JSON.stringify(notes));
  const p = vm.runInContext('window.Notification.requestPermission()', sandbox);
  ok('requestPermission 返回 Promise', p && typeof p.then === 'function');
  ok('requestPermission 解析为 granted', (await p) === 'granted');
  vm.runInContext("new Notification('')", sandbox);
  ok('空标题有兜底、缺 body 不炸', notes.length === 2 && notes[1][0] === 'Furry Everpony' && notes[1][1] === '', JSON.stringify(notes));
  const before = vm.runInContext('window.Notification', sandbox);
  vm.runInContext(shim, sandbox);
  ok('二次注入不覆盖已有 Notification', vm.runInContext('window.Notification', sandbox) === before);
}

console.log('== 后台未读弹通知（钩 fetch 的会话轮询）');
{
  const body = JSON.stringify({ conversations: [
    { unread: 0, peer: { nickname: '乙' } },
    { unread: 2, peer: { nickname: '甲' }, last: { preview: '在吗' } },
  ] });
  const { sandbox, notes } = makeCtx({ fetch: fakeFetch(body), document: { hidden: true } });
  vm.runInContext(shim, sandbox);
  const res = await vm.runInContext('window.fetch("/api/conversations")', sandbox);
  ok('原响应照常返回', res && typeof res.clone === 'function');
  await tick();
  ok('后台时按未读弹一条通知', notes.length === 1 && notes[0][0] === '甲' && notes[0][1] === '在吗', JSON.stringify(notes));
  await vm.runInContext('window.fetch("/api/conversations")', sandbox);
  await tick();
  ok('未读数没涨就不重复弹', notes.length === 1, JSON.stringify(notes));
  await vm.runInContext('window.fetch("/api/health")', sandbox);
  await tick();
  ok('非会话列表接口不解析', notes.length === 1, JSON.stringify(notes));
}

console.log('== 前台时不打扰');
{
  const body = JSON.stringify({ conversations: [{ unread: 5, peer: { nickname: '丙' }, last: { preview: '喂' } }] });
  const { sandbox, notes } = makeCtx({ fetch: fakeFetch(body), document: { hidden: false } });
  vm.runInContext(shim, sandbox);
  await vm.runInContext('window.fetch("/api/conversations")', sandbox);
  await tick();
  ok('页面在前台不弹通知', notes.length === 0, JSON.stringify(notes));
}

console.log('== 群消息与兜底文案');
{
  const body = JSON.stringify({ conversations: [{ unread: 3, group: { name: '摸鱼群' } }] });
  const { sandbox, notes } = makeCtx({ fetch: fakeFetch(body), document: { hidden: true } });
  vm.runInContext(shim, sandbox);
  await vm.runInContext('window.fetch("/api/conversations")', sandbox);
  await tick();
  ok('群名当标题', notes.length === 1 && notes[0][0] === '摸鱼群', JSON.stringify(notes));
  ok('没有 last 时用未读数兜底', notes[0][1].indexOf('3 条新消息') >= 0, JSON.stringify(notes));
}

console.log('== 不覆盖已有实现 / 幂等');
{
  const existing = { getRandomValues: (a) => a };
  const custom = () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  existing.randomUUID = custom;
  const { sandbox } = makeCtx({ crypto: existing });
  vm.runInContext(shim, sandbox);
  ok('已有 randomUUID 不被覆盖', vm.runInContext('crypto.randomUUID()', sandbox) === 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');

  const { sandbox: s2, copied } = makeCtx();
  vm.runInContext(shim, s2);
  const first = vm.runInContext('navigator.clipboard.writeText', s2);
  vm.runInContext(shim, s2);
  ok('连跑两次不抛异常', true);
  ok('连跑两次仍是同一个 clipboard 对象', vm.runInContext('navigator.clipboard.writeText', s2) === first);
  await vm.runInContext('navigator.clipboard.writeText("二次")', s2);
  ok('第二次注入后仍能复制', copied[copied.length - 1] === '二次');
}

console.log('== 没有 feAndroid 桥时也不炸');
{
  const { sandbox } = makeCtx();
  delete sandbox.feAndroid;
  vm.runInContext(shim, sandbox);
  let threw = false;
  try { await vm.runInContext('navigator.clipboard.writeText("x")', sandbox); } catch (e) { threw = true; }
  ok('桥缺失时 writeText 不抛', threw === false);
  ok('桥缺失时 Notification 不接管', vm.runInContext('typeof window.Notification', sandbox) === 'undefined');
}

console.log();
console.log('RAN=' + ran + ' PASS=' + pass + ' FAIL=' + fail);
process.exit(fail > 0 ? 1 : 0);