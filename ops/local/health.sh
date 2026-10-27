#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

failures=0

check() {
	local name="$1"
	shift
	if "$@" >/dev/null 2>&1; then
		printf 'OK %s\n' "$name"
	else
		printf 'FAIL %s\n' "$name"
		failures=1
	fi
}

check_output() {
	local name="$1"
	shift
	local output
	if output=$("$@" 2>&1); then
		printf 'OK %s: %s\n' "$name" "$output"
	else
		printf 'FAIL %s: %s\n' "$name" "$output"
		failures=1
	fi
}

check_fork_rpc() {
	node --input-type=module <<'NODE'
try {
  const response = await fetch("http://127.0.0.1:8545", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`local RPC returned HTTP ${response.status}`);
  const chain = await response.json();
  if (chain.result !== "0x4cef52") throw new Error("local Arc chain id is not 5042002");
  const nodeResponse = await fetch("http://127.0.0.1:8545", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "anvil_nodeInfo", params: [] }),
    signal: AbortSignal.timeout(2_000),
  });
  const nodeInfo = await nodeResponse.json();
  if (!nodeResponse.ok || nodeInfo.error || typeof nodeInfo.result !== "object") {
    throw new Error("local RPC did not answer anvil_nodeInfo");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Arc fork RPC check failed"}\n`);
  process.exitCode = 1;
}
NODE
}

check_fork_block() {
	node --input-type=module <<'NODE'
import { readFile } from "node:fs/promises";
try {
  const pin = JSON.parse(await readFile("deployments/.arc-fork-pin.json", "utf8"));
  if (pin.chainId !== 5042002 || !/^[1-9][0-9]*$/.test(pin.forkBlock)) {
    throw new Error("fork pin metadata is invalid");
  }
  process.stdout.write(`forkBlock=${pin.forkBlock}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "fork pin check failed"}\n`);
  process.exitCode = 1;
}
NODE
}

check_manifest_contract_count() {
	node --input-type=module <<'NODE'
import { readFile } from "node:fs/promises";
const expected = [
  "CoreLogic",
  "EnvelopeLogic",
  "ReservationLogic",
  "SignatureLogic",
  "PocketLogic",
  "JobLogic",
  "AutonomyLogic",
  "OwnerActionLogic",
  "OpenEvidenceLog",
  "CzarVaultFactory",
];
try {
  const manifest = JSON.parse(await readFile("deployments/arc-local.json", "utf8"));
  if (manifest.chainId !== 5042002) throw new Error("deployment manifest chain id is not 5042002");
  const count = expected.filter((key) => /^0x[\da-fA-F]{40}$/.test(manifest[key])).length;
  if (count !== expected.length) throw new Error(`deployment manifest has ${count}/10 contracts`);
  process.stdout.write(`${count}/10 contract addresses`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "manifest check failed"}\n`);
  process.exitCode = 1;
}
NODE
}

check_external_contract_code() {
	node --input-type=module <<'NODE'
const addresses = [
  "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  "0x0000000DF7E6c9Dc387cAFc5eCBfa6c3a6179AdD",
  "0x3600000000000000000000000000000000000000",
];
let id = 0;
try {
  for (const address of addresses) {
    const response = await fetch("http://127.0.0.1:8545", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++id,
        method: "eth_getCode",
        params: [address, "latest"],
      }),
      signal: AbortSignal.timeout(2_000),
    });
    const payload = await response.json();
    if (!response.ok || payload.error || typeof payload.result !== "string" || payload.result === "0x") {
      throw new Error(`missing EntryPoint, Circle SDK factory, or USDC code at ${address}`);
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "external contract code check failed"}\n`);
  process.exitCode = 1;
}
NODE
}

