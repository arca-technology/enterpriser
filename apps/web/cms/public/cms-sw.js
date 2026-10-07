// Service worker do ENTERPRISER • CMS (PWA).
// Não guarda o app em cache: tudo vem sempre da rede, para cada deploy aparecer na hora.
// Só a página "sem conexão" fica guardada, para quando a internet cair.
const OFFLINE_CACHE = "enterpriser-cms-offline-v1";
const OFFLINE_URL = "/cms-offline.html";
// Arquivos recebidos pelo "Compartilhar" do Android (ex.: WhatsApp → Exportar
// conversa) ficam aqui até o CMS abrir e importar.
const SHARE_CACHE = "enterpriser-share";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" }))));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== OFFLINE_CACHE && key !== SHARE_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll("file").filter((file) => file && typeof file === "object" && file.size);
    const cache = await caches.open(SHARE_CACHE);
    await Promise.all(files.map((file, index) => cache.put(
      `/cms/shared/${Date.now()}-${index}`,
      new Response(file, { headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name || `conversa-${index}.zip`) } })
    )));
  } catch (_error) {
    // Se falhar, o CMS abre normalmente e o usuário pode importar pelo menu.
  }
  return Response.redirect("/cms?share-target=1", 303);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname === "/cms/share-target") {
    event.respondWith(receiveShare(event.request));
    return;
  }
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});
