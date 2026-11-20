import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, brotliDecompressSync, gunzipSync } from 'node:zlib';
import Fastify from 'fastify';
import { registerWebStatic } from '../web-static.js';

const dataRoot = fileURLToPath(new URL('../../data/', import.meta.url));
const src = "console.log('静态资源检测');\n".repeat(16);
const asset = '/assets/app-Ab12_3x9.js';

async function useFixture(run) {
  await mkdir(dataRoot, { recursive: true });
  const dir = await mkdtemp(join(dataRoot, 'static-test-'));
  const app = Fastify();
  try {
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>Everony</title>');
    await writeFile(join(dir, asset), src);
    await writeFile(join(dir, asset + '.br'), brotliCompressSync(src));
    await writeFile(join(dir, asset + '.gz'), gzipSync(src));
    await writeFile(join(dir, 'sw.js'), 'self.skipWaiting()');
    app.addHook('onRequest', async (_req, reply) => { reply.header('Vary', 'Origin'); });
    app.get('/api/health', async () => ({ ok: true }));
    registerWebStatic(app, dir);
    await run(app);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('首选 Brotli；MIME、缓存和 Vary 正确', async () => useFixture(async (app) => {
  const r = await app.inject({ url: asset, headers: { 'accept-encoding': 'gzip, br' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-encoding'], 'br');
  assert.match(r.headers['content-type'], /^text\/javascript/);
  assert.match(r.headers['cache-control'], /immutable/);
  assert.match(r.headers.vary, /Origin, Accept-Encoding/);
  assert.equal(brotliDecompressSync(r.rawPayload).toString(), src);
}));

test('按权重选择 gzip，禁用时回退无压缩', async () => useFixture(async (app) => {
  const gzip = await app.inject({ url: asset, headers: { 'accept-encoding': 'br;q=0, gzip;q=0.8, identity;q=0.3' } });
  assert.equal(gzip.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(gzip.rawPayload).toString(), src);
  const plain = await app.inject({ url: asset, headers: { 'accept-encoding': 'br;q=0, gzip;q=0' } });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body, src);
  assert.equal((await app.inject({ url: asset, headers: { 'accept-encoding': '*;q=0' } })).statusCode, 406);
}));

test('按资源编码缓存 ETag，支持 304 / HEAD', async () => useFixture(async (app) => {
  const h = { 'accept-encoding': 'br' };
  const r = await app.inject({ url: asset, headers: h });
  const fresh = await app.inject({ url: asset, headers: { ...h, 'if-none-match': r.headers.etag } });
  assert.equal(fresh.statusCode, 304);
  assert.equal(fresh.body, '');
  const other = await app.inject({ url: asset, headers: { 'if-none-match': r.headers.etag } });
  assert.equal(other.statusCode, 200);
  assert.notEqual(other.headers.etag, r.headers.etag);
  const head = await app.inject({ method: 'HEAD', url: asset, headers: h });
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers['content-length'], r.headers['content-length']);
  assert.equal(head.body, '');
}));

test('首页和 SW 重新验证；只对网页路由作回退', async () => useFixture(async (app) => {
  for (const url of ['/', '/register', '/sw.js']) {
    const r = await app.inject({ url });
    assert.equal(r.statusCode, 200, url);
    assert.equal(r.headers['cache-control'], 'no-cache', url);
  }
  for (const url of ['/assets/missing.js', '/icons/missing.png', '/api/missing', '/onebot/missing', '/uploads/missing', asset + '.br']) {
    const r = await app.inject({ url });
    assert.equal(r.statusCode, 404, url);
    assert.match(r.headers['content-type'], /application\/json/);
  }
  assert.deepEqual((await app.inject({ url: '/api/health' })).json(), { ok: true });
}));