check_factory_code() {
	node --input-type=module <<'NODE'
import { readFile } from "node:fs/promises";
try {
  const manifest = JSON.parse(await readFile("deployments/arc-local.json", "utf8"));
  const response = await fetch("http://127.0.0.1:8545", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getCode",
      params: [manifest.CzarVaultFactory, "latest"],
    }),
    signal: AbortSignal.timeout(2_000),
  });
  const payload = await response.json();
  if (!response.ok || payload.error || typeof payload.result !== "string" || payload.result === "0x") {
    throw new Error("CzarVaultFactory code is missing on the local chain");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "factory code check failed"}\n`);
  process.exitCode = 1;
}
NODE
}

check_server_migrations() {
	local expected actual
	expected="$(rg --files apps/server/migrations -g '*.sql' | sed 's#^.*/##' | LC_ALL=C sort)"
	actual="$(docker compose -f ops/local/compose.yaml exec -T postgres psql -U postgres -d postgres -Atc \
		'SELECT filename FROM schema_migrations ORDER BY filename')"
	[ "$expected" = "$actual" ] || {
		printf 'applied migrations do not match the server migration files\n' >&2
		return 1
	}
	printf '%s migrations applied' "$(printf '%s\n' "$actual" | wc -l | tr -d ' ')"
}

check_indexer_lag() {
	local max_lag values head indexed lag
	max_lag="$(pnpm --filter @czar/config exec node --disable-warning=ExperimentalWarning \
		--experimental-strip-types --input-type=module -e 'import { loadConfig, parseParameterToml, parameterEnvironment } from "./src/index.ts"; import { readFileSync } from "node:fs"; const config = loadConfig({ envFile: parseParameterToml(readFileSync("../../env/local.toml", "utf8")), env: parameterEnvironment(process.env) }); process.stdout.write(String(config.get("indexer.maxLagBlocks")));')"
	values="$(
		node --input-type=module <<'NODE'
const response = await fetch("http://127.0.0.1:8545", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  signal: AbortSignal.timeout(2_000),
});
if (!response.ok) throw new Error("Arc block query failed");
const rpc = await response.json();
if (typeof rpc.result !== "string") throw new Error("Arc block result is invalid");
const statusResponse = await fetch("http://127.0.0.1:42069/status", {
  signal: AbortSignal.timeout(2_000),
});
if (!statusResponse.ok) throw new Error(`indexer status returned HTTP ${statusResponse.status}`);
const status = await statusResponse.json();
if (status.arcTestnet?.id !== 5042002 || !Number.isSafeInteger(status.arcTestnet?.block?.number)) {
  throw new Error("indexer status has no Arc checkpoint");
}
process.stdout.write(`${BigInt(rpc.result).toString()} ${status.arcTestnet.block.number}`);
NODE
	)"
	read -r head indexed <<<"$values"
	if ! [[ "$max_lag" =~ ^[1-9][0-9]*$ && "$head" =~ ^[0-9]+$ && "$indexed" =~ ^[0-9]+$ ]]; then
		printf 'indexer lag inputs are invalid\n' >&2
		return 1
	fi
	lag=$((head - indexed))
	if [ "$lag" -lt 0 ] || [ "$lag" -ge "$max_lag" ]; then
		printf 'indexer lag is %s blocks; configured limit is %s\n' "$lag" "$max_lag" >&2
		return 1
	fi
	printf 'lag=%s blocks; limit=%s blocks' "$lag" "$max_lag"
}

check_wallet_config() {
	node --input-type=module <<'NODE'
try {
  const response = await fetch("http://127.0.0.1:3000/v1/app/wallet-config", {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`wallet config returned HTTP ${response.status}`);
  const config = await response.json();
  if (config.circleClientUrl !== "http://127.0.0.1:4337") throw new Error("mock bundler URL mismatch");
  if (config.circleClientKey !== "lane5-test-client-key") throw new Error("mock client key mismatch");
  if (config.arcRpcUrl !== "http://127.0.0.1:8545") throw new Error("local Arc RPC URL mismatch");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "wallet config check failed"}\n`);
  process.exitCode = 1;
}
NODE
}

check "Postgres" docker compose -f ops/local/compose.yaml exec -T postgres pg_isready -U postgres
check_output "fork block" check_fork_block
check "Arc fork RPC and anvil_nodeInfo" check_fork_rpc
check_output "deployment manifest contract count" check_manifest_contract_count
check "EntryPoint, MSCA factory and USDC code" check_external_contract_code
check "CzarVaultFactory code" check_factory_code
check "Circle stand-ins" curl --fail --silent --max-time 2 http://127.0.0.1:4999/health
check "mock bundler" curl --fail --silent --max-time 2 http://127.0.0.1:4337/health
check "indexer health" curl --fail --silent --max-time 2 http://127.0.0.1:42069/health
check "indexer ready" curl --fail --silent --max-time 2 http://127.0.0.1:42069/ready
check_output "indexer sync lag" check_indexer_lag
check_output "server migrations" check_server_migrations
check "server and database" curl --fail --silent --max-time 2 http://127.0.0.1:3000/health
check "wallet config" check_wallet_config
check "signer socket" test -S "$HOME/Library/Application Support/Czar/signer/signer.sock"
check "K3 signer keyAddress" pnpm --filter @czar/signer exec node --disable-warning=ExperimentalWarning \
	--experimental-strip-types ../../ops/local/check-signer-k3.ts
check "merchant-k10-ready keyAddress" pnpm --filter @czar/signer exec node \
	--disable-warning=ExperimentalWarning --experimental-strip-types ../../ops/local/check-signer-k10.ts
check "merchant health" curl --fail --silent --max-time 2 http://127.0.0.1:8787/health
check "web app" curl --fail --silent --max-time 3 http://localhost:3001/

if [ "$failures" -ne 0 ]; then
	exit 1
fi

printf 'Local Track A stack is healthy.\n'
