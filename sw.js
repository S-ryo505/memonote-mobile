/* MemoNote Mobile  サービスワーカー
   役割: 一度開けば、電波が無くても開けるようにする。
         🚗 自動車ニュースと 🤖 AIニュースも、圏外でそのまま読めるようにする。
         他のアプリから「共有」されたもの（文章・URL・HTMLファイル）を受け取る。

   前の版で圏外に出られなくなった原因:
     install で caches.addAll(...) を使っていました。addAll は「全部入るか、
     1つも入らないか」のどちらかです。並べた中に1つでも取れないものがあると
     控え（キャッシュ）が空のままになり、圏外でまったく開けなくなります。
     この版では1件ずつ入れて、取れなかったものは黙って飛ばします。

   更新: CACHE の数字を上げると、次に開いたときに新しいものへ入れ替わります。 */
const VERSION = "v5";
const CACHE   = "memonote-mobile-" + VERSION;
const SHARE   = "memonote-share";    /* 共有されたファイルの一時置き場 */

/* アプリ本体。圏外でも必ず開けるように、最初に控えておきます。 */
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable.png"
];
/* ニュースの2ページ。本文と中身（items.json）の両方を控えます。 */
const NEWS = [
  "./news/", "./news/index.html", "./news/items.json",
  "./ai/",   "./ai/index.html",   "./ai/items.json"
];

/* 1件ずつ控えに入れます。取れなかったものは飛ばすので、
   1つの取りこぼしで全部が無駄になることはありません。 */
async function warm(list){
  const c = await caches.open(CACHE);
  await Promise.all(list.map(async u => {
    try{
      const r = await fetch(u, {cache:"reload"});
      if(r && r.ok) await c.put(u, r);
    }catch(_){ }
  }));
}

self.addEventListener("install", e => {
  /* warm は失敗しても投げないので、install が転ぶことはありません */
  e.waitUntil(warm(SHELL.concat(NEWS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    await Promise.all(ks.filter(k => k !== CACHE && k !== SHARE).map(k => caches.delete(k)));
    await self.clients.claim();
    /* 圏外のまま入れ替わったときのために、ここでもう一度試します */
    warm(SHELL.concat(NEWS)).catch(() => {});
  })());
});

/* 画面側から「ニュースを控え直して」と言われたとき */
self.addEventListener("message", e => {
  const d = e.data || {};
  if(d.type === "refresh-news") e.waitUntil(warm(NEWS).catch(() => {}));
  if(d.type === "skip-waiting") self.skipWaiting();
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
  }catch(_){ }
  return Response.redirect(base.href, 303);
}

/* 控えから探します。?task=1 のような後ろの飾りは無視して照らし合わせます。 */
async function fromCache(req){
  const c = await caches.open(CACHE);
  return (await c.match(req, {ignoreSearch:true})) || null;
}
async function putCache(req, res){
  try{
    if(res && res.ok && res.type === "basic"){
      const c = await caches.open(CACHE);
      await c.put(req, res.clone());
    }
  }catch(_){ }
  return res;
}

/* 行き先に合わせた、最後の受け皿。真っ白な画面にしないためのものです。 */
async function fallbackFor(url){
  const p = url.pathname;
  const want = /\/news\//.test(p) ? "./news/index.html"
             : /\/ai\//.test(p)   ? "./ai/index.html"
             : "./index.html";
  const c = await caches.open(CACHE);
  return (await c.match(want)) ||
         (await c.match("./index.html")) ||
         (await c.match("./")) ||
         new Response(
           "<!doctype html><meta charset=utf-8>" +
           "<body style=\"background:#0E1420;color:#E4E9F2;font-family:sans-serif;padding:28px\">" +
           "<h3>まだ控えがありません</h3>" +
           "<p>一度だけ電波のあるところで開いてください。" +
           "次からは圏外でも開けるようになります。</p>",
           {headers:{"Content-Type":"text/html; charset=utf-8"}});
}

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  if(e.request.method === "POST" && url.pathname.endsWith("/share-target")){
    e.respondWith(receiveShare(e.request));
    return;
  }
  if(e.request.method !== "GET") return;
  if(url.origin !== self.location.origin) return;   /* よそのサイトには手を出しません */

  /* ニュースの中身だけは、電波があるときは新しいものを取りにいきます。
     取れなければ、前に取った控えをそのまま出します。 */
  if(/items\.json$/.test(url.pathname)){
    e.respondWith((async () => {
      try{
        const r = await fetch(e.request);
        if(r && r.ok){ putCache(e.request, r); return r; }
        throw new Error("bad status");
      }catch(_){
        return (await fromCache(e.request)) || fallbackFor(url);
      }
    })());
    return;
  }

  /* それ以外は、まず控えを出します（圏外でも必ず開ける）。
     そのうしろで新しいものを取りにいって、次回ぶんを入れ替えます。 */
  e.respondWith((async () => {
    const hit = await fromCache(e.request);
    if(hit){
      e.waitUntil((async () => {
        try{ const r = await fetch(e.request); await putCache(e.request, r); }catch(_){ }
      })());
      return hit;
    }
    try{
      const r = await fetch(e.request);
      putCache(e.request, r);
      return r;
    }catch(_){
      return fallbackFor(url);
    }
  })());
});
