// 앱 화면 파일을 캐시해서 설치형 앱처럼 빠르게 열리도록 함.
// 상품 데이터/사진(Supabase)은 캐시하지 않고 항상 최신으로 가져옴.
const CACHE = 'vintage-v17';
// vendor/ 는 파일명에 버전이 들어 있어 내용이 바뀌지 않음 → 한 번 받으면 기기에 보관 (배경 지우기 모델 등 큰 파일)
const VENDOR = 'vintage-vendor-v1';
const SHELL = ['./', './index.html', './style.css', './app.js', './config.js', './vendor/supabase-2.118.0.js', './manifest.webmanifest', './icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== VENDOR).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // vendor/: 캐시 우선 (없을 때만 내려받아 저장)
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(
      caches.open(VENDOR).then((c) =>
        c.match(e.request).then(
          (hit) =>
            hit ||
            fetch(e.request).then((res) => {
              if (res.ok) c.put(e.request, res.clone());
              return res;
            })
        )
      )
    );
    return;
  }

  // 나머지: 네트워크 우선 → 실패하면(오프라인) 캐시
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
