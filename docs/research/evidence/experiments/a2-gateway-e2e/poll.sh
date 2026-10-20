#!/usr/bin/env bash
# Polls the public Gateway transfers API for payments to the merchant and logs every status change.
set -euo pipefail
cd "$(dirname "$0")"
TO=$(cat merchant.addr)
MAX_MIN=${MAX_MIN:-45}
last=""
end=$(($(date +%s) + MAX_MIN * 60))
while [ "$(date +%s)" -lt "$end" ]; do
  body=$(curl -s -m 20 "https://gateway-api-testnet.circle.com/v1/x402/transfers?to=${TO}&pageSize=100" || true)
  summary=$(printf '%s' "$body" | python3 -I -c 'import json,sys
try:
  d=json.load(sys.stdin)
except Exception as e:
  print("parse-error"); sys.exit()
items=d.get("transfers", d.get("data", d)) if isinstance(d,dict) else d
print(json.dumps(items, sort_keys=True))' 2>/dev/null || echo parse-error)
  if [ "$summary" != "$last" ]; then
    printf '{"at":"%s","event":"poll.change","body":%s}\n' "$(date -u +%FT%TZ)" "$(printf '%s' "$body" | python3 -I -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" >> raw/poll.jsonl
    echo "$(date -u +%FT%TZ) change: $summary" | cut -c1-400
    last=$summary
  fi
  if printf '%s' "$summary" | grep -q '"completed"'; then echo "completed seen"; exit 0; fi
  sleep 15
done
echo "timeout after ${MAX_MIN} min"
