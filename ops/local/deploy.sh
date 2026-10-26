#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RPC_URL="http://127.0.0.1:8545"
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

node --input-type=module - "$KEYS_FILE" <<'NODE'
import { readFile } from "node:fs/promises";

const [path] = process.argv.slice(2);
if (path === undefined) throw new Error("missing local signer key manifest path");
const manifest = JSON.parse(await readFile(path, "utf8"));
if (manifest.network !== "arc-local" || manifest.chainId !== 5042002) {
  throw new Error("local signer key manifest must target Arc local chain 5042002");
}
for (const role of ["K3", "K5", "K6", "K7", "K20"]) {
  const entry = manifest[role];
  if (
    typeof entry?.address !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(entry.address) ||
    entry.ref !== role
  ) {
    throw new Error(`local signer key manifest has invalid ${role} address/ref`);
  }
}
NODE

for ROLE in K3 K5 K6 K7 K20; do
	ADDRESS="$(
		node --input-type=module - "$KEYS_FILE" "$ROLE" <<'NODE'
import { readFile } from "node:fs/promises";
const [path, role] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(path, "utf8"));
process.stdout.write(manifest[role].address);
NODE
	)"
	if [ "${ADDRESS,,}" != "${SENDER,,}" ]; then
		TX="$(node -e 'process.stdout.write(JSON.stringify({from: process.argv[1], to: process.argv[2], value: "0xDE0B6B3A7640000"}))' "$SENDER" "$ADDRESS")"
		arc-cast rpc eth_sendTransaction "$TX" --rpc-url "$RPC_URL" >/dev/null
	fi
done

cd "$ROOT/contracts"
ARC_FORGE=arc-forge script/deploy.sh \
	"$RPC_URL" \
	"../deployments/local-keys.json" \
	../deployments/arc-local.json \
	--broadcast --unlocked --sender "$SENDER"
