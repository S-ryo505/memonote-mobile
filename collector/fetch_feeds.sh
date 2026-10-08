#!/usr/bin/env bash
# Claude の定期タスク用：記事収集を呼び出して、終わるまで待ち、復号した記事データを出力先に置く
#   使い方: bash collector/fetch_feeds.sh <FEED_KEY> <出力先フォルダ>
#   出力:   <出力先>/auto.json, <出力先>/ai.json, <出力先>/status.json
#   最後の行に「FRESH ran_at=…」（今回の収集が間に合った）か「STALE ran_at=…」（前回分を使用）を出す
set -u
KEY="$1"; OUT="$2"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$OUT"
cd "$REPO_DIR"

T0=$(date -u +%s)

# 1) feeds-request ブランチへ空コミットを push して、収集ワークフローを呼び出す
git -c user.name="claude-task" -c user.email="noreply@anthropic.com" \
  commit -q --allow-empty -m "feeds-request $(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M')" >/dev/null 2>&1
git push -q -f origin HEAD:refs/heads/feeds-request 2>&1 | tail -1 || echo "request push failed (前回分で続行)"
git reset -q --hard HEAD~1

# 2) 最大15分、今回の収集結果が feeds ブランチに上がるのを待つ
fresh=no
for i in $(seq 1 30); do
  if git fetch -q --depth 1 origin feeds 2>/dev/null; then
    ran=$(git show FETCH_HEAD:status.json 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['ran_at'])" 2>/dev/null)
    if [ -n "${ran:-}" ]; then
      ts=$(date -u -d "$ran" +%s 2>/dev/null || echo 0)
      if [ "$ts" -ge $((T0 - 60)) ]; then fresh=yes; break; fi
    fi
  fi
  sleep 30
done

# 3) 復号（今回分が間に合わなければ、前回分を使う）
git fetch -q --depth 1 origin feeds 2>/dev/null
git show FETCH_HEAD:status.json > "$OUT/status.json"
for t in auto ai; do
  git show "FETCH_HEAD:$t.json.gz.enc" > "$OUT/$t.enc"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "pass:$KEY" -in "$OUT/$t.enc" | gunzip > "$OUT/$t.json"
  rm -f "$OUT/$t.enc"
done
ran=$(python3 -c "import json;print(json.load(open('$OUT/status.json'))['ran_at'])")
python3 -c "import json;[json.load(open('$OUT/'+t+'.json')) for t in ('auto','ai')]" || { echo "DECRYPT_FAILED"; exit 1; }
if [ "$fresh" = yes ]; then echo "FRESH ran_at=$ran"; else echo "STALE ran_at=$ran"; fi
