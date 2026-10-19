#!/usr/bin/env bash
# Polls one x402 transfer by id every INTERVAL seconds and logs each status change (with local timestamp).
set -euo pipefail
cd "$(dirname "$0")"
ID=$1
INTERVAL=${INTERVAL:-2}
MAX_MIN=${MAX_MIN:-25}
end=$(($(date +%s) + MAX_MIN * 60))
last=""
while [ "$(date +%s)" -lt "$end" ]; do
  body=$(curl -s -m 10 "https://gateway-api-testnet.circle.com/v1/x402/transfers/${ID}" || true)
  status=$(printf '%s' "$body" | python3 -I -c 'import json,sys
try: print(json.load(sys.stdin).get("status","?"))
except Exception: print("parse-error")')
  if [ "$status" != "$last" ]; then
    printf '{"at":"%s","event":"poll-id.change","id":"%s","status":"%s","body":%s}\n' \
      "$(python3 -I -c 'import datetime;print(datetime.datetime.now(datetime.UTC).isoformat(timespec="milliseconds"))')" "$ID" "$status" "${body:-null}" | tee -a raw/poll-id.jsonl
    last=$status
  fi
  if [ "$status" = "completed" ]; then exit 0; fi
  sleep "$INTERVAL"
done
echo "timeout after ${MAX_MIN} min (last status: $last)"
