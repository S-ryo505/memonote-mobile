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
const VERSION = "v6";
const CACHE   = "memonote-mobile-" + VERSION;
const SHARE   = "memonote-share";    /* 共有されたファイルの一時置き場 */
const CFG     = "memonote-cfg";      /* 通知の設定と履歴（localStorage はここから読めないため） */

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
    await Promise.all(ks.filter(k => k !== CACHE && k !== SHARE && k !== CFG)
                        .map(k => caches.delete(k)));
    await self.clients.claim();
    /* 圏外のまま入れ替わったときのために、ここでもう一度試します */
    warm(SHELL.concat(NEWS)).catch(() => {});
  })());
});

/* =====================================================================
   整理して通知する
   毎朝の 🚗/🤖 から「時計で読める長さ」のまとめを作って、
   スマホの通知として出します。時計（Mi Fitness で通知を許したもの）には
   そのスマホの通知がそのまま転送されます。

   設定と履歴は localStorage ではなく Cache に置きます。
   サービスワーカーからは localStorage が読めないためです。
   ===================================================================== */
const NOTIFY_DEF = {
  on:false,          /* 毎朝うけとるか */
  hour:7,            /* 何時以降に出すか */
  car:true, ai:true, todo:true,
  perSrc:3,          /* 1つの出どころから何件まで */
  minPrio:2,         /* 重要度 ●● 以上だけ（1=全部, 3=●●●のみ） */
  chars:26,          /* 1行の長さ */
  maxBody:180,       /* 本文ぜんたいの長さ。時計は長文を切るので短めに */
  counts:null        /* 画面側が入れてくれる ToDo の残り数 */
};
async function cfgGet(key, def){
  try{
    const c = await caches.open(CFG);
    const r = await c.match("./" + key);
    if(!r) return def;
    return Object.assign({}, def, await r.json());
  }catch(_){ return def; }
}
async function cfgPut(key, obj){
  try{
    const c = await caches.open(CFG);
    await c.put("./" + key, new Response(JSON.stringify(obj),
      {headers:{"Content-Type":"application/json"}}));
  }catch(_){ }
}
const notifyCfg   = () => cfgGet("notify-config", NOTIFY_DEF);
const notifyState = () => cfgGet("notify-state", {ids:[], at:"", day:""});

/* 長い見出しを、時計で読める長さに詰めます。
   途中で切るときは、読点があればそこで切ると自然に終わります。 */
function clip(s, n){
  s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  if(s.length <= n) return s;
  const cut = s.slice(0, n);
  const m = cut.lastIndexOf("、");
  if(m >= Math.floor(n * 0.6)) return cut.slice(0, m);
  return cut + "…";
}
const pad2 = n => String(n).padStart(2, "0");
function today(){
  const d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth()+1) + "-" + pad2(d.getDate());
}
/* items.json を読みます。圏外なら控えから出ます（fetch ハンドラが面倒を見ます）。 */
async function readItems(url){
  try{
    const r = await fetch(url, {cache:"no-store"});
    if(r && r.ok) return await r.json();
  }catch(_){ }
  try{
    const c = await caches.open(CACHE);
    const r = await c.match(url, {ignoreSearch:true});
    if(r) return await r.json();
  }catch(_){ }
  return null;
}
/* 出どころ1つぶんの行を作ります。前に知らせたものは外します。 */
function pickLines(data, mark, cfg, seen){
  const items = (data && data.items) || [];
  return items
    .filter(it => it && it.id && (it.prio || 1) >= cfg.minPrio)
    .filter(it => seen.indexOf(it.id) < 0)
    .sort((a, b) => {
      if(a.date !== b.date) return a.date < b.date ? 1 : -1;
      if((a.kind === "flash") !== (b.kind === "flash")) return a.kind === "flash" ? -1 : 1;
      return (b.prio || 0) - (a.prio || 0);
    })
    .slice(0, cfg.perSrc)
    .map(it => ({id:it.id, line:mark + " " + clip((it.ja && it.ja.title) || "", cfg.chars)}));
}
/* まとめを1つ作ります。fresh=true なら「前に知らせたか」を見ません（お試し用）。 */
async function buildDigest(fresh){
  const cfg = await notifyCfg();
  const st  = await notifyState();
  const seen = fresh ? [] : (st.ids || []);
  const rows = [];
  if(cfg.car) rows.push(...pickLines(await readItems("./news/items.json"), "🚗", cfg, seen));
  if(cfg.ai)  rows.push(...pickLines(await readItems("./ai/items.json"),   "🤖", cfg, seen));

  /* ToDo の行は最後に必ず付けたいので、先に長さを押さえておきます */
  const c = cfg.counts;
  let tail = "";
  if(cfg.todo && c && (c.todo || c.waiting || c.keep)){
    const bits = [];
    if(c.todo)    bits.push("ToDo " + c.todo);
    if(c.waiting) bits.push("待ち " + c.waiting);
    if(c.keep)    bits.push("覚書 " + c.keep);
    tail = "✓ " + bits.join(" ・ ");
  }
  /* 本文ぜんたいが長すぎると時計側で切られるので、入らない行は落とします */
  const budget = cfg.maxBody - (tail ? tail.length + 1 : 0);
  let body = "";
  for(const r of rows){
    const next = body ? body + "\n" + r.line : r.line;
    if(next.length > budget) break;
    body = next;
  }
  const used = body ? body.split("\n").length : 0;
  if(tail) body = body ? body + "\n" + tail : tail;
  const d = new Date();
  const title = (d.getMonth()+1) + "/" + d.getDate() + " の要点";
  const open = cfg.car && rows.some(r => r.line.indexOf("🚗") === 0) ? "./news/"
             : cfg.ai  && rows.some(r => r.line.indexOf("🤖") === 0) ? "./ai/"
             : "./index.html";
  /* 実際に本文へ載せたぶんだけを「知らせた」ことにします */
  const ids = rows.slice(0, used).map(r => r.id);
  return {title:title, body:body, ids:ids, n:used,
          empty:!used && !tail, open:open, cfg:cfg};
}
/* 実際に通知を出し、何を知らせたかを覚えます。 */
async function showDigest(fresh){
  const g = await buildDigest(fresh);
  if(g.empty && !g.body) return {ok:false, why:"new"};
  await self.registration.showNotification("MemoNote ・ " + g.title, {
    body: g.body,
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    tag: "memonote-digest",
    renotify: true,
    silent: false,
    data: {url:g.open}
  });
  const st = await notifyState();
  const ids = [...new Set([...(st.ids || []), ...g.ids])].slice(-400);
  await cfgPut("notify-state", {ids:ids, at:new Date().toISOString(), day:today()});
  return {ok:true, n:g.n, title:g.title, body:g.body};
}

