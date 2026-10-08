"""MemoNote ニュース用の記事収集スクリプト（GitHub Actions で毎朝実行）

各サイトの RSS から新しい記事を拾い、記事ページの本文を取り出して
<出力先>/<topic>.json に保存する。ワークフローがそれを feeds ブランチに置き、
Claude の定期タスクはそれを読むだけ（ウェブも暗号もスクリプト実行も不要）。
著作権に配慮して、記事全文は保存せず「要約（RSS）＋数値を含む文の抜き出し」だけを残す
（Claude がウェブを直接開かないので、承認の確認が出ない）。

- 保存期間: KEEP_DAYS 日（それより古い記事は消す）
- 1サイト1回あたりの本文取得は MAX_NEW_PER_SOURCE 件まで
- 失敗したサイトは feeds/status.json に記録して、他のサイトは続ける
"""
import json, time, datetime as dt, pathlib, re, html, sys
import feedparser, requests, trafilatura

ROOT = pathlib.Path(__file__).parent
# 出力先（作業用フォルダ）
OUT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "feeds"
KEEP_DAYS = 10
MAX_NEW_PER_SOURCE = 25
MAX_TEXT = 20000          # 本文は取り出しに使うだけで保存しない
MAX_FACTS_CHARS = 700     # 保存するのは数値・固有名詞を含む文の抜き出し（この長さまで）
MAX_SUMMARY = 400
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36 MemoNoteFeedCollector/1.0")
JST = dt.timezone(dt.timedelta(hours=9))


def now():
    return dt.datetime.now(dt.timezone.utc)


def strip_html(s):
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", s or "", flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def entry_date(e):
    for k in ("published_parsed", "updated_parsed"):
        t = e.get(k)
        if t:
            return dt.datetime(*t[:6], tzinfo=dt.timezone.utc)
    return now()


def fetch_text(url, fallback):
    """記事ページから本文を取り出す。取れなければ RSS の内容で代用"""
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=25)
        if r.ok and r.text:
            t = trafilatura.extract(r.text, include_comments=False, include_tables=True,
                                    favor_recall=True, url=url)
            if t and len(t) > len(fallback) * 0.8 and len(t) > 300:
                return t[:MAX_TEXT], "page"
    except Exception:
        pass
    return fallback[:MAX_TEXT], "rss"


FACT_HINT = re.compile(r"[0-9０-９]|%|kWh|kW|Nm|hp|PS|mph|km|ドル|円|ユーロ|万台|億|兆|billion|million|percent", re.I)


def facts_of(text):
    """本文から、数値や単位を含む文を先頭から順に抜き出す（記事全文は保存しない）"""
    sents = re.split(r"(?<=[。！？])|(?<=[.!?])\s+|\n+", text or "")
    out, n = [], 0
    for s in sents:
        s = s.strip()
        if len(s) < 12 or len(s) > 400 or not FACT_HINT.search(s):
            continue
        if n + len(s) > MAX_FACTS_CHARS:
            break
        out.append(s); n += len(s)
    return out


def main():
    sources = json.loads((ROOT / "sources.json").read_text(encoding="utf-8"))
    OUT.mkdir(exist_ok=True)
    status = {"ran_at": now().astimezone(JST).isoformat(timespec="seconds"), "sources": {}}
    cutoff = now() - dt.timedelta(days=KEEP_DAYS)

    for topic, srcs in sources.items():
        path = OUT / f"{topic}.json"
        old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"items": []}
        items = {i["url"]: i for i in old.get("items", [])
                 if dt.datetime.fromisoformat(i["published"]) >= cutoff}

        for s in srcs:
            st = {"ok": False, "entries": 0, "new": 0, "page_text": 0, "error": ""}
            try:
                r = requests.get(s["url"], headers={"User-Agent": UA}, timeout=25)
                r.raise_for_status()
                f = feedparser.parse(r.content)
                st["entries"] = len(f.entries)
                if not f.entries:
                    raise ValueError("RSS に記事がありません")
                n = 0
                for e in f.entries:
                    url = (e.get("link") or "").strip()
                    if not url or url in items:
                        continue
                    pub = entry_date(e)
                    if pub < cutoff:
                        continue
                    if n >= MAX_NEW_PER_SOURCE:
                        break
                    rss_body = ""
                    if e.get("content"):
                        rss_body = strip_html(e["content"][0].get("value", ""))
                    summary = strip_html(e.get("summary", ""))
                    text, how = fetch_text(url, rss_body or summary)
                    items[url] = {
                        "source": s["name"],
                        "title": strip_html(e.get("title", "")),
                        "url": url,
                        "published": pub.isoformat(timespec="seconds"),
                        "collected": now().isoformat(timespec="seconds"),
                        "summary": (summary or text)[:MAX_SUMMARY],
                        "facts": facts_of(text),
                        "text_from": how,
                    }
                    n += 1
                    st["page_text"] += how == "page"
                    time.sleep(1.0)  # 相手サイトに負担をかけない
                st["new"] = n
                st["ok"] = True
            except Exception as ex:
                st["error"] = f"{type(ex).__name__}: {ex}"[:300]
            status["sources"][f"{topic}/{s['name']}"] = st

        out = sorted(items.values(), key=lambda i: i["published"], reverse=True)
        path.write_text(json.dumps({"updated": status["ran_at"], "items": out},
                                   ensure_ascii=False, indent=1), encoding="utf-8")

    (OUT / "status.json").write_text(json.dumps(status, ensure_ascii=False, indent=1),
                                     encoding="utf-8")


if __name__ == "__main__":
    main()
