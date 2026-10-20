# A3–A5 read-only checks (x402, ERC-8183, ERC-8004)

- **Date:** 2026-10-18
- **What:** read-only RPC calls and keyless GET requests. No keys, no transactions, no funds.
- **Networks:** Arc mainnet (`https://rpc.mainnet.arc.io`, chain 5042), Arc testnet (`https://rpc.testnet.arc.io`, chain 5042002). `https://rpc.testnet.arc.network` did not resolve in DNS today.
- **Blocks at time of reads:** mainnet 26,615,711–26,616,785; testnet 67,852,888–67,854,023.

## Files

| File | What it is |
|---|---|
| `reads.sh` | Every RPC/API read used in the A3–A5 draft. Re-run with `./reads.sh` (needs `cast`, `curl`). |
| `raw/reads-output-2026-10-18.txt` | Output of `reads.sh` |
| `raw/circle-facilitator-supported-2026-10-18.json` | `GET https://api.circle.com/v1/facilitator/x402/supported` |
| `raw/circle-discovery-resources-limit2-2026-10-18.json` | `GET https://api.circle.com/v2/x402/discovery/resources?limit=2` |
| `raw/arc-contract-addresses-2026-10-18.md` | `https://docs.arc.io/arc/references/contract-addresses.md` |
| `raw/facilitator-service_*.md` | Circle Facilitator docs pages (`how-it-works`, `supported-networks`) |

## Key results

- Permit2 and `x402UptoPermit2Proxy` (`0x4020A4f3…C240002`) have code on Arc mainnet and testnet; `x402ExactPermit2Proxy` has code on testnet only.
- `x402BatchSettlement` and both deposit collectors have code on Arc mainnet and testnet (not listed in the x402 contracts README for Arc).
- Circle Facilitator `/supported` lists `exact` and `upto` for Arc; no `batch-settlement`. Extensions: `payment-identifier`, `settlement-status`, `eip2612GasSponsoring`.
- ERC-8183 testnet proxy: `platformFeeBP` 0, `evaluatorFeeBP` 0, treasury and sole role holder `0xcBe5B97a069be3E4B5398663790731fb76aB620D` (EOA). No `HookWhitelistUpdated`, `RoleRevoked`, or later `Upgraded` events. No code at the same address on mainnet.
- ERC-8004 mainnet: all three registries went from a bootstrap implementation `0xcb7af40c…f067` (`getVersion()` = "1.0.0") to v2.0.0 implementations on 2026-09-14 (Identity at block 20,817,518). No later upgrades (owner nonce still 3).
