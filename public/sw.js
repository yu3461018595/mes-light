/* 智工MES · Service Worker
 * 作用：缓存应用外壳，使手机「添加到主屏幕」后离线也能打开报工页；
 *       静态资源 stale-while-revalidate，HTML/接口始终走网络拿最新。
 * 注意：PWA 安装提示仅在「安全上下文」(HTTPS 或 localhost) 下出现，
 *       当前阶段一为 HTTP+IP 时不弹安装框，部署 HTTPS 后自动生效。
 */
const CACHE = 'mes-light-v2';
const SHELL = [
  '/', '/index.html',
  '/m/', '/m/index.html',
  '/css/app.css',
  '/lib/qrcode.js',
  '/js/store.js', '/js/api.js', '/js/ui.js',
  '/js/views/dashboard.js', '/js/views/orders.js', '/js/views/report.js',
  '/js/views/basic.js', '/js/views/scan.js', '/js/views/stats.js',
  '/js/app.js', '/m/app.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 接口与跨域资源不缓存
  if (url.pathname.startsWith('/api/') || url.origin !== self.location.origin) return;

  // 页面导航：network-first，离线时回退缓存
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const cp = res.clone();
          caches.open(CACHE).then((c) => c.put(req, cp));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('/m/index.html')))
    );
    return;
  }

  // 静态资源：stale-while-revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const cp = res.clone();
            caches.open(CACHE).then((c) => c.put(req, cp));
          }
          return res;
        })
        .catch(() => cached);
      return cached || net;
    })
  );
});
