/* ============================================================================
   BunkSoft — the offline shell must never answer code with HTML
   Subsel Tech Solutions Pvt Ltd

   On 14 October the live site went blank after a refresh. The cause was two
   fallbacks lining up: the host's catch-all rewrite answers an unknown path
   with index.html, so a missing /js/app.js came back as a 200 page of HTML;
   and the service worker, on a network failure, handed index.html back for
   any request at all. Either way the browser was given HTML where it had
   asked for a JavaScript module, threw "Unexpected token '<'", and rendered
   nothing — with no error visible on the page.

   This drives the real web/sw.js in a stubbed worker scope.

     node test/sw.mjs
   ========================================================================== */
import fs from 'fs';
import vm from 'vm';

let pass = 0, fail = 0;
const ok = (l, v, extra) => { v ? pass++ : fail++;
  console.log((v ? '  PASS  ' : '  FAIL  ') + l + (v || extra === undefined ? '' : '\n         ' + extra)); };

/* ---- a minimal service-worker scope ---------------------------------- */
function loadWorker({ network, cached = {} }) {
  const listeners = {};
  const store = { ...cached };           /* url -> {body, type} */
  const put = [];                        /* what the worker chose to cache */

  const mkRes = (body, { status = 200, type = 'basic', contentType = 'text/plain' } = {}) => ({
    ok: status >= 200 && status < 300, status, type, body,
    headers: { get: k => (k.toLowerCase() === 'content-type' ? contentType : null) },
    clone() { return mkRes(body, { status, type, contentType }); }
  });

  const scope = {
    console,
    URL, Request: class { constructor(u) { this.url = u; } },
    Response: class { constructor(body, init = {}) {
      this.body = body; this.status = init.status ?? 200;
      this.statusText = init.statusText || ''; this.ok = this.status < 300; } },
    location: { origin: 'https://bunk-soft.vercel.app' },
    self: {
      addEventListener: (k, fn) => { listeners[k] = fn; },
      skipWaiting: () => {}, clients: { claim: () => {} }
    },
    caches: {
      open: async () => ({ put: async (req, res) => { put.push(String(req.url || req)); },
                           add: async () => {} }),
      keys: async () => [], delete: async () => {},
      match: async req => {
        const u = String(req && req.url ? req.url : req);
        const key = Object.keys(store).find(k => u.endsWith(k));
        if (!key) return undefined;
        const c = store[key];
        return mkRes(c.body, { contentType: c.type });
      }
    },
    fetch: async req => {
      const r = network(String(req.url));
      if (r instanceof Error) throw r;
      return mkRes(r.body, { status: r.status ?? 200, type: 'basic', contentType: r.type });
    }
  };
  scope.globalThis = scope;
  vm.createContext(scope);
  vm.runInContext(fs.readFileSync('web/sw.js', 'utf8'), scope);

  /* Run the fetch handler and hand back whatever it responded with. */
  const handle = (url, mode = 'no-cors') => new Promise(resolve => {
    let answered = false;
    listeners.fetch({
      request: { url, method: 'GET', mode },
      respondWith: p => { answered = true; Promise.resolve(p).then(resolve); }
    });
    if (!answered) resolve('PASSTHROUGH');
  });
  return { handle, put };
}

const HTML = '<!doctype html><html><body>BunkSoft</body></html>';

console.log('1. A host that rewrites a missing asset to index.html');
{
  /* Vercel/Netlify catch-all: /js/app.js is absent, so the HTML shell comes
     back with a perfectly valid 200. The worker must not keep it. */
  const w = loadWorker({ network: () => ({ body: HTML, type: 'text/html', status: 200 }) });
  const r = await w.handle('https://bunk-soft.vercel.app/js/app.js');
  ok('the response is passed through to the browser, which reports the real error',
     r && r.body === HTML);
  ok('but HTML is NOT cached against a .js url', w.put.length === 0, JSON.stringify(w.put));
}

