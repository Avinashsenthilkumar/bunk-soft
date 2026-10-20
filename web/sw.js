/* ============================================================================
   BunkSoft offline shell.
   Caches the application files so a weak forecourt signal still opens the app.
   Data always goes to the network — a stale meter reading is worse than none.

   The admin console is deliberately excluded. It has no business being
   available offline, and caching it would leave an administrator's page sitting
   in the browser of whoever used that device next.
   ========================================================================== */
/* Bump this whenever a cached entry could be wrong. v6 cleared any copy of
   index.html that an earlier build saved against a .js url when the host
   answered a missing asset with the HTML shell — that poisoned entry kept the
   app blank even after the real file was deployed. v8 carries the panel and
   stat alignment in app.css and the password-reset landing in main.js; without
   the bump a returning phone keeps the old stylesheet and the old router. */
const CACHE = 'bunksoft-v8';
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
  /* A page may be answered with the shell; a script or a stylesheet never may. */
  const isPage = e.request.mode === 'navigate';
  const wantsCode = /\.(js|mjs|css|json|webmanifest)$/i.test(url.pathname);

  e.respondWith(
    fetch(e.request)
      .then(r => {
        /* Only cache a good, basic response. An error page or an opaque
           redirect saved here would be served for as long as the cache lives.

           And never cache HTML against a .js or .css URL. A host whose
           catch-all rewrite answers a missing asset with index.html returns a
           perfectly valid 200, and saving that poisons the entry until the
           cache name changes — the app then stays blank even after the real
           file is deployed. */
        const type = (r && r.headers && r.headers.get('content-type')) || '';
        const htmlForCode = wantsCode && /text\/html/i.test(type);
        if (r && r.ok && r.type === 'basic' && !htmlForCode) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return r;
      })
      .catch(async () => {
        const hit = await caches.match(e.request);
        if (hit) return hit;
        /* The shell stands in for a PAGE we cannot reach, and for nothing
           else. Handing index.html back for /js/app.js makes the browser
           parse HTML as a module — "Unexpected token '<'" — and the page is
           blank with no clue why. */
        if (isPage) {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        return new Response('', { status: 504, statusText: 'Offline, and not in the cache' });
      })
  );
});
