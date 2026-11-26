// 더그아웃! 서비스 워커 — 앱 화면을 기기에 저장해 두고, 새 판이 있으면 인터넷에서 먼저 받아 옴
const CACHE = 'dugout-v1.1.0';
const SHELL = ['./', './index.html', './js/app.js', './js/crypto.js', './js/store.js', './firebase-config.js', './icon.svg', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 파이어베이스 SDK·글꼴은 판 번호가 고정된 주소라 저장본을 먼저 씀
  if (/^(www\.gstatic\.com|fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net)$/.test(url.hostname)) {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => { if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); } return res; })));
    return;
  }
  if (url.origin !== location.origin) return; // 로그인·데이터 요청은 건드리지 않음
  // 앱 파일: 인터넷 먼저, 안 되면 저장본
  e.respondWith(fetch(req).then(res => { if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); } return res; })
    .catch(() => caches.match(req).then(r => r || caches.match('./index.html'))));
});
