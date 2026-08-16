#!/usr/bin/env bash
# 端到端冒烟测试：启动后端，验证连接/元数据/查询/只读守卫。
set -e
cd "/e/AI/AI_DataEditor/server"
PORT=3137
export PORT
rm -f /tmp/test.db /tmp/test.db-journal

echo "== build =="
npm run build > /tmp/build.log 2>&1 && echo "build OK" || { echo "build FAILED"; tail -20 /tmp/build.log; exit 1; }

node dist/main.js > /tmp/server.log 2>&1 &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null || true" EXIT

echo "== wait for server =="
for i in $(seq 1 40); do
  curl -s "http://localhost:$PORT/api/connections/types" >/dev/null 2>&1 && break
  sleep 1
done

BASE="http://localhost:$PORT/api/connections"
pass=0; fail=0
check() { # desc, expected-substr, actual
  if echo "$3" | grep -q "$2"; then echo "[PASS] $1"; pass=$((pass+1)); else echo "[FAIL] $1 => $3"; fail=$((fail+1)); fi
}

echo "== 1) supported types =="
T=$(curl -s "$BASE/types"); echo "$T"
check "types 含 sqlite" "sqlite" "$T"

echo "== 2) create sqlite connection =="
C=$(curl -s -X POST "$BASE" -H 'Content-Type: application/json' -d '{"name":"t","type":"sqlite","filename":"/tmp/test.db"}')
echo "$C"
ID=$(echo "$C" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
check "返回 id" '"id"' "$C"

echo "== 3) list connections =="
check "列表含 t" '"t"' "$(curl -s "$BASE")"

echo "== 4) databases =="
check "databases 返回文件" "test.db" "$(curl -s "$BASE/$ID/databases")"

echo "== 5) DDL create table =="
curl -s -X POST "$BASE/$ID/query" -H 'Content-Type: application/json' -d '{"sql":"CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, name TEXT)"}'; echo

echo "== 6) INSERT with params =="
curl -s -X POST "$BASE/$ID/query" -H 'Content-Type: application/json' -d '{"sql":"INSERT INTO t(name) VALUES (?)","params":["alice"]}'; echo

echo "== 7) SELECT =="
S=$(curl -s -X POST "$BASE/$ID/query" -H 'Content-Type: application/json' -d '{"sql":"SELECT * FROM t"}')
echo "$S"
check "select 返回 alice" "alice" "$S"

echo "== 8) tables =="
check "tables 含 t" '"t"' "$(curl -s "$BASE/$ID/tables")"

echo "== 9) columns =="
CO=$(curl -s "$BASE/$ID/tables/t/columns"); echo "$CO"
check "columns 含 name" "name" "$CO"

echo "== 10) readonly guard (DROP should be rejected) =="
G=$(curl -s -X POST "$BASE/$ID/query" -H 'Content-Type: application/json' -d '{"sql":"DROP TABLE t","readonly":true}')
echo "$G"
check "只读模式拒绝 DDL" "readonly" "$G"

echo "== 11) password not stored in plaintext (vault encrypted) =="
ENC=$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('connections.json','utf8'));const c=j.find(x=>x.name==='t')||j[0]||{};process.stdout.write(c.passwordEnc?'ENCRYPTED':'PLAINTEXT')" 2>/dev/null || echo MISSING)
echo "passwordEnc field present: $ENC"
if [ "$ENC" = "ENCRYPTED" ]; then echo "[PASS] 密码以密文存储"; else echo "[FAIL] 密码未加密 ($ENC)"; fail=$((fail+1)); fi

echo
echo "RESULT: pass=$pass fail=$fail"
