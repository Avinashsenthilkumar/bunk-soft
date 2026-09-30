/* ============================================================================
   BunkSoft — proves the security headers protect the app without breaking it.
   Subsel Tech Solutions Pvt Ltd

     node test/headers.mjs

   A Content-Security-Policy that is too tight fails quietly: the page loads,
   one script does not, and nobody notices until a bunk cannot print a report.
   So this serves the real web/_headers rules and then loads both pages in a
   browser, failing on any policy violation the browser reports.

   It also checks the rules agree across web/_headers, netlify.toml,
   vercel.json and deploy/nginx.conf, since four copies of a policy is four
   chances for one to drift.
   ========================================================================== */
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';

const ROOT = path.resolve('web');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.webmanifest':'application/manifest+json',
  '.svg':'image/svg+xml', '.png':'image/png', '.txt':'text/plain' };

let pass = 0, fail = 0;
const ok = (label, v, extra) => {
  v ? pass++ : fail++;
  console.log((v ? '  PASS  ' : '  FAIL  ') + label);
  if (!v && extra) console.log('        ' + extra);
};

/* ---------------------------------------------------------- _headers ----- */
/* Cloudflare's format: a path pattern on its own line, then indented
   "Header: value" lines. Later matching blocks win, as the host does it. */
function parseHeaders(text) {
  const blocks = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) { cur = { pattern: line.trim(), headers: {} }; blocks.push(cur); }
    else if (cur) {
      const m = line.trim().match(/^([A-Za-z0-9-]+):\s*(.*)$/);
      if (m) cur.headers[m[1]] = m[2];
    }
  }
  return blocks;
}
const blocks = parseHeaders(fs.readFileSync(path.join(ROOT, '_headers'), 'utf8'));

const matches = (pattern, urlPath) => {
  const rx = new RegExp('^' + pattern.split('*').map(s =>
    s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return rx.test(urlPath);
};
function headersFor(urlPath) {
  const out = {};
  for (const b of blocks) if (matches(b.pattern, urlPath)) Object.assign(out, b.headers);
  return out;
}

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  if (p === '/admin' || p === '/admin/') p = '/admin/index.html';
  const file = path.join(ROOT, p);
  fs.readFile(file, (e, buf) => {
    const hdrs = headersFor(p.replace(/index\.html$/, ''));
    if (e) { res.writeHead(404, hdrs); return res.end('not found'); }
    res.writeHead(200, { ...hdrs, 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
    res.end(buf);
  });
});
await new Promise(r => server.listen(4176, r));
const BASE = 'http://127.0.0.1:4176';

console.log('\n1. Every page carries the header set');
for (const [label, url] of [['the bunk app', '/'], ['the admin console', '/admin/']]) {
  const r = await fetch(BASE + url);
  const h = n => r.headers.get(n) || '';
  ok(`${label} sends a Content-Security-Policy`, !!h('content-security-policy'));
  ok(`${label} sends X-Content-Type-Options: nosniff`, h('x-content-type-options') === 'nosniff');
  ok(`${label} refuses to be framed`, h('x-frame-options') === 'DENY'
    && /frame-ancestors 'none'/.test(h('content-security-policy')));
  ok(`${label} blocks plugins and base-tag hijacking`,
    /object-src 'none'/.test(h('content-security-policy'))
    && /base-uri 'none'/.test(h('content-security-policy')));
  ok(`${label} pins connect-src to Supabase and itself`,
    /connect-src 'self' https:\/\/\*\.supabase/.test(h('content-security-policy')));
  ok(`${label} allows no inline script`,
    !/script-src[^;]*'unsafe-inline'/.test(h('content-security-policy'))
    && !/script-src[^;]*'unsafe-eval'/.test(h('content-security-policy'))
    && !/default-src[^;]*'unsafe-inline'/.test(h('content-security-policy')));
}

console.log('\n2. The console is treated as more sensitive than the app');
{
  const a = await fetch(BASE + '/');
  const c = await fetch(BASE + '/admin/');
  ok('the console is marked noindex at the header level',
    /noindex/.test(c.headers.get('x-robots-tag') || ''));
  ok('the console is never cached',
    /no-store/.test(c.headers.get('cache-control') || ''));
  ok('the console leaks no referrer',
    (c.headers.get('referrer-policy') || '') === 'no-referrer');
  ok('the console does not allow the PDF CDN it has no use for',
    !/cdnjs\.cloudflare\.com/.test(c.headers.get('content-security-policy') || ''));
  ok('the app does allow the PDF CDN, which it needs for reports',
    /cdnjs\.cloudflare\.com/.test(a.headers.get('content-security-policy') || ''));
  ok('HSTS is set for a year',
    /max-age=31536000/.test(a.headers.get('strict-transport-security') || ''));
  ok('the camera, microphone and location are switched off',
    /camera=\(\)/.test(a.headers.get('permissions-policy') || '')
    && /microphone=\(\)/.test(a.headers.get('permissions-policy') || '')
    && /geolocation=\(\)/.test(a.headers.get('permissions-policy') || ''));
}

console.log('\n3. robots.txt asks crawlers away from the console');
{
  const r = await fetch(BASE + '/robots.txt');
  const t = await r.text();
  ok('robots.txt is served', r.status === 200);
  ok('it disallows the admin console', /Disallow:\s*\/admin\//.test(t));
}

console.log('\n4. The four copies of the policy agree');
{
  const grab = (file, rx) => {
    const m = fs.readFileSync(file, 'utf8').match(rx);
    return m ? m[1].trim() : null;
  };
  const fromHeaders = headersFor('/')['Content-Security-Policy'];
  const fromNetlify = grab('netlify.toml', /Content-Security-Policy = "([^"]+)"/);
  const fromVercel  = grab('vercel.json', /"Content-Security-Policy", "value": "([^"]+)"/);
  const fromNginx   = grab('deploy/nginx.conf', /add_header Content-Security-Policy "([^"]+)"/);
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  ok('netlify.toml matches web/_headers', norm(fromNetlify) === norm(fromHeaders),
    `netlify: ${norm(fromNetlify)}\n        headers: ${norm(fromHeaders)}`);
  ok('vercel.json matches web/_headers', norm(fromVercel) === norm(fromHeaders),
    `vercel:  ${norm(fromVercel)}`);
  ok('deploy/nginx.conf matches web/_headers', norm(fromNginx) === norm(fromHeaders),
    `nginx:   ${norm(fromNginx)}`);

  /* And the meta tag in each page, which is the same policy minus the
     directives a meta tag cannot carry. */
  const metaOf = f => {
    const m = fs.readFileSync(f, 'utf8')
      .match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
    return m ? m[1] : null;
  };
  const dirs = s => new Set(norm(s).split(';').map(x => x.trim().split(/\s+/)[0]).filter(Boolean));
  const appMeta = dirs(metaOf('web/index.html'));
  const appHdr  = dirs(fromHeaders);
  const metaCannot = new Set(['frame-ancestors', 'upgrade-insecure-requests']);
  const missing = [...appHdr].filter(d => !appMeta.has(d) && !metaCannot.has(d));
  ok('the page meta policy covers the same directives as the header',
    missing.length === 0, 'missing from meta: ' + missing.join(', '));
}

