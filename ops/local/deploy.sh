#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RPC_URL="http://127.0.0.1:8545"
if [ "$(arc-cast chain-id --rpc-url "$RPC_URL")" != "5042002" ]; then
	echo "local deploy expects Arc Anvil chain id 5042002" >&2
	exit 1
fi
MANIFEST="$ROOT/deployments/arc-local.json"
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

KEYS_FILE="$(mktemp "$ROOT/deployments/.arc-local-addresses.XXXXXX")"
KEYS_PATH="../deployments/${KEYS_FILE##*/}"
trap 'rm -f "$KEYS_FILE"' EXIT

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

node --input-type=module - "$KEYS_FILE" "$SENDER" <<'NODE'
import { writeFile } from "node:fs/promises";

const [path, address] = process.argv.slice(2);
if (path === undefined || address === undefined) throw new Error("missing deploy input");
const publicDefaults = {
  K3: { address },
  K5: { address },
  K7: { address },
  K6: { address },
  K20: { address },
};
await writeFile(path, JSON.stringify(publicDefaults), { mode: 0o600 });
NODE

cd "$ROOT/contracts"
ARC_FORGE=arc-forge script/deploy.sh \
	"$RPC_URL" \
	"$KEYS_PATH" \
	../deployments/arc-local.json \
	--broadcast --unlocked --sender "$SENDER"
