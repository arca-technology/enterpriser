// Service worker do ENTERPRISER • CMS (PWA).
// Não guarda o app em cache: tudo vem sempre da rede, para cada deploy aparecer na hora.
// Só a página "sem conexão" fica guardada, para quando a internet cair.
const OFFLINE_CACHE = "enterpriser-cms-offline-v1";
const OFFLINE_URL = "/cms-offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" }))));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== OFFLINE_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});