/* 毎朝の自動。Chrome が頃合いを見て呼びます（時刻は指定できません）。
   設定した時刻より前、またはその日もう出したときは、何もしません。 */
self.addEventListener("periodicsync", e => {
  if(e.tag !== "memonote-digest") return;
  e.waitUntil((async () => {
    const cfg = await notifyCfg();
    if(!cfg.on) return;
    const st = await notifyState();
    if(st.day === today()) return;
    if(new Date().getHours() < (cfg.hour || 0)) return;
    await warm(NEWS).catch(() => {});
    await showDigest(false).catch(() => {});
  })());
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const want = (e.notification.data && e.notification.data.url) || "./index.html";
  e.waitUntil((async () => {
    const url = new URL(want, self.registration.scope).href;
    const cs = await self.clients.matchAll({type:"window", includeUncontrolled:true});
    for(const c of cs){
      if(c.url.indexOf(self.registration.scope) === 0 && "focus" in c){
        try{ await c.navigate(url); }catch(_){ }
        return c.focus();
      }
    }
    if(self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

/* 画面側とのやりとり */
self.addEventListener("message", e => {
  const d = e.data || {};
  const reply = v => { try{ (e.ports && e.ports[0]) && e.ports[0].postMessage(v); }catch(_){ } };
  if(d.type === "refresh-news") return e.waitUntil(warm(NEWS).catch(() => {}));
  if(d.type === "skip-waiting") return self.skipWaiting();
  if(d.type === "save-cfg")
    return e.waitUntil(notifyCfg().then(c => cfgPut("notify-config",
      Object.assign({}, c, d.cfg || {}))).then(() => reply({ok:true})));
  if(d.type === "get-cfg")
    return e.waitUntil(Promise.all([notifyCfg(), notifyState()])
      .then(([c, st]) => reply({ok:true, cfg:c, state:st})));
  if(d.type === "digest")
    return e.waitUntil(buildDigest(!!d.fresh).then(g => reply({ok:true, digest:g}))
      .catch(err => reply({ok:false, why:String(err)})));
  if(d.type === "notify")
    return e.waitUntil(warm(NEWS).catch(() => {})
      .then(() => showDigest(!!d.fresh)).then(r => reply(r))
      .catch(err => reply({ok:false, why:String(err)})));
  if(d.type === "forget")
    return e.waitUntil(cfgPut("notify-state", {ids:[], at:"", day:""})
      .then(() => reply({ok:true})));
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
