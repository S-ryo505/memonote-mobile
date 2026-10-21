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
const VERSION = "v8";
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
  perSrc:2,          /* 1つの出どころから何件まで */
  minPrio:2,         /* 重要度 ●● 以上だけ（1=全部, 3=●●●のみ） */
  mode:"wrap",       /* wrap=折り返して全文 / clip=1行に収めて … で切る */
  chars:26,          /* 1行ぜんたいの長さ（行頭の 🚗 を含む） */
  maxBody:250,       /* 本文ぜんたいの長さ。0 なら制限なし */
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
/* src は出どころごとの記録。{car:{updated,at,day}, ai:{…}} の形です。 */
const notifyState = () => cfgGet("notify-state", {ids:[], at:"", day:"", src:{}, todoDay:""});

/* 見出しの下ごしらえ。
   【参考・5月】のような前置きや（カッコ書き）、「〜と報じた」のような
   言い回しを外します。意味は変えず、字数だけを減らすものだけにしています。 */
const TIDY_SUB = [
  ["について","の"], ["に関する","の"], ["ならびに","・"], ["および","・"],
  ["することが分かった",""], ["することが明らかに",""], ["を明らかにした",""],
  ["を発表した","発表"], ["と発表した","発表"], ["との報道",""], ["と報じた",""],
  ["と報道",""], ["の見通し",""], ["株式会社",""]
];
const TIDY_TAIL = ["と報じられる", "との情報", "の見込み", "とのこと"];
function tidy(t){
  t = String(t == null ? "" : t);
  t = t.replace(/【[^】]{0,24}】/g, "").replace(/[（(][^）)]{0,20}[）)]/g, "");
  t = t.replace(/\s+/g, " ").replace(/^[\s　・、,]+|[\s　・、,]+$/g, "");
  for(const [a, b] of TIDY_SUB) t = t.split(a).join(b);
  for(let k = 0; k < 3; k++)
    for(const x of TIDY_TAIL)
      if(t.endsWith(x)) t = t.slice(0, -x.length).replace(/[、\s　]+$/, "");
  return t.replace(/^[\s　、]+|[\s　、]+$/g, "");
}
/* 1行に収めるとき。読点があればそこで終わらせると自然です。 */
function clip(s, n){
  s = tidy(s);
  if(s.length <= n) return s;
  const cut = s.slice(0, n);
  const m = cut.lastIndexOf("、");
  if(m >= Math.floor(n * 0.6)) return cut.slice(0, m);
  return cut + "…";
}
/* 時計は1行ぶんしか出さずに切ってしまうので、こちら側で折り返します。
   こうすると途中で切られず、見出しを最後まで読めます。
   折るところは、読点・中黒・空白をさかのぼって探します。
   英数字の途中では折らないようにします（型式や数値が読めなくなるため）。 */
