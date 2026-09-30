/* ============================================================================
   BunkSoft offline shell.
   Caches the application files so a weak forecourt signal still opens the app.
   Data always goes to the network — a stale meter reading is worse than none.

   The admin console is deliberately excluded. It has no business being
   available offline, and caching it would leave an administrator's page sitting
   in the browser of whoever used that device next.
   ========================================================================== */
const CACHE = 'bunksoft-v2';
const SHELL = ['./index.html', './css/app.css', './js/config.js', './js/main.js',
               './js/app.js', './js/db.js', './manifest.webmanifest', './icons/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      /* One missing file must not sink the whole install. */
      .then(c => Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;          /* Supabase and CDNs: always live */
  if (url.pathname.includes('/admin')) return;         /* never cache the console */
  e.respondWith(
    fetch(e.request)
      .then(r => {
        /* Only cache a good, basic response. An error page or an opaque
           redirect saved here would be served for as long as the cache lives. */
        if (r && r.ok && r.type === 'basic') {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
