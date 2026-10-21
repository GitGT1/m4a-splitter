/* Offline cache for the app shell, and the Android share-target inbox. */
const VERSION = 'm4asplit-v2';
const SHELL = [
  './', 'index.html', 'app.js', 'm4a.js', 'analysis.js', 'subtitles.js', 'transcribe.js', 'manifest.json',
  'vendor/mp4box.all.min.js', 'vendor/mp4-muxer.js', 'vendor/jszip.min.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'share-inbox').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Share target: park the shared files, then open the app.
  if (e.request.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const inbox = await caches.open('share-inbox');
      const files = form.getAll('audio');
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        await inbox.put(new Request(`./shared/${Date.now()}-${i}`), new Response(f, {
          headers: { 'content-type': f.type || 'audio/mp4', 'x-name': encodeURIComponent(f.name || 'shared.m4a') },
        }));
      }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Stale-while-revalidate: instant from cache, refreshed in the background.
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((res) => {
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
