# Contract size and gas measurements

Measured on 2026-10-20 with `FOUNDRY_PROFILE=arc` and Arc Foundry's warning-denied
clean build. Gas medians come from `arc-forge test --gas-report --fuzz-seed 0x2a
--no-match-contract "Invariant|MockSelf|Libraries|OpenEvidence"`.

## Size

| Contract | Runtime (B) | Initcode (B) | Runtime headroom to 24,576 B |
|---|---:|---:|---:|
| `CzarVault` | 14,540 | 16,233 | 10,036 |
| `CzarVaultFactory` | 20,747 | 38,225 | 3,829 |
| `CoreLogic` | 2,921 | 2,973 | 21,655 |
| `EnvelopeLogic` | 3,985 | 4,037 | 20,591 |
| `ReservationLogic` | 6,627 | 6,679 | 17,949 |
| `SignatureLogic` | 6,315 | 6,367 | 18,261 |
| `PocketLogic` | 9,346 | 9,398 | 15,230 |
| `JobLogic` | 11,822 | 11,874 | 12,754 |
| `AutonomyLogic` | 2,727 | 2,779 | 21,849 |
| `OwnerActionLogic` | 9,544 | 9,596 | 15,032 |

The factory has the least runtime headroom. Every size is within 300 bytes of
the PRD 11 reference and below the observed Arc runtime limit.

## Gas

| Function | Median gas | `czar-vault.md` §13 estimate |
|---|---:|---:|
| `openEnvelope` | 210,966 | 160,000 |
| `closeEnvelope` | 48,182 | 40,000 |
| `reserve` | 223,986 | 132,000 |
| `reserveWithDigests` | 179,766 | 324,000 (n = 8) |
| `settle` | 54,611 | 30,000 + 6,000k |
| `finalize` | 193,199 | 30,000 + 7,000k |
| `isValidSignature` | 23,532 | — |
| `registerPocket` | 97,485 | 62,000 |
| `grantPocketGas` | 43,474 | 40,000 |
| `fundPocket` | 201,229 | 130,000 |
| `requestPullback` | 224,275 | 120,000 |
| `confirmPullback` | 69,839 | 50,000 |
| `writeOffPocket` | 62,226 | 35,000 |
| `openJob` | 448,797 | 252,000 |
| `fundJob` | 196,527 | 150,000 |
| `syncJob` | 88,672 | 55,000 |
| `executeOwnerAction` | 84,610 | 40,000 + 6,900 + action |
| `createVault` (factory) | 3,120,732 | ≈ 2,500,000 |

These measurements include cold storage and linked-library calls that the
earlier §13 estimates did not measure. The medians for `reserveWithDigests`,
`finalize`, `isValidSignature`, `fundJob`, and `syncJob` differ from the PRD 11
reference; the values above are from this checkout's run.

Routing inputs (`G_reserve`, `G_settleBase`, `G_settleIdx`, `G_finalize`) come
from this table, not from the §13 estimates.

## Limit and decision

[G0-08](../docs/specs/05-build-plan/gate-0-results/G0-08.md) records a
24,576-byte runtime limit on local Arc and the Arc testnet estimate, and a
30,000,000 block gas limit on Arc testnet and mainnet. Both vault and factory
initcodes are below the 49,152-byte EIP-3860 limit.

D89: the vault's logic is in eight linked libraries from 07 PRD 03 on; no
further split is needed.
