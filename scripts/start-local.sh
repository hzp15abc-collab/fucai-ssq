#!/usr/bin/env bash
# 本地启动：模拟器 + 灌数据 + 网页
set -e; cd "$(dirname "$0")/.."
. ~/jdk/env.sh   # Java 21（Firestore 模拟器需要）
npm run build
nohup firebase emulators:start --project demo-fucai-ssq > emulators.log 2>&1 &
until curl -s http://127.0.0.1:4000 >/dev/null; do sleep 2; done; sleep 5
node scripts/seed.mjs
(cd web && nohup npx vite --host 0.0.0.0 --port 5173 > ../web.log 2>&1 &)
echo "网页 http://localhost:5173  模拟器UI http://localhost:4000"
