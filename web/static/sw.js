// Offline cache for the web app shell and data. Version bump = new cache. AI calls are never cached.
const CACHE = 'sancho-panza-__VERSION__';
const SHELL = ['./', 'index.html', 'guide.html', 'styles.css', 'guide.css', 'web.css', 'theme.css', 'i18n.js', 'app.js', 'guide.js', 'coach-web.js', 'data/bundle.json', 'manifest.webmanifest', 'assets/icon.png', 'assets/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // API calls go straight to the network
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })));
});
