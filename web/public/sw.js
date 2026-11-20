/* Furry Everpony Service Worker
 * 策略：
 * - 导航请求：network-first，失败回退缓存壳（离线可用）
 * - 带构建指纹的脚本和样式：cache-first；其他静态资源：stale-while-revalidate
 * - /api 与 /uploads：一律直连网络，绝不缓存（聊天数据与用户文件）
 */
const CACHE_PREFIX = 'fe-static-';
const CACHE_VERSION = CACHE_PREFIX + 'v2';
const CACHE_SHELL = '/';

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (cache) {
        return cache.add(CACHE_SHELL);
      })
      .catch(function () {
        // 单个资源缺失不影响 Service Worker 安装
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(
          keys.filter(function (key) { return key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION; })
            .map(function (key) { return caches.delete(key); })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

function isBypass(url) {
  return url.pathname === '/api' ||
    url.pathname.indexOf('/api/') === 0 ||
    url.pathname === '/uploads' ||
    url.pathname.indexOf('/uploads/') === 0;
}

function isStaticAsset(url) {
  if (url.pathname.indexOf('/assets/') === 0 || url.pathname.indexOf('/icons/') === 0) {
    return true;
  }
  return /\.(?:js|css|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|json|webmanifest)$/i.test(url.pathname);
}

function putInCache(request, response) {
  if (!response || !response.ok) {
    return Promise.resolve();
  }
  return caches.open(CACHE_VERSION).then(function (cache) {
    return cache.put(request, response.clone());
  }).catch(function () {});
}

async function networkFirst(request, keepAlive) {
  try {
    const response = await fetch(request);
    keepAlive(putInCache(request, response));
    return response;
  } catch (err) {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    const shell = await cache.match(CACHE_SHELL);
    if (shell) {
      return shell;
    }
    return new Response('离线：暂时无法连接到 Furry Everpony', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function cacheFirst(request, keepAlive) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  keepAlive(putInCache(request, response));
  return response;
}

async function staleWhileRevalidate(request, keepAlive) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(function (response) {
      const cachedCopy = putInCache(request, response);
      return { response, cachedCopy };
    })
    .catch(function () { return null; });
  keepAlive(network.then(function (fresh) { return fresh && fresh.cachedCopy; }));
  if (cached) {
    return cached;
  }
  const fresh = await network;
  if (fresh) {
    return fresh.response;
  }
  return new Response('离线且无缓存', {
    status: 504,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }
  let url = null;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }
  // 跨域请求不接管（例如外链图片）
  if (url.origin !== self.location.origin) {
    return;
  }
  // 聊天接口与上传文件不缓存
  if (isBypass(url)) {
    return;
  }
  const keepAlive = function (work) { event.waitUntil(work.catch(function () {})); };
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, keepAlive));
    return;
  }
  if (/^\/assets\/[^/]+-[a-z0-9_-]{8}\.(?:m?js|css)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(request, keepAlive));
    return;
  }
  if (isStaticAsset(url)) {
    event.respondWith(staleWhileRevalidate(request, keepAlive));
  }
});
