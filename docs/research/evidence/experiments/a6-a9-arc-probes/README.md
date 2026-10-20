# A6–A9 Arc infrastructure probes

- **Date:** 2026-10-18 (all times UTC, recorded in each output file)
- **Who:** Claude (ground-truth researcher, items A6–A9)
- **Networks:** Arc mainnet `https://rpc.mainnet.arc.io` (chain `5042`), Arc testnet `https://rpc.testnet.arc.io` (chain `5042002`), plus a local `arc-anvil`.
- **Tools:** Foundry `cast` 1.8.5 (`51a52c59`); Arc Foundry `v0.8.0-2` (binaries report `1.7.1-dev`, commit `d497beea`), extracted to the session scratchpad, not installed globally.
- **Funds moved:** none. No mainnet funds, no real wallet. The throwaway key was never funded.

## What was run

| Script | What it does | Output |
|---|---|---|
| `p256-probe.sh` | `eth_call` to `0x…0100` with the EIP-7951 test vector "SHA-256 #1" (valid), "#3" (invalid), and a tampered hash | `p256-precompile.txt` |
| `p256-gascap-probe.sh` | `eth_call` + code override: a probe contract `STATICCALL`s `0x100` with exactly 3449 / 3450 / 6899 / 6900 / 100000 gas | `p256-gascap.txt` |
| `address-probe.sh` | `eth_getCode` size + keccak for EntryPoints v0.6–v0.9, 0xSplits v1/v2.x, EAS, ENS, Multicall3, CREATE2 factories, CreateX, Permit2 | `address-probe.txt` |
| `codediff.py` | Byte diff of the same contract on mainnet vs testnet (explains codehash differences) | `codediff.txt` |
| `userop-activity.sh` | `UserOperationEvent` logs per EntryPoint over the last 9,000 blocks, and the bundler EOAs that sent them | `userop-activity.txt` |
| (curl) | Blockscout user-ops indexer: status, top bundlers, paymasters, factories | `blockscout-userops-indexer.txt` |
| (curl) | Testnet Blockscout contract names for top factories/paymasters | `blockscout-testnet-address-names.txt` |
| (curl) | Explorer frontend config (`/assets/envs.js`), relevant lines only | `explorer-*-envs-excerpt.txt` |
| (curl) | Explorer API keyless access, both networks; Blockscout PRO API | `explorer-api-probe.txt` |
| `scan-type4.sh` | Scan the last 600 blocks on each network for type-4 (EIP-7702) txs | `scan-type4.txt`, `type4-*.txt` |
| `eip7702/rpc-acceptance.sh` | Sign a 7702 authorization with an unfunded throwaway key, build a type-4 tx, broadcast it | `eip7702/rpc-acceptance.txt` |
| `arc-anvil-smoke.sh` | Local `arc-anvil --network arc`: P256 vector, USDC dual balance, zero-address rule, a type-4 tx | `arc-anvil-smoke.txt` |
| (curl) | npm attestation bundle for `sigstore@5.0.0`; PyPI PEP 740 provenance for `sigstore` 4.5.0 | `provenance/` |

Run `arc-anvil-smoke.sh` with `ARC_BIN=<dir with extracted forge/cast/anvil>`.

## Results (short)

- **P-256 precompile is live at `0x100` on both networks**, priced at **6900 gas** (EIP-7951), not 3450 (RIP-7212).
  - Mainnet block `26615844`, testnet block `67853022`: valid vector returns `0x…01`; invalid and tampered return `0x` (empty).
  - Gas cap: 6899 gas → empty, 6900 gas → `1` (mainnet block `26615816`, testnet block `67852989`).
  - `eth_getCode(0x100)` is `0x`, as expected for a precompile.
- **EntryPoint v0.6, v0.7, v0.8, v0.9 all have code on both networks** (mainnet block `26616061`, testnet block `67853245`).
  - v0.6 and v0.7 codehashes match Ethereum mainnet exactly.
  - v0.8 and v0.9 differ only in the chain ID and the cached EIP-712 domain separator (immutables) — see `codediff.txt`.
- **ERC-4337 is in active use:** mainnet ~520 v0.7 UserOps in ~75 min; Blockscout's indexer shows 650k+ ops for the top mainnet bundler.
  - Top factories include Circle's `UpgradableMSCAFactory` and `SingleOwnerMSCAFactory`, and ZeroDev `KernelFactory`.
- **0xSplits v2.2 is deployed on both networks:** `PullSplitFactoryV2.2`, `PushSplitFactoryV2.2`, `SplitsWarehouse`. v1 `SplitMain` and v2.0/v2.1 factories are absent.
- **EAS: no code** at any well-known EAS address. **ENS registry address:** mainnet has an unrelated 2,747-byte contract there (functions `changeForwardingAddress`, `recoverUSDC`, …), not ENS. Testnet has nothing.
- **EIP-7702:**
  - Live RPC decoded the type-4 tx and rejected it only for `insufficient funds` (same error as a plain type-2 control tx).
  - Local `arc-anvil --network arc` mined a type-4 tx (`status 1`) and set the code to `0xef0100‖delegate`.
  - No type-4 txs were seen in the last 600 blocks on either network.
  - A funded live test was **not** run: `circle wallet fund` only funds wallets in the user's Circle account (`NOT_FOUND`, see `eip7702/faucet-attempt.txt`).
- **Explorers are Blockscout** (frontend `v2.12.0`; testnet backend `v12.0.1`).
  - Testnet `/api/v2/...` works without a key but returns HTTP 429 under light load.
  - Mainnet `explorer.arc.io/api/...` returns a Cloudflare challenge (HTTP 403) to curl.
  - `api.blockscout.com/<chain>/...` returns HTTP 402 x402 (2000 base units USDC on Base or Celo). Not paid.
- **`rpc.testnet.arc.network` no longer resolves in DNS** (2026-10-18). `rpc.testnet.arc.io` works.

## To finish the live EIP-7702 test (human step)

1. Get the throwaway address: `cat eip7702/address.txt`.
2. Fund it with testnet USDC at https://faucet.circle.com (Arc Testnet). The CLI faucet can't fund a non-Circle wallet.
3. Run `cast send $(cat eip7702/address.txt) --auth 0xcA11bde05977b3631167028862bE2a173976CA11 --private-key <key from eip7702/throwaway.key.json> --rpc-url https://rpc.testnet.arc.io --gas-limit 200000`.
4. Check that `cast code $(cat eip7702/address.txt) --rpc-url https://rpc.testnet.arc.io` returns `0xef0100ca11bde05977b3631167028862be2a173976ca11`.

## Files not to commit

- `eip7702/throwaway.key.json` (gitignored, mode 600). It is a testnet-only throwaway key and holds no funds.
