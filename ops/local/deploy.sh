#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RPC_URL="http://127.0.0.1:8545"
if ! arc-cast rpc anvil_nodeInfo --rpc-url "$RPC_URL" >/dev/null; then
	echo "local deploy refused: Arc RPC did not answer anvil_nodeInfo" >&2
	exit 1
fi
if [ "$(arc-cast chain-id --rpc-url "$RPC_URL")" != "5042002" ]; then
	echo "local deploy expects Arc Anvil chain id 5042002" >&2
	exit 1
fi
MANIFEST="$ROOT/deployments/arc-local.json"
KEYS_FILE="$ROOT/deployments/local-keys.json"
if [ -s "$MANIFEST" ]; then
	FACTORY="$(
		node --input-type=module - "$MANIFEST" <<'NODE'
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(process.argv[2], "utf8"));
if (typeof manifest.CzarVaultFactory !== "string") process.exit(1);
process.stdout.write(manifest.CzarVaultFactory);
NODE
	)"
	if [ "$(arc-cast code "$FACTORY" --rpc-url "$RPC_URL")" != "0x" ]; then
		exit 0
	fi
fi

SENDER="$(arc-cast rpc eth_accounts --rpc-url "$RPC_URL" | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => {
    const result = JSON.parse(input);
    const address = result[0];
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      process.exitCode = 1;
      throw new Error("arc-anvil returned no unlocked public address");
    }
    process.stdout.write(address);
  });
')"

RELAYER_ADDRESS="$(node "$ROOT/ops/local/parse-local-keys.mjs" --cli "$KEYS_FILE" relayer)"
SENDER_LOWER="$(printf '%s' "$SENDER" | tr '[:upper:]' '[:lower:]')"
RELAYER_LOWER="$(printf '%s' "$RELAYER_ADDRESS" | tr '[:upper:]' '[:lower:]')"
if [ "$RELAYER_LOWER" != "$SENDER_LOWER" ]; then
	TX="{\"from\":\"$SENDER\",\"to\":\"$RELAYER_ADDRESS\",\"value\":\"0xDE0B6B3A7640000\"}"
	arc-cast rpc eth_sendTransaction "$TX" --rpc-url "$RPC_URL" >/dev/null
fi

cd "$ROOT/contracts"
ARC_FORGE=arc-forge script/deploy.sh \
	"$RPC_URL" \
	"../deployments/local-keys.json" \
	../deployments/arc-local.json \
	--broadcast --unlocked --sender "$SENDER"
