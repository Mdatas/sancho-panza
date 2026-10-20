// Offline support for the web app. Network first (so a new version shows up on the next load), cache as fallback.
// AI / API calls are never cached (only same-origin GETs).
const CACHE = 'sancho-panza-0.19.0';
const SHELL = [
  './',
  'index.html',
  'guide.html',
  'styles.css',
  'guide.css',
  'theme.css',
  'web.css',
  'i18n.js',
  'app.js',
  'guide.js',
  'coach-web.js',
  'data/bundle.json?v=0.19.0',
  'data/rtsbuilds.json?v=0.19.0',
  'data/notes.json?v=0.19.0',
  'manifest.webmanifest',
  'assets/icon.png',
  'assets/icon-192.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const isImg = /\/(img|fonts)\//.test(u.pathname);
  if (isImg) {
    // immutable assets: cache first
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((r) => {
            if (r.ok) caches.open(CACHE).then((c) => c.put(e.request, r.clone()));
            return r;
          })
      )
    );
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) caches.open(CACHE).then((c) => c.put(e.request, r.clone()));
        return r;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html')))
  );
});
