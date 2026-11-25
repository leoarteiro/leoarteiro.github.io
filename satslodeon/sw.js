// Caches only the app shell; videos and posters always come from the network.
// Also hosts WebTorrent's worker, which serves P2P video to <video> under /webtorrent/.
importScripts("vendor/sw-webtorrent.min.js");
const CACHE = "satslodeon-shell-v7";
const SHELL = ["./", "index.html", "css/style.css", "js/app.js", "js/blossom.js", "js/lightning.js", "js/texts.js", "icon.svg", "manifest.webmanifest", "vendor/qrcode.min.js"];

self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  if (url.pathname.includes("/webtorrent/")) return; // answered by WebTorrent's worker
  // Network first so new versions show up; cache is the offline fallback.
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request)));
});