console.log('\n2. A genuine script is still cached');
{
  const w = loadWorker({ network: () => ({ body: 'export const a=1;', type: 'text/javascript' }) });
  await w.handle('https://bunk-soft.vercel.app/js/app.js');
  ok('a real module is cached for offline use', w.put.length === 1, JSON.stringify(w.put));
}

console.log('\n3. The network is down and the file was never cached');
{
  const w = loadWorker({ network: () => new Error('offline') });
  const r = await w.handle('https://bunk-soft.vercel.app/js/app.js');
  ok('a script request does NOT get the HTML shell', !(r && String(r.body).includes('<!doctype')),
     JSON.stringify(r && r.body).slice(0, 80));
  ok('it gets an honest failure instead', r && r.status === 504, 'status ' + (r && r.status));
}

console.log('\n4. A page request offline still gets the shell');
{
  const w = loadWorker({ network: () => new Error('offline'),
                         cached: { 'index.html': { body: HTML, type: 'text/html' } } });
  const r = await w.handle('https://bunk-soft.vercel.app/', 'navigate');
  ok('the app still opens offline', r && String(r.body).includes('BunkSoft'));
}

console.log('\n5. A cached script is served when the network fails');
{
  const w = loadWorker({ network: () => new Error('offline'),
                         cached: { '/js/app.js': { body: 'export const a=1;', type: 'text/javascript' } } });
  const r = await w.handle('https://bunk-soft.vercel.app/js/app.js');
  ok('the cached module comes back, not the shell', r && String(r.body).includes('export const'));
}

console.log('\n6. The admin console is never touched');
{
  const w = loadWorker({ network: () => ({ body: 'x', type: 'text/html' }) });
  const r = await w.handle('https://bunk-soft.vercel.app/admin/admin.js');
  ok('the worker does not intercept it at all', r === 'PASSTHROUGH', String(r));
}

/* ------------------------------------------------------------------------ */
/* The hosting configs decide whether a missing asset 404s or comes back as
   HTML, and a malformed vercel.json fails the deployment outright — which is
   how an unknown "//" comment key once took the build down. Both are checked
   here because both are delivery, same as the worker above. */
console.log('\n7. vercel.json is valid and does not swallow assets');
{
  const raw = fs.readFileSync('vercel.json', 'utf8');
  let cfg = null, parsed = true;
  try { cfg = JSON.parse(raw); } catch { parsed = false; }
  ok('it is valid JSON', parsed);

  /* Vercel validates each entry strictly; anything else fails the build. */
  const ALLOWED = { rewrites: ['source','destination','has','missing'],
                    redirects: ['source','destination','permanent','statusCode','has','missing'],
                    headers: ['source','headers','has','missing'] };
  const strays = [];
  for (const [key, allowed] of Object.entries(ALLOWED))
    for (const entry of (cfg?.[key] || []))
      for (const k of Object.keys(entry))
        if (!allowed.includes(k)) strays.push(key + '.' + k);
  ok('no entry carries a key Vercel would reject', strays.length === 0, strays.join(', '));

  const TOP = ['$schema','outputDirectory','cleanUrls','trailingSlash','headers','rewrites',
               'redirects','buildCommand','framework','installCommand','regions','functions',
               'public','github','ignoreCommand','devCommand','crons','images','rootDirectory'];
  const badTop = Object.keys(cfg || {}).filter(k => !TOP.includes(k));
  ok('no unknown top-level key', badTop.length === 0, badTop.join(', '));

  /* The catch-all must not answer an asset path. */
  const fallback = (cfg?.rewrites || []).find(r => r.destination === '/index.html'
    && !String(r.source).includes('admin/'));
  ok('a catch-all to the shell exists', !!fallback);
  if (fallback) {
    const re = new RegExp('^' + String(fallback.source).slice(1) + '$');
    for (const asset of ['js/app.js','js/db.js','css/app.css','icons/icon.svg'])
      ok('/' + asset + ' is not rewritten to the shell', !re.test(asset));
    ok('an ordinary route still is', re.test('some/deep/route'));
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