const BREAKCH = "、，：:；;・ 　／/｜|";
const ALNUM = /[0-9A-Za-z.\-]/;
const NOHEAD = "。、，．,.）)」』】〕］}｝・ー";   /* 行の頭に置かない字 */
function wrapLines(t, w){
  const out = [];
  let cur = "", i = 0;
  while(i < t.length){
    /* 行の頭の空白は捨てます */
    if(!cur.length && (t[i] === " " || t[i] === "　")){ i++; continue; }
    cur += t[i]; i++;
    if(cur.length < w) continue;
    if(i >= t.length) break;
    /* 句点や閉じ括弧が次の行の頭に来ないよう、1字だけ引き取ります */
    while(i < t.length && NOHEAD.indexOf(t[i]) >= 0 && cur.length < w + 2){ cur += t[i]; i++; }
    if(i >= t.length) break;
    let k = -1;
    /* 行の前の方で折ると、1行目がすかすかになります。
       後ろ寄りに区切りが無ければ、幅いっぱいまで使います。 */
    const floor = Math.max(1, Math.floor(w * 0.55));
    for(let j = cur.length - 1; j >= floor; j--){
      if(BREAKCH.indexOf(cur[j]) >= 0){ k = j; break; }
    }
    if(k < 0){
      /* 区切りが無いときは、英数字のかたまりを割らない位置まで戻します */
      let j = cur.length - 1;
      while(j > floor && ALNUM.test(cur[j]) && ALNUM.test(t[i - (cur.length - j)] || "")) j--;
      if(j > floor && j < cur.length - 1) k = j;
    }
    if(k >= 0){
      out.push(cur.slice(0, k + 1).replace(/[\s　]+$/, ""));
      cur = cur.slice(k + 1).replace(/^[\s　]+/, "");
    } else {
      out.push(cur); cur = "";
    }
  }
  if(cur) out.push(cur);
  return out.filter(x => x.length);
}
/* 1件ぶんの行。折り返したぶんは字下げして、続きだと分かるようにします。 */
function itemLines(it, mark, cfg){
  const raw = (it.ja && (it.ja.short || it.ja.title)) || "";
  /* cfg.chars は「行頭の 🚗 を含めた1行ぜんたい」の長さです。
     行頭が 3 文字ぶん（絵文字＋空白、続きは字下げ）なので、その分を引きます。 */
  const w = Math.max(8, (cfg.chars || 26) - 3);
  if(cfg.mode === "clip") return [mark + " " + clip(raw, w)];
  const t = tidy(raw);
  return wrapLines(t, w).map((x, i) => (i ? "　 " : mark + " ") + x);
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
/* 出どころ。🚗 と 🤖 は別々の時間に更新されるので、まとめも通知も別々にします。
   片方だけ新しくなったときは、その片方だけを知らせます。 */
const SOURCES = [
  {key:"car", mark:"\u{1F697}", name:"自動車", url:"./news/items.json", open:"./news/"},
  {key:"ai",  mark:"\u{1F916}", name:"AI",     url:"./ai/items.json",   open:"./ai/"}
];
function srcState(st, key){
  const all = st.src || {};
  return Object.assign({updated:"", at:"", day:""}, all[key] || {});
}
/* 出どころ1つぶんの行を作ります。前に知らせたものは外します。 */
function pickRows(data, mark, cfg, seen){
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
    .map(it => ({id:it.id, lines:itemLines(it, mark, cfg)}));
}
/* 残っている ToDo の1行。その日の最初の通知にだけ添えます。 */
function todoLine(cfg){
  const c = cfg.counts;
  if(!cfg.todo || !c || !(c.todo || c.waiting || c.keep)) return "";
  const bits = [];
  if(c.todo)    bits.push("ToDo " + c.todo);
  if(c.waiting) bits.push("待ち " + c.waiting);
  if(c.keep)    bits.push("覚書 " + c.keep);
  return "✓ " + bits.join(" ・ ");
}
/* 出どころ1つぶんのまとめ。fresh=true なら「前に知らせたか」を見ません（お試し用）。 */
async function buildOne(src, cfg, st, fresh, withTodo){
  const data = await readItems(src.url);
  const updated = (data && data.updated) || "";
  const seen = fresh ? [] : (st.ids || []);
  const rows = pickRows(data, src.mark, cfg, seen);
  const tail = withTodo ? todoLine(cfg) : "";
  /* 本文が長すぎると時計側で切られるので、入らない「1件」を落とします。
     行の途中では切らないので、載ったものは必ず最後まで読めます。 */
  const cap = cfg.maxBody > 0 ? cfg.maxBody : 100000;
  const budget = cap - (tail ? tail.length + 1 : 0);
  let body = "", used = 0;
  for(const r of rows){
    const block = r.lines.join("\n");
    const next = body ? body + "\n" + block : block;
    if(next.length > budget) break;
    body = next; used++;
  }
  if(tail) body = body ? body + "\n" + tail : tail;
  const d = new Date();
  const stamp = (d.getMonth()+1) + "/" + d.getDate();
  return {key:src.key, name:src.name, mark:src.mark, open:src.open,
          title:"MemoNote ・ " + src.name + " " + stamp,
          body:body, ids:rows.slice(0, used).map(r => r.id),
          n:used, updated:updated, empty:!used};
}
/* 画面の下見用。入にしてある出どころを順に作って返します。 */
async function buildDigest(fresh){
  const cfg = await notifyCfg();
  const st  = await notifyState();
  const out = [];
  let first = true;
  for(const src of SOURCES){
    if(!cfg[src.key]) continue;
    const g = await buildOne(src, cfg, st, fresh, first);
    const prev = srcState(st, src.key);
    g.fresh = !prev.updated || prev.updated !== g.updated;   /* まだ知らせていない更新か */
    g.lastAt = prev.at || "";
    out.push(g);
    if(!g.empty) first = false;
  }
  return {list:out, cfg:cfg, empty:out.every(g => g.empty)};
}
/* 実際に通知を出します。出どころごとに別の通知にするので、
   🚗 と 🤖 が別の時間に更新されても、それぞれが時計に出ます。
   fresh=true は「いますぐ通知する」用で、更新の有無を見ずに出します。 */
async function showDigest(fresh){
  const cfg = await notifyCfg();
  let st = await notifyState();
  const done = [];
  let first = (st.todoDay !== today());
  for(const src of SOURCES){
    if(!cfg[src.key]) continue;
    const prev = srcState(st, src.key);
    const data0 = await readItems(src.url);
    const up = (data0 && data0.updated) || "";
    /* まだ新しくなっていない出どころは飛ばします（同じものを二度出さないため） */
    if(!fresh && prev.updated && up && prev.updated === up) continue;
    const g = await buildOne(src, cfg, st, fresh, first);
    if(g.empty) continue;
    await self.registration.showNotification(g.title, {
      body: g.body,
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      tag: "memonote-" + src.key,     /* 出どころごとに別枠。上書きし合いません */
      renotify: true,
      silent: false,
      data: {url:g.open}
    });
    const ids = [...new Set([...(st.ids || []), ...g.ids])].slice(-600);
    const srcAll = Object.assign({}, st.src || {});
    srcAll[src.key] = {updated:g.updated, at:new Date().toISOString(), day:today()};
    st = Object.assign({}, st, {ids:ids, src:srcAll,
                                at:new Date().toISOString(), day:today()});
    if(first){ st.todoDay = today(); first = false; }
    await cfgPut("notify-state", st);
    done.push({key:src.key, n:g.n, title:g.title, body:g.body});
  }
  if(!done.length) return {ok:false, why:"new"};
  return {ok:true, sent:done.length, done:done};
}
/* 毎朝の自動。Chrome が頃合いを見て呼びます（時刻は指定できません）。
   設定した時刻より前なら何もしません。
   その日もう出したかどうかは出どころごとに見るので、🚗 を出したあとに
   🤖 が新しくなれば、同じ日でも 🤖 だけをもう一度出します。 */
self.addEventListener("periodicsync", e => {
  if(e.tag !== "memonote-digest") return;
  e.waitUntil((async () => {
    const cfg = await notifyCfg();
    if(!cfg.on) return;
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
    return e.waitUntil(cfgPut("notify-state", {ids:[], at:"", day:"", src:{}, todoDay:""})
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
