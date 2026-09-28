/* BunkSoft offline shell.
   Caches the app files so a weak forecourt signal still opens the app.
   Data always goes to the network — we never serve stale readings. */
const CACHE = 'bunksoft-v1';
const SHELL = ['./index.html','./css/app.css','./js/config.js','./js/main.js',
               './js/app.js','./js/db.js','./manifest.webmanifest','./icons/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;            // Supabase and CDNs: always live
  e.respondWith(
    fetch(e.request)
      .then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
