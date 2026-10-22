# Lane 1 — PR #51 fixes before merge

> **Branch:** `codex/t040-local-hosting` (1 commit ahead of `build-v1`)
> **Scope:** Two must-fix items and two cleanup items. No new features.

---

## Setup

```bash
cd ../czar-t040
git fetch origin
git checkout codex/t040-local-hosting
pnpm install
```

---

## Fix 1 (must fix): `PERIOD_LENGTH` magic number

**File:** `apps/signer/src/postgres-projection.ts`, line 32

```ts
// WRONG — magic number
const PERIOD_LENGTH = 604800;
```

**Fix:** Add `signer.projection.periodLengthSeconds` to `packages/config/src/registry.ts` with default `604800` and reason "7-day rolling window for on-chain balance projection (CZ-27 §5)". Then import and use it:

```ts
import { config } from '@czar/config';
const PERIOD_LENGTH = config.get('signer.projection.periodLengthSeconds');
```

Also check lines 146 area — `2000n` and `10000n` BPS constants. If these are spec-defined (e.g. CZ-27 step caps), add config keys for them too. If they're arithmetic identities (basis points = 10000), a named constant like `BPS_BASE = 10000n` is fine.

---

## Fix 2 (must fix): hardcoded RPC URL in runtime-adapters

**File:** `apps/signer/src/runtime-adapters.ts`, line 39

```ts
// WRONG — baked-in URL
const rpcUrl = 'http://127.0.0.1:8545';
```

**Fix:** Accept `rpcUrl` as a parameter of `createLocalSignerAdapters`:

```ts
export function createLocalSignerAdapters(opts: {
  rpcUrl: string;
  // ...existing params
}) {
```

Then in `apps/signer/src/local-main.ts`, pass the value that's already read from `CZAR_SIGNER_RPC_URL`:

```ts
const adapters = createLocalSignerAdapters({
  rpcUrl,
  // ...
});
```

---

## Cleanup 1: hardcoded fallbacks in local-main.ts

**File:** `apps/signer/src/local-main.ts`, lines 10–12

The fallback port `8545` and DB port `15433` should come from config keys, not inline strings. Add:
- `signer.local.rpcPort` (default `8545`, reason: "arc-anvil default port for local signer")
- `signer.local.dbPort` (default `15433`, reason: "local Postgres port for signer projection")

Or read them from the TOML overlay.

---

## Cleanup 2: hardcoded contract addresses in local-main.ts

**File:** `apps/signer/src/local-main.ts`, lines 34–38

`usdc`, `gatewayWallet`, `gatewayMinter`, `jobEscrow` are hardcoded hex addresses. These should come from the deployment manifest (the JSON file that `deploy.sh` writes). Your `local-main.ts` already reads a manifest — wire these addresses from it instead of inlining them.

---

## After fixes

```bash
pnpm --filter @czar/signer test
pnpm -r typecheck
pnpm lint
```

All must pass. Then force-push or add a fixup commit to the same branch and update PR #51.

---

## PR metadata (unchanged)

- **Title:** `feat(local): wire T-040 signer and local hosting`
- **Base:** `build-v1`
- **Branch:** `codex/t040-local-hosting`
