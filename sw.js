/* Finanzas Gonzo · service worker: avisos push, número en el ícono y uso sin conexión.
   Nunca guarda nada de Supabase (tus datos y tu sesión): solo la app, la librería, los íconos y los logos de las acciones. */
const V = 'fin-app-3', META = 'fin-meta';
const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
const SHELL = ['./', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon-32.png', CDN];
const STATIC_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com', 'static.svvytrdr.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: 'reload' }))))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(K => Promise.all(K.filter(k => k !== V && k !== META).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const put = (req, res) => { if (res && (res.ok || res.type === 'opaque')) { const c = res.clone(); caches.open(V).then(x => x.put(req, c)).catch(() => {}); } return res; };
const timeout = (p, ms) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error('timeout')), ms))]);

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.hostname.endsWith('supabase.co') || u.hostname.endsWith('supabase.in')) return; // datos y sesión: siempre directo
  const same = u.origin === self.location.origin;
  // la app: primero la red (para recibir versiones nuevas), si no hay conexión la última copia
  if (req.mode === 'navigate') {
    e.respondWith(timeout(fetch(req), 6000).then(r => { if (r.ok) caches.open(V).then(c => c.put('./', r.clone())).catch(() => {}); return r; })
      .catch(() => caches.match('./').then(r => r || caches.match(req, { ignoreSearch: true })).then(r => r || Response.error())));
    return;
  }
  if (same && u.searchParams.has('x')) return; // chequeo de versión nueva: directo
  // librerías, fuentes e íconos: primero la copia guardada
  if (STATIC_HOSTS.includes(u.hostname) || (same && /\.(png|svg|webmanifest|woff2?)$/.test(u.pathname))) {
    e.respondWith(caches.match(req, { ignoreSearch: same }).then(r => r || fetch(req).then(x => put(req, x))));
    return;
  }
});

/* número en el ícono: la app guarda el valor actual; cada aviso nuevo le suma uno */
async function bumpBadge() {
  try {
    const key = new URL('__badge', self.registration.scope).href, c = await caches.open(META), r = await c.match(key);
    const n = (r ? (+(await r.text()) || 0) : 0) + 1;
    await c.put(key, new Response(String(n)));
    if (self.navigator.setAppBadge) await self.navigator.setAppBadge(n);
  } catch (e) {}
}
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || 'Finanzas Gonzo', { body: d.body || '', tag: d.tag || undefined, icon: 'icon-192.png', badge: 'icon-192.png', data: { url: d.url || '#', tag: d.tag || '' } }),
    bumpBadge()
  ]));
});
/* tocar un aviso abre la sección (y la tenencia, si el aviso es de una) */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const dt = e.notification.data || {}, base = dt.url || '#', go = base !== '#' && dt.tag ? base + '~' + dt.tag : base;
  const u = new URL(go, self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(L => {
    for (const c of L) { if (c.url.startsWith(self.registration.scope)) { c.postMessage({ go }); return c.focus(); } }
    return self.clients.openWindow(u);
  }));
});
