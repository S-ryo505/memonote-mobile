/* MemoNote Mobile  サービスワーカー
   役割: 一度開けば、電波が無くても開けるようにする。
         他のアプリから「共有」されたもの（文章・URL・HTMLファイル）を受け取る。
   更新: CACHE の数字を上げると、次に開いたときに新しいものへ入れ替わります。 */
const CACHE = "memonote-mobile-v3";
const SHARE = "memonote-share";      /* 共有されたファイルを、アプリが開くまで一時的に置く場所 */
const FILES = [
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable.png",
  /* 🚗 / 🤖 ニュースも、一度も開いていなくても圏外で読めるように最初から控えておく */
  "./news/", "./news/index.html", "./news/items.json",
  "./ai/",   "./ai/index.html",   "./ai/items.json"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== SHARE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 共有の受け口（manifest の share_target が POST でここに送ってくる） */
async function receiveShare(req){
  const base = new URL("./index.html", self.registration.scope);
  try{
    const fd = await req.formData();
    const file = fd.get("file");
    if(file && typeof file !== "string" && file.size){
      const c = await caches.open(SHARE);
      await c.put("./shared-file", new Response(file, {headers:{
        "Content-Type": file.type || "text/html",
        "X-File-Name": encodeURIComponent(file.name || "shared.html")
      }}));
      base.searchParams.set("sharedfile", "1");
    }else{
      for(const k of ["title","text","url"]){
        const v = fd.get(k);
        if(v) base.searchParams.set(k, v);
      }
    }
  }catch(_){}
  return Response.redirect(base.href, 303);
}

/* まずネットを試し、駄目なら控えを返します。
   これで、更新が届くのに、圏外でも開けます。 */
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if(e.request.method === "POST" && url.pathname.endsWith("/share-target")){
    e.respondWith(receiveShare(e.request));
    return;
  }
  if(e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});