console.log('\n5. Both pages load with no policy violation');
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome']
  .find(fs.existsSync);
const b = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });

const violations = [], errs = [];
await page.addInitScript(() => {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', e =>
    window.__csp.push(e.effectiveDirective + ' blocked ' + e.blockedURI));
});
page.on('console', m => {
  const t = m.text();
  if (/Content Security Policy|Refused to/i.test(t)) violations.push(t);
  else if (m.type() === 'error' && !/favicon|net::ERR|TUNNEL/i.test(t)) errs.push(t);
});
page.on('pageerror', e => errs.push(e.message));

/* The fake backend stands in for Supabase; the CSP is still evaluated against
   the real CDN and font URLs, which is the point of the exercise. */
await page.route('**/js/config.js', r => r.fulfill({ status: 200, contentType: 'text/javascript',
  headers: headersFor('/js/config.js'),
  body: `window.BUNKSOFT_CONFIG={supabaseUrl:'https://demo.supabase.co',supabaseAnonKey:'${'x'.repeat(60)}'};` }));
await page.route('**/@supabase/supabase-js**', r => r.fulfill({ status: 200,
  contentType: 'text/javascript', body: fs.readFileSync('test/fake-supabase.js', 'utf8') }));
await page.route('**/fonts.googleapis.com/**', r => r.fulfill({ status: 200,
  contentType: 'text/css', body: '' }));
/* Stubbed so this measures the policy, not the workspace's internet access.
   CSP is evaluated against the request URL, which is still the real cdnjs. */
await page.route('**/cdnjs.cloudflare.com/**', r => r.fulfill({ status: 200,
  contentType: 'text/javascript', body: 'window.jspdf={jsPDF:function(){}};' }));

for (const [label, url, probe] of [
  ['the bunk app', '/', '#au_email'],
  ['the admin console', '/admin/', '#ai_email']
]) {
  violations.length = 0; errs.length = 0;
  await page.goto(BASE + url, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const inPage = await page.evaluate(() => window.__csp || []);
  ok(`${label} renders its sign-in under the policy`, !!(await page.$(probe)));
  ok(`${label} reports no CSP violation`, violations.length === 0 && inPage.length === 0,
    [...violations, ...inPage].slice(0, 4).join('\n        '));
  ok(`${label} loads the Supabase client despite the policy`,
    await page.evaluate(() => typeof window.__T !== 'undefined' || !!document.querySelector('#gate')));
  ok(`${label} has no other JavaScript error`, errs.length === 0,
    errs.slice(0, 3).join('\n        '));
}

console.log('\n6. A report still downloads under the policy');
{
  violations.length = 0;
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const loaded = await page.evaluate(async () => {
    /* The same CDN fetch app.js makes for the first PDF. */
    try {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
        s.onload = res; s.onerror = () => rej(new Error('blocked'));
        document.head.appendChild(s);
      });
      return 'loaded';
    } catch (e) { return 'blocked: ' + e.message; }
  });
  ok('the PDF library is allowed to load from cdnjs', loaded === 'loaded', loaded);
  ok('loading it raised no violation', violations.length === 0,
    violations.slice(0, 3).join('\n        '));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
await b.close(); server.close();
process.exit(fail ? 1 : 0);
