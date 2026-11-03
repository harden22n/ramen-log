// オフラインでも画面が開けるように、アプリのファイルをスマホに置いておく係（サービスワーカー）
// ファイルを直したら CACHE の番号を上げる（上げないと古い画面のままになる）
const CACHE = 'ramenlog-v3';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'data/sapporo-ramen.json', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// 自分のファイルは「まずネット、だめなら置いておいた分」。地図（Overpass）への問い合わせには手を出さない
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
