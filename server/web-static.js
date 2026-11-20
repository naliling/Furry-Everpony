import { createReadStream, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
};
const FINGERPRINTED = /^assets\/[^/]+-[\w-]{8}\.(?:m?js|css)$/i;
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css']);

function fileStat(path) {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat : null;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

function selectEncoding(header, file, stat, compressible) {
  const accepted = new Map();
  for (const item of String(header || '').toLowerCase().split(',')) {
    const [name, ...params] = item.split(';').map((part) => part.trim());
    if (!name) continue;
    const q = params.find((part) => part.startsWith('q='));
    const weight = q ? Number(q.slice(2)) : 1;
    accepted.set(name, Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0);
  }
  const candidates = compressible ? [['br', '.br'], ['gzip', '.gz'], ['identity', '']] : [['identity', '']];
  const ranked = candidates.map(([name, suffix]) => ({
    name, suffix,
    weight: accepted.get(name) ?? (name === 'identity' ? (accepted.get('*') === 0 ? 0 : 1) : accepted.get('*') ?? 0),
  })).filter((item) => item.weight > 0).sort((a, b) => b.weight - a.weight);
  for (const { name, suffix } of ranked) {
    const variant = suffix ? fileStat(file + suffix) : stat;
    if (variant) return { name, stat: variant, path: file + suffix };
  }
  return null;
}

/* 同源托管前端；页面可回退到 HTML，缺失脚本、样式和 API 不能回退。 */
export function registerWebStatic(app, webDir) {
  const root = resolve(webDir);
  const indexPath = resolve(root, 'index.html');

  app.get('/*', (req, reply) => {
    const rawPath = String(req.raw.url || '/').split('?', 1)[0];
    let rel;
    try {
      rel = decodeURIComponent(rawPath).replace(/^\/+/, '');
    } catch {
      return reply.code(400).send({ error: '地址格式不对' });
    }
    if (rel.includes('\0') || rel.includes('\\') || rel.includes(':') || rel.split('/').some((part) => part.startsWith('.'))) {
      return reply.code(404).send({ error: '没有这个资源' });
    }
    if (/^(?:api|onebot|uploads)(?:\/|$)/i.test(rel)) return reply.code(404).send({ error: '没有这个接口' });

    let file = resolve(root, rel);
    const inRoot = relative(root, file);
    if (inRoot === '..' || inRoot.startsWith('..' + sep) || isAbsolute(inRoot)) return reply.code(404).send({ error: '没有这个资源' });
    if (/\.(?:br|gz)$/i.test(rel)) return reply.code(404).send({ error: '没有这个资源' });
    let stat = fileStat(file);
    if (!stat) {
      if (extname(rel) || /^(?:assets|icons)(?:\/|$)/i.test(rel)) return reply.code(404).send({ error: '没有这个资源' });
      file = indexPath;
      stat = fileStat(file);
      if (!stat) return reply.code(404).send({ error: '前端尚未构建' });
    }

    const ext = extname(file).toLowerCase();
    const compressible = COMPRESSIBLE.has(ext);
    if (compressible) {
      const vary = String(reply.getHeader('Vary') || '');
      if (vary !== '*' && !/(?:^|,\s*)Accept-Encoding(?:,|$)/i.test(vary)) {
        reply.header('Vary', vary ? vary + ', Accept-Encoding' : 'Accept-Encoding');
      }
    }
    const result = selectEncoding(req.headers['accept-encoding'], file, stat, compressible);
    if (!result) return reply.code(406).send({ error: '没有支持的资源编码' });
    const etag = `W/"${result.stat.size.toString(16)}-${Math.trunc(result.stat.mtimeMs).toString(16)}-${result.name}"`;
    const cache = FINGERPRINTED.test(rel) ? 'public, max-age=31536000, immutable'
      : ext === '.html' || rel === 'sw.js' || ext === '.webmanifest' ? 'no-cache' : 'public, max-age=86400';
    reply.type(MIME[ext] || 'application/octet-stream').header('Cache-Control', cache).header('ETag', etag);
    if (result.name !== 'identity') reply.header('Content-Encoding', result.name);
    if (String(req.headers['if-none-match'] || '').split(',').some((value) => {
      const tag = value.trim();
      return tag === '*' || tag.replace(/^W\//, '') === etag.slice(2);
    })) return reply.code(304).send();
    return reply.header('Content-Length', result.stat.size).send(createReadStream(result.path));
  });
}
