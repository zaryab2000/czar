# SCR-150: Gateway test doubles on the CLEAN local chain for the Track A exit runs

| Field | Value |
|---|---|
| ID | SCR-150 |
| Filed by | chief architect, 2026-10-27, from the Track A exit-run readiness check |
| Spec and section | D92 ("Circle contracts and APIs replaced by the T-010 mocks"); SCR-146 §3.3 runs 2–6; SCR-127, SCR-133, SCR-141, SCR-144, SCR-145; `contracts/script/Deploy.s.sol:21-22`; `ops/local/circle-standins/server.ts:181-191` |
| Status | Accepted (Zaryab's delegation for Track A closure; recorded by his merge) |

## Problem
- `Deploy.s.sol:21-22` hard-codes Circle's testnet `GatewayWallet` (`0x0077777d…19B9`) and `GatewayMinter` (`0x0022222A…475B`).
- On a CLEAN `arc-anvil` chain those addresses have no code. Every pocket call reverts:
  - `depositFor`, `isAuthorizedForBalance` (`PocketLogic.sol:113,122`)
  - `isTransferSpecHashUsed` (`:172,205`)
- The stand-in `/v1/transfer` returns a fixed fake attestation (`server.ts:186-190`) that no minter accepts.
- So SCR-146 runs 4 and 5 (pocket path, crash/restart) cannot run on any local chain, and no spec says how D92's "T-010 mocks" reach the canonical addresses.
- Runs 2, 3 and 6 also lack their chain or local-server test cases (readiness check of 2026-10-27).

## Change

### 1. Placing the doubles (CLEAN mode only; test harness only)
- **Steps:**
  1. After `deploy.sh`, the harness deploys `contracts/test/mocks/MockGatewayWallet.sol` and `MockGatewayMinter.sol` normally, so constructor immutables are baked into their runtime code.
  2. It copies each runtime code to the canonical address with `eth_getCode` → `anvil_setCode`.
  3. It calls a new one-time `testInitialize(...)` on each canonical address to set the storage the constructor would have set (controller, USDC token). `testInitialize` reverts if called twice.
- **Guards:**
  - The harness first checks that `eth_getCode` at both canonical addresses is empty, and that `anvil_nodeInfo` shows **no fork**. Otherwise it refuses: never overwrite real Circle code, so never in FORK mode.
  - The doubles are only placed from test or harness code under `apps/*/test/` or `ops/local/` CLEAN tooling. Never from `deploy.sh`'s production path.
- **Funding:** the minter double is pre-funded with local USDC using the existing funding methods.

### 2. Additions to the mock wallet (A2-13 to A2-15 semantics)
- `withdrawingBalance(token, depositor)` and `withdrawalBlock(token, depositor)`.
- `initiateWithdrawal(token, value)`:
  - moves `value` from available to withdrawing
  - sets `withdrawalBlock = block.number + withdrawalDelay`
  - a repeat call resets the timer (A2-15)
- `withdraw(token)`:
  - requires `block.number ≥ withdrawalBlock` and a withdrawing balance above 0
  - pays the depositor and zeroes the withdrawing balance
- `testSetWithdrawalDelay(blocks)`, controller-only. Local default: 10 blocks, so tests don't wait 7 days.
- Event names and signatures are copied from Circle's sources, as the existing mock does.

### 3. Additions to the mock minter
- `gatewayMint(bytes attestation, bytes signature)`:
  - decodes the local attestation (§4)
  - reverts if its `transferSpecHash` is already used
  - marks it used
  - transfers `value` USDC to `recipient`
  - emits `AttestationUsed(transferSpecHash)` with Circle's signature
- The signature is **not** verified, by design: it's a test double. Real verification is first exercised in M8 (D92).

### 4. Local attestation format (stand-in ↔ mock minter)
- `attestation = abi.encode(bytes32 transferSpecHash, address recipient, uint256 value, address depositor)`.
- **The stand-in's `/v1/transfer`:**
  - computes `transferSpecHash` from the request's burn intent with `@czar/hashing` `transferSpecStructHash` (the same helper the payer uses)
  - debits the depositor in the mock wallet via its existing controller `testBurn`, sent from the node's unlocked account
  - returns `{transferId, attestation, signature}`, where `signature` is any 65 bytes
  - returns a JSON error (no attestation) if the burn exceeds the mock available balance
- It keeps all existing stand-in refusals (loopback, `anvil_nodeInfo`, local overlay).

### 5. Run ownership and the missing cases
| Run | Missing | Owner |
|---|---|---|
| 2 | `CZAR_LOCAL_CHAIN` cases for the TA-01 settled-receipt rule (settled x402 authorization signs; unsettled is denied) and the SCR-145 overdue write-off (all eight predicates, against chain reads) | Lane 1 |
| 3 | Chain-backed `pocket_balances` test, with the doubles from §1: balances, closed-pocket quiet period, `pollEndedAt` | Lane 1 |
| 4 | `apps/server/test/local-pocket/pocket-arc.test.ts`: halt drain on freeze/pause, late funds, slow-path resume (SCR-144 restart cases), manual return, overdue write-off. Reuses the spawn and deploy pattern of `receipt-arc.test.ts` | Lane 2 |
| 5 | `apps/server/test/local-pocket/crash-restart-arc.test.ts`: kill and resume at `reserve.sent`, `call.sent`, before settle, between `/v1/transfer` and `gatewayMint`, and on an expired lease. Asserts on chain that reserve, payment and mint each happen once | Lane 2 |
| 6 | Playwright run of the manual-return UI against the local server (no route stub) | Lane 5 |

- Mock and stand-in additions (§1–§4): Lane 1, in one PR to `build-v1`, with Solidity tests on pinned `arc-anvil`.

## Not changed
- Production deploy, FORK mode, routing defaults (`routing.gatewayEnabled` stays `false`), the signer policy.

## Accepted risk
- The doubles approximate Circle's behaviour from the copied sources and A2 ground truth.
- Real attestation signatures, timing and re-credit (A2-18) are first exercised in M8 (D92).

## Decision
- Architect ruling under Zaryab's delegation. Recorded by his merge.
