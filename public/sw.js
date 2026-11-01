// 只缓存外壳：HTML / JS / CSS / 图标。房间数据永远走网络，不缓存。
const CACHE = 'wenxuesha-v5'
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/manifest.json', '/icon-192.png', '/icon-512.png', '/sea.svg']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  // 只管同源的静态资源，接口和 WebSocket 一律放行
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return
  e.respondWith(
    caches.match(e.request).then((hit) => hit ?? fetch(e.request).then((res) => {
      const copy = res.clone()
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {})
      return res
    }).catch(() => caches.match('/index.html'))),
  )
})
