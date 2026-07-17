const CACHE = "glamaterials-v4";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./assets/watermark-data.js",
  "./assets/frame-data.js",
  "./vendor/pdf-lib.min.js",
  "./vendor/pdf.min.js",
  "./vendor/pdf.worker.min.js",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
];

// Heavy, rarely-changing libraries — safe to serve straight from cache once fetched.
const CACHE_FIRST_PATHS = ["/vendor/", "/assets/icons/", "/assets/watermark", "/assets/frame"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  const isCacheFirst = CACHE_FIRST_PATHS.some((p) => new URL(req.url).pathname.includes(p));

  if (isCacheFirst) {
    // Cache-first: instant on repeat visits, these files rarely change.
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE).then((cache) => cache.put(req, res.clone()));
        return res;
      }))
    );
    return;
  }

  // Network-first for the app shell (html/css/js/manifest): whenever online, always
  // pick up the latest deploy instead of being stuck on whatever got cached once.
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok) caches.open(CACHE).then((cache) => cache.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req))
  );
});
