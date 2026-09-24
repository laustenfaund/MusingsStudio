/* Offline support. App files: network first, so updates show up; cache as fallback. */
const VERSION = "musings-v1";
const SHELL = ["./", "./index.html", "./app.js", "./drive.js", "./config.js", "./manifest.webmanifest",
  "./vendor/jszip.min.js", "./vendor/Sortable.min.js", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/favicon.svg"];
self.addEventListener("install", e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k.startsWith("musings-") && !k.endsWith("-fonts")).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; })
      .catch(() => caches.match(req).then(r => r || (req.mode === "navigate" ? caches.match("./index.html") : Response.error()))));
  } else if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(VERSION + "-fonts").then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(res => { c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
