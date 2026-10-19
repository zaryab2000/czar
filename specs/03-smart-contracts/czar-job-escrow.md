# `CzarJobEscrow` (spec 03, before mainnet)

- **Date:** 2026-10-18. **Status:** draft. Interface: `interfaces/ICzarJobEscrow.sol` (the subset the vault, providers and the evaluator use).
- **Base:** `erc-8183/base-contracts` @ `142e669c1fd318486a4628395b629f033654dd06`, `contracts/ERC8183.sol` (MIT), deployed by Czar (D32). Czar does not fork the logic; it deploys the base contract behind a UUPS proxy with Czar's admin, and configures it.

## 1. Purpose and phase

- A Czar-owned ERC-8183 instance so mainnet jobs do not depend on a third party's single admin EOA (A4-08, A4-13). Ships **before mainnet**; Phase 1 uses Circle's testnet instance.

## 2. Roles and permissions

| Role | Holder | Can |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` (upgrade admin, `_authorizeUpgrade` line 334) | Czar upgrade multisig behind a 7-day timelock, separate from operations (CLAUDE.md "separate upgrade admin from operational roles") | upgrade; grant roles |
| `ADMIN_ROLE` | Czar ops key (timelocked 48 h for fee and allowlist changes) | `pause`/`unpause` (lines 339–344), `emergencyWithdraw` only while paused (line 353), `setPlatformFee` (367), `setEvaluatorFee` (380), `setHookWhitelist` (396), `setPaymentTokenAllowed` (412), `batchDetachHook` (425) |
| client | any `CzarVault` | `createJob`, `fund`, `claimRefund`, `reject` while `Open` |
| provider | specialist agent | `setBudget`, `submit`, claims |
| evaluator | Czar K7 | `complete`, `reject` |

## 3. Configuration at deployment (constants Czar sets)

| Setting | Value | Reason |
|---|---|---|
| `initialize(treasury_, admin_)` | treasury = Czar treasury; admin = timelock | line 313 |
| `platformFeeBP`, `evaluatorFeeBP` | `0` at launch; any change ≤ `MAX_JOB_FEE_BPS` (500) and timelocked | vaults refuse to fund above 500 bps (`job-escrow-adapter.md` §4) |
| payment tokens allowed | USDC only (`setPaymentTokenAllowed(0x3600…0000, true)`) | A4-11 allowlist |
| hooks whitelisted | none at launch; `address(0)` whitelisted at init (A4-11) | hooks are a later feature; `claimRefund` never hookable (A4-03) |
| `EVALUATION_GRACE_PERIOD` | `1 hours` (base constant, line 78) | provider protection after expiry |

## 4. Storage layout

As `ERC8183.sol` lines 56–105 (`Job` struct packed into 10 slots; `jobCounter`; `platformFeeBP`; `evaluatorFeeBP`; `platformTreasury`; `whitelistedHooks`; `allowedPaymentTokens`; `pendingClaimHash`). Czar adds nothing.

## 5. Functions used by Czar

| Function (base line) | Caller | Preconditions (from base) | Notes |
|---|---|---|---|
| `createJob(provider, evaluator, uint48 expiredAt, description, hook, providerAgentId)` (512) | vault | `whenNotPaused nonReentrant`; evaluator non-zero; `expiredAt > now + 5 min`; hook whitelisted; `provider != evaluator`; client ≠ provider | hook = 0, `providerAgentId` = 0 or the ERC-8004 agent id (A5-03) when known |
| `setBudget(jobId, token, amount, optParams)` (621) | provider | `Open`; token allowed | |
| `fund(jobId, expectedToken, expectedBudget, optParams)` (661) | vault | `Open`; `actor == client`; provider set; not expired; token and budget match; pulls exactly `budget` and checks the received delta (lines 690–698) | |
| `submit(jobId, deliverable, optParams)` (708) | provider | `Funded` | |
| `complete` / `reject(jobId, reason, optParams)` (754 / 806) | evaluator (client may reject while `Open`) | `Submitted` (or `Funded` for evaluator reject) | `reason = reportHash` |
| `claimRefund(jobId)` (863) | anyone | `Open`/`Funded`/`Submitted` after expiry (+ grace if `Submitted`) | refund to client (vault) |
| `getJob(jobId)` (1081) | anyone | — | |

Claims (`submitClaim`, `settleClaim`, `rejectClaim`, lines 921–1048) are available to providers for partial settlements; the vault treats a settled claim like `Completed` for the settled amount (`settledAmount` field) in a later adapter version; Phase "before mainnet" uses whole-job completion only.

## 6. State machine

Base enum (`Open, Funded, Submitted, Completed, Rejected, Expired`, lines 33–38) with the same transitions as the EIP (p1-E3, p1-E8). Vault-side mirror: `czar-vault.md` §8.4.

## 7. Events and errors

As listed in `job-escrow-adapter.md` §2 (base lines 106–305). The indexer subscribes to every job event plus `Upgraded`, `PlatformFeeUpdated`, `EvaluatorFeeUpdated`, `HookWhitelistUpdated`, `PaymentTokenAllowlistUpdated`, `Paused`, `Unpaused`, `EmergencyWithdraw`.

## 8. External dependencies

OpenZeppelin upgradeable v5.x (`AccessControlUpgradeable`, `UUPSUpgradeable`, `PausableUpgradeable`, `EIP712Upgradeable`), `ReentrancyGuardTransient`, `SafeERC20` (lines 5–15). Pin to the base repo's lockfile versions at deployment; record in the build plan.

## 9. Invariants

| Id | Invariant |
|---|---|
| CJE-1 | A job's escrowed USDC leaves the contract only to `provider`/`payoutReceiver` on `complete`/claims, to treasury/evaluator as fees, or back to `client` on `reject`/`claimRefund`. |
| CJE-2 | `platformFeeBP + evaluatorFeeBP ≤ 500` after any Czar admin action (policy enforced by the timelock proposal checker, and by vaults refusing to fund otherwise). |
| CJE-3 | `emergencyWithdraw` is only possible while paused and is always preceded by a public `Paused` event and the 48 h timelock on the pause-then-withdraw sequence. |

## 10. Edge cases

- Upgrade: the proxy admin is the 7-day timelock; vaults' indexers alert on `Upgraded` and the server halts new jobs until the new implementation is reviewed.
- Fee-on-transfer tokens: rejected by the base's received-amount check (lines 692–698); USDC is not one.
- `emergencyWithdraw` is a trust point (admin can move escrowed funds while paused): mitigated by the timelock and by keeping job budgets small; disclosed in the threat model.

## 11. Gas budget

Base contract costs (to measure): `createJob` ≈ 200k, `fund` ≈ 120k, `complete` ≈ 90k, `claimRefund` ≈ 60k at 20 Gwei ⇒ 0.004 / 0.0024 / 0.0018 / 0.0012 USDC.

## 12. Mainnet differences

This contract exists only for mainnet (and a testnet twin for rehearsal). Deployed through CREATE2 at the same address on both networks (A9-15). Not ABI-compatible with Circle's testnet instance (A4-11), hence the adapter.
