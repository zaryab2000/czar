# `IJobEscrow` adapter (spec 03)

- **Date:** 2026-10-18; amended 2026-10-19 (RV-009, RV-024, D77). **Status:** draft. Interface: `interfaces/IJobEscrowAdapter.sol` (the vault-internal adapter surface) plus the two external ABIs it targets.
- **Decision:** D27 (Phase 1 on Circle's testnet instance, Czar as evaluator), D32 (`CzarJobEscrow` from `erc-8183/base-contracts`, behind the adapter).

## 1. Purpose and phase

- The vault is the ERC-8183 **client** (it must be `msg.sender` of `createJob` and `fund`, so refunds return to it). The adapter is vault-internal code selected by the immutable `jobEscrowKind`, so one vault bytecode supports both instances without delegatecall or a mutable adapter address.
- **Phase 1:** kind `CIRCLE_TESTNET` (ABI below). **Before mainnet:** kind `CZAR_BASE` (`czar-job-escrow.md`).

## 2. Two target ABIs

| Item | Circle testnet instance (`0x0747EEf0706327138c69792bF28Cd525089e4583`, impl `0xA316fd02…351a`) | `CzarJobEscrow` (base-contracts @ `142e669`) | Facts |
|---|---|---|---|
| `createJob` | `createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) → uint256` | `createJob(address provider, address evaluator, uint48 expiredAt, string description, address hook, uint256 providerAgentId) → uint256` | verified ABI; `ERC8183.sol` lines 512–520 |
| `setBudget` (provider) | `setBudget(uint256 jobId, uint256 amount, bytes optParams)` | `setBudget(uint256 jobId, address token, uint256 amount, bytes optParams)` | ABI; lines 621–627 |
| `fund` (client) | `fund(uint256 jobId, bytes optParams)` — **no `expectedBudget`** | `fund(uint256 jobId, address expectedToken, uint256 expectedBudget, bytes optParams)` → reverts `BudgetMismatch` / `PaymentTokenMismatch` | A4-05; lines 661–684 |
| budget read | `jobs(jobId)` getter → `(id, client, provider, evaluator, description, budget, expiredAt, status, hook)`; `getJob(jobId) → tuple`; `jobHasBudget(jobId)` | `getJob(jobId) → Job{client, status, provider, expiredAt, evaluator, submittedAt, budget, hook, paymentToken, providerAgentId, description, settledAmount, payoutReceiver}` | ABI; lines 56–70, 1081 |
| fees | `platformFeeBP()`, `evaluatorFeeBP()`, `platformTreasury()`; both 0 today, one EOA can change them | same names, capped `platformFeeBP + evaluatorFeeBP ≤ 10000` | A4-07, A4-11 |
| token | `paymentToken()` single, set at `initialize` | per job `paymentToken`, allowlist `setPaymentTokenAllowed` | ABI; A4-11 |
| `submit`, `complete`, `reject` | `(uint256 jobId, bytes32 deliverable\|reason, bytes optParams)` | same | ABI; lines 708–811 |
| `claimRefund` | `claimRefund(uint256 jobId)`; EIP reference has no caller check; `Funded`/`Submitted` after `expiredAt` | `claimRefund(uint256 jobId)`; `Open`/`Funded`/`Submitted`; `Submitted` needs `expiredAt + EVALUATION_GRACE_PERIOD` (1 h) | `erc-8183.md` lines 690–697; `ERC8183.sol` lines 863–871, 78 |
| status enum | `Open 0, Funded 1, Submitted 2, Completed 3, Rejected 4, Expired 5` | `Open, Funded, Submitted, Completed, Rejected, Expired` (+ claim states) | p1-E3; lines 33–38 |
| hooks | only `address(0)` whitelisted (A4-09) | Czar admin whitelists; Phase 1 none | A4-04, A4-09 |
| events the indexer reads | `JobCreated(jobId, client, provider, evaluator, expiredAt, hook)`, `BudgetSet(jobId, amount)`, `JobFunded(jobId, client, amount)`, `JobSubmitted(jobId, provider, deliverable)`, `JobCompleted(jobId, evaluator, reason)`, `JobRejected(jobId, rejector, reason)`, `JobExpired(jobId)`, `PaymentReleased(jobId, provider, amount)`, `Refunded(jobId, client, amount)`, `EvaluatorFeePaid`, `Upgraded(implementation)` | same names plus `BudgetSet(jobId, token, amount)`, `PlatformFeePaid`, `Settled`, claim events, `HookWhitelistUpdated`, `PaymentTokenAllowlistUpdated`, `PlatformFeeUpdated`, `EvaluatorFeeUpdated`, `EmergencyWithdraw` | ABI; lines 106–258 |

## 3. Adapter surface (vault-internal, `library JobEscrowAdapter`)

| Function | What it does per kind | Checks it adds |
|---|---|---|
| `create(kind, escrow, provider, evaluator, expiredAt, descriptionHash) → jobId` | Circle: `createJob(provider, evaluator, uint256(expiredAt), "czar:"+hex, address(0))`. Czar: `createJob(provider, evaluator, uint48(expiredAt), "czar:"+hex, address(0), 0)`. | `expiredAt ≥ now + MIN_JOB_EXPIRY_LEAD` (p1-E7: `ExpiryTooShort` under 5 min); `evaluator == vault.evaluator`; `provider != evaluator`; description is only `"czar:" + hex(descriptionHash)` (02 §5.2), never user text (p1-E7: calldata is public) |
| `readBudget(kind, escrow, jobId) → (budget, status, token)` | Circle: `jobs(jobId)` tuple (budget, status) and `paymentToken()`. Czar: `getJob(jobId)` (`budget`, `status`, `paymentToken`). | `status == Open`; `token == USDC` |
| `readFees(kind, escrow) → (platformBp, evaluatorBp)` | both: `platformFeeBP()`, `evaluatorFeeBP()` | Circle: both must be `0` (A4-07) else `UnexpectedFees`; Czar: sum ≤ `MAX_JOB_FEE_BPS` (500) |
| `fund(kind, escrow, jobId, budget)` | Circle: `USDC.forceApprove(escrow, budget)` then `fund(jobId, "")` (contract pulls `job.budget`, p1-E7). Czar: `forceApprove` then `fund(jobId, USDC, budget, "")`. | the vault re-reads the budget in the same transaction right before `fund`, so a provider cannot raise it between read and fund (same-tx atomicity replaces the missing `expectedBudget`, A4-05); approval reset to 0 after |
| `status(kind, escrow, jobId) → uint8` | as `readBudget` | maps both enums to the vault's `JobState` |
| `readOutcome(kind, escrow, jobId) → (status, budget, settledAmount, expiredAt)` | Circle: `jobs(jobId)` (`settledAmount = 0`, the instance has no partial claims). Czar: `getJob(jobId)` (`ICzarJobEscrowClient.getJob`, base line 1081) | `syncJob` decides only from this read, never from balances or events (RV-009) |
| `claimRefund(kind, escrow, jobId)` | both: `claimRefund(jobId)` | after `expiredAt` (Circle) or `expiredAt + 1 h` when `Submitted` (Czar) |

- `optParams` is always empty (`""`); nothing private is ever passed (p1-E7, A4-03).
- The evaluator key (K7) calls `complete(jobId, reportHash, "")` or `reject(jobId, reportHash, "")` on the escrow directly; the `reason` is `reportHash` (02 §5.2). The adapter never holds the evaluator key.

## 4. Fee check at fund time

- Read `platformFeeBP()` and `evaluatorFeeBP()` in the same transaction as `fund`. Circle's instance: require both `== 0` (A4-07). If the single admin EOA (A4-08) changes fees, `fundJob` reverts `UnexpectedFees` and the server re-plans; already-funded jobs are affected only by the escrow's own payout math at `complete` (fees come out of the budget on release; the vault already counts the full budget as `spent` at `Completed`, so accounting is conservative).

## 5. Evaluator separation

- `vault.evaluator` is set by the owner (default from the factory). `openJob` always names it; a hijacked agent key cannot name itself evaluator. K7 (evaluator) and K3 (agent) are separate KMS keys with separate blast radii (spec 01 §7.2).

## 6. Refunds and un-spending

- `Rejected` while `Open` (client reject, p1-E8), or still `Open` after `expiredAt`: no funds moved; `syncJob` sets the vault job to `Released` and releases `reservedCap` and its `stepUsed` (RV-009).
- `Rejected`/`Expired` after funding: the escrow transfers the refund back to the client (vault) in the same transaction that sets the status, so the status alone proves the refund. Refund = `budget − settledAmount` on the Czar instance (`approveClaim` may already have paid part, `ERC8183.sol` lines 840, 876) and `budget` on Circle's; `syncJob` books `jobEscrowed −= budget`, `spent += budget − refund`, and credits `refund` to `committedTotal` if the envelope is open (bounded by what is still in the vault, RV-011), else to free balance (`czar-vault.md` §5.5).
- `Completed`: `jobEscrowed −= budget; spent += budget`.

## 7. Events and errors (adapter-level, emitted by the vault)

See `czar-vault.md` §9: `JobOpened`, `JobFunded`, `JobSynced`, `JobRefunded`; errors `UnexpectedFees`, `WrongToken`, `JobNotOpen`, `JobWrongState`, `BudgetExceedsReserved`.

## 8. Invariants

| Id | Invariant |
|---|---|
| JOB-1 | A job is funded only with `budget ≤ reservedCap`, read in the same transaction as `fund`. |
| JOB-2 | A job is created only with `evaluator == vault.evaluator` and `provider` proven under `payeeRoot` (kind 2). |
| JOB-3 | `optParams` is always empty and `description` is always `"czar:" + 64 hex chars`. |
| JOB-4 | `jobEscrowed` equals the sum of budgets of jobs in state `Funded` or `Submitted`. |

## 9. Edge cases

- Circle's instance upgraded (`Upgraded` event): the server halts `openJob`; open jobs continue if the ABI is unchanged; the vault's `claimRefund` path is unhookable (A4-03).
- Provider never calls `setBudget`: the job stays `Opened` until expiry; `syncJob` after `expiredAt` sets `Released` and releases `reservedCap` (status still `Open`, no funds moved). The same applies to a duplicate job left by a crashed `openJob` retry (RV-009).
- Deliverable hash mismatch: the evaluator **rejects** (D77, RV-024); the escrow refunds and `syncJob` books it.
- Provider sets a budget above `reservedCap`: `fundJob` reverts `BudgetExceedsReserved`; the server asks the provider for a lower budget or re-plans.
- Czar instance `payoutReceiver` or disburser features (lines 465–510): unused by the vault; providers may use them.

## 10. Gas budget

See `czar-vault.md` §13 (`openJob` ≈ 230k, `fundJob` ≈ 150k, `syncJob` ≈ 50k, `claimJobRefund` ≈ 90k).

## 11. Mainnet differences

Kind switches from `CIRCLE_TESTNET` to `CZAR_BASE` (no official mainnet instance, A4-13). Fee rule switches from "must be 0" to "≤ `MAX_JOB_FEE_BPS`". The Czar instance's `fund` carries `expectedBudget` natively.

## Change log

| Date | ID | Change |
|---|---|---|
| 2026-10-19 | RV-009 | `readOutcome` (adds `settledAmount`, `expiredAt`); `ICzarJobEscrowClient.getJob`; `Opened` jobs released by `syncJob`; refunds decided from escrow status only (SCR-009). |
| 2026-10-19 | D77 | Deliverable hash mismatch is a reject (RV-024). |
