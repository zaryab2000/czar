# 09 — Jobs and the escrow adapter

## 1. Scope
- **Task:** T-018 (ERC-8183 jobs with the vault as client: `openJob`, `fundJob`, `cancelJob`, `syncJob`, `claimJobRefund`, on both escrow kinds).
- **You build:**
  - `contracts/src/libraries/JobEscrowAdapter.sol`: the internal adapter library with the binding signatures of `job-escrow-adapter.md` §3 (§7, printed in full).
  - `contracts/src/vault/logic/JobLogic.sol`: a linked library with 5 external functions (§8).
  - `contracts/src/CzarVault.sol`: replaced with the version in §6 (adds 5 wrappers).
  - `contracts/test/JobTest.t.sol` (§9): one abstract test base and two concrete suites, `JobCircleTest` (kind 0, Circle's Arc testnet instance) and `JobCzarTest` (kind 1, `CzarJobEscrow`).
  - You delete 5 stubs from `VaultStubs.sol`.
- **Dependencies:** PRD 08 done (285 tests, `PocketTest` 43 passed, 8 stubs). The T-010 mocks `MockCircleAgenticCommerce` and `MockCzarJobEscrow` are used unchanged.

## 2. This PRD is already verified
- A reference `JobEscrowAdapter` (§7) and `JobLogic` written from §8 passed on **Arc Foundry v0.8.0-2** with `FOUNDRY_PROFILE=arc`: clean `--deny-warnings` build (compiler and lint), `fmt --check` clean, 373 tests passed (285 earlier plus 42 in `JobCircleTest` and 46 in `JobCzarTest`).
- Mutation checks were run: without `BudgetExceedsReserved` its test fails with an underflow; without the "envelope not `Open`: return" line of `_releaseOpened` one test per kind fails; without the Czar evaluation grace `test_claimJobRefund_czarSubmitted_needsGrace` fails.
- Sizes after this PRD: `CzarVault` runtime 13,808 B, initcode 15,501 B; `CzarVaultFactory` runtime 20,015 B; `JobLogic` runtime 11,867 B (the adapter is inside it).

## 3. Sources (read these, nothing else)
- `07-contract-build/01-shared-libraries.md` (the `CzarHashing`, `PayeeLeaf`, `CzarNonces` functions the steps call) and `07-contract-build/03-factory-and-vault-skeleton.md` §7 (`VaultState`, `VaultGuards`).
- `07-contract-build/00-conventions.md` (§3.2 library rules, §4.11 traps, §5 tests, §5.6 traps).
- `docs/specs/03-smart-contracts/job-escrow-adapter.md`, all of it (the two ABIs, the binding adapter signatures in §3, fees in §4, refunds in §6, JOB-1 … JOB-5).
- `docs/specs/03-smart-contracts/czar-vault.md`: §5.5 (the five functions), §8.4 (job state machine), §11 INV-2, INV-8, INV-12, INV-16, §15.1–§15.7 (`fundJob` check order, `claimJobRefund` time gate, events, effects order, `jobKey`, the 69-character description).
- `docs/specs/03-smart-contracts/interfaces/ICzarVault.sol` (`Job`, `JobState`, events, errors) and `IJobEscrowAdapter.sol` (`JobEscrowKind`, `EscrowStatus`, `ICircleTestnetAgenticCommerce`, `ICzarJobEscrowClient`).
- `docs/specs/03-smart-contracts/security-and-testing.md` §3.7 and §3.7a rows for RV-002, RV-005, RV-006, RV-009, H1, H2, N7, M1-b, R2.

## 4. Files
| File | Action | Section |
|---|---|---|
| `contracts/test/JobTest.t.sol` | create | §9 |
| `contracts/src/libraries/JobEscrowAdapter.sol` | create | §7 |
| `contracts/src/vault/logic/JobLogic.sol` | create | §8 |
| `contracts/src/vault/VaultStubs.sol` | delete 5 stubs | §5 |
| `contracts/src/CzarVault.sol` | replace | §6 |

## 5. Delete the stubs
- In `VaultStubs.sol`, delete the whole stub of `cancelJob`, `claimJobRefund`, `fundJob`, `openJob` and `syncJob`. Afterwards `grep -c "revert NotBuilt" src/vault/VaultStubs.sol` prints `3`.

## 6. `src/CzarVault.sol` (replace the whole file)
- Adds five wrappers, all `nonReentrant` (each calls the escrow, §15.5). `openJob` packs its arguments into `JobLogic.OpenJobRequest` (stack limit, 00-conventions §4.11). `syncJob` and `claimJobRefund` have no caller (anyone).
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICzarVault} from "./interfaces/ICzarVault.sol";
import {VaultBase} from "./vault/VaultBase.sol";
import {VaultStubs} from "./vault/VaultStubs.sol";
import {CoreLogic} from "./vault/logic/CoreLogic.sol";
import {EnvelopeLogic} from "./vault/logic/EnvelopeLogic.sol";
import {ReservationLogic} from "./vault/logic/ReservationLogic.sol";
import {SignatureLogic} from "./vault/logic/SignatureLogic.sol";
import {PocketLogic} from "./vault/logic/PocketLogic.sol";
import {JobLogic} from "./vault/logic/JobLogic.sol";

/// @title CzarVault
/// @notice The per-user vault (czar-vault.md). Immutable; no proxy (D33). Every state-changing function is a thin
///         wrapper: the reentrancy guard (§15.5) stays here, the logic runs in a linked library by DELEGATECALL on
///         this vault's storage (07 PRD 03). `msg.sender` is passed as `caller`, so the passkey path can pass the owner.
contract CzarVault is VaultBase, VaultStubs {
    /// @dev czar-vault.md §15.8. Called by CzarVaultFactory.createVault through CREATE2.
    constructor(address ownerAccount) VaultBase(ownerAccount) {}

    // ───────────── Balance and owner settings (§5.1) ─────────────

    /// @dev Native USDC arrives as free balance (A1-05). Not in ICzarVault.
    receive() external payable {
        emit NativeReceived(msg.sender, msg.value);
    }

    /// @inheritdoc ICzarVault
    function sync() external nonReentrant {
        emit BalanceSynced(IERC20(USDC).balanceOf(address(this)), _s.committedTotal);
    }

    /// @inheritdoc ICzarVault
    function withdraw(address to, uint256 amount) external nonReentrant {
        CoreLogic.withdraw(_s, _config(), msg.sender, to, amount);
    }

    /// @inheritdoc ICzarVault
    function setCategoryLimits(bytes32 categoryId, uint256 userMax, uint256 autoLimit) external {
        CoreLogic.setCategoryLimits(_s, _config(), msg.sender, categoryId, userMax, autoLimit);
    }

    /// @inheritdoc ICzarVault
    function freeze() external {
        CoreLogic.freeze(_s, _config(), msg.sender);
    }

    /// @inheritdoc ICzarVault
    function unfreeze() external {
        CoreLogic.unfreeze(_s, _config(), msg.sender);
    }

    /// @inheritdoc ICzarVault
    function rotateSigners(address agent, address autonomy, address evaluator_) external {
        CoreLogic.rotateSigners(_s, _config(), msg.sender, agent, autonomy, evaluator_);
    }

    /// @inheritdoc ICzarVault
    function setPasskey(bytes32 qx, bytes32 qy, bytes32 rpIdHash) external {
        CoreLogic.setPasskey(_s, _config(), msg.sender, qx, qy, rpIdHash);
    }

    /// @inheritdoc ICzarVault
    function setMaxPullbackFee(uint256 newMax) external {
        CoreLogic.setMaxPullbackFee(_s, _config(), msg.sender, newMax);
    }

    // ───────────── Envelopes (§5.2) ─────────────

    /// @inheritdoc ICzarVault
    function openEnvelope(OpenEnvelopeParams calldata p) external nonReentrant returns (uint64) {
        return EnvelopeLogic.openEnvelope(_s, _config(), msg.sender, p);
    }

    /// @inheritdoc ICzarVault
    function closeEnvelope(uint64 envelopeId) external {
        EnvelopeLogic.closeEnvelope(_s, _config(), msg.sender, envelopeId);
    }

    /// @inheritdoc ICzarVault
    function forceCloseEnvelope(uint64 envelopeId) external {
        EnvelopeLogic.forceCloseEnvelope(_s, _config(), msg.sender, envelopeId);
    }

    // ───────────── Reservations (§5.3) ─────────────

    /// @inheritdoc ICzarVault
    function reserve(
        uint64 envelopeId,
        uint32 stepIndex,
        address payee,
        uint256 stepCap,
        bytes32[] calldata proof,
        uint256 unitAmount,
        uint32 count,
        uint64 validBefore
    ) external returns (uint64) {
        ReservationLogic.ReserveRequest memory q = ReservationLogic.ReserveRequest(
            envelopeId, stepIndex, payee, stepCap, unitAmount, count, validBefore, ReservationMode.Envelope
        );
        return ReservationLogic.reserve(_s, _config(), msg.sender, q, proof);
    }

    /// @inheritdoc ICzarVault
    function reserveWithDigests(
        uint64 envelopeId,
        uint32 stepIndex,
        address payee,
        uint256 stepCap,
        bytes32[] calldata proof,
        uint256 unitAmount,
        uint32 count,
        uint64 validBefore
    ) external returns (uint64) {
        ReservationLogic.ReserveRequest memory q = ReservationLogic.ReserveRequest(
            envelopeId, stepIndex, payee, stepCap, unitAmount, count, validBefore, ReservationMode.Digest
        );
        return ReservationLogic.reserve(_s, _config(), msg.sender, q, proof);
    }

    /// @inheritdoc ICzarVault
    function settle(uint64 reservationId, uint32[] calldata indices) external nonReentrant {
        ReservationLogic.settle(_s, _config(), reservationId, indices);
    }

    /// @inheritdoc ICzarVault
    function finalize(uint64 reservationId, uint32 fromIndex, uint32 toIndex) external nonReentrant {
        ReservationLogic.finalize(_s, _config(), reservationId, fromIndex, toIndex);
    }

    // ───────────── ERC-1271 (§6) ─────────────

    /// @inheritdoc ICzarVault
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        return SignatureLogic.isValidSignature(_s, _config(), digest, signature);
    }

    // ───────────── Pockets (§5.4) ─────────────

    /// @inheritdoc ICzarVault
    function registerPocket(uint64 envelopeId, address pocket, bytes32[] calldata proof) external {
        PocketLogic.registerPocket(_s, _config(), msg.sender, envelopeId, pocket, proof);
    }

    /// @inheritdoc ICzarVault
    function grantPocketGas(address pocket, uint256 units) external nonReentrant {
        PocketLogic.grantPocketGas(_s, _config(), msg.sender, pocket, units);
    }

    /// @inheritdoc ICzarVault
    function fundPocket(address pocket, uint256 amount) external nonReentrant {
        PocketLogic.fundPocket(_s, _config(), msg.sender, pocket, amount);
    }

    /// @inheritdoc ICzarVault
    function requestPullback(address pocket, uint256 value, uint256 maxFee, uint256 maxBlockHeight)
        external
        returns (uint64)
    {
        return PocketLogic.requestPullback(_s, _config(), msg.sender, pocket, value, maxFee, maxBlockHeight);
    }

    /// @inheritdoc ICzarVault
    function confirmPullback(uint64 pullbackId) external nonReentrant {
        PocketLogic.confirmPullback(_s, _config(), pullbackId);
    }

    /// @inheritdoc ICzarVault
    function cancelPullback(uint64 pullbackId) external nonReentrant {
        PocketLogic.cancelPullback(_s, _config(), msg.sender, pullbackId);
    }

    /// @inheritdoc ICzarVault
    function writeOffPocket(address pocket) external {
        PocketLogic.writeOffPocket(_s, _config(), msg.sender, pocket);
    }

    /// @inheritdoc ICzarVault
    function recordManualReturn(address pocket, uint256 amount) external nonReentrant {
        PocketLogic.recordManualReturn(_s, _config(), msg.sender, pocket, amount);
    }

    // ───────────── Jobs (§5.5) ─────────────

    /// @inheritdoc ICzarVault
    function openJob(
        uint64 envelopeId,
        uint32 stepIndex,
        address provider,
        uint256 stepCap,
        bytes32[] calldata proof,
        uint64 expiredAt,
        bytes32 descriptionHash
    ) external nonReentrant returns (bytes32) {
        JobLogic.OpenJobRequest memory q = JobLogic.OpenJobRequest(
            envelopeId, stepIndex, provider, stepCap, expiredAt, descriptionHash
        );
        return JobLogic.openJob(_s, _config(), msg.sender, q, proof);
    }

    /// @inheritdoc ICzarVault
    function fundJob(bytes32 jobKey, uint256 expectedBudget) external nonReentrant {
        JobLogic.fundJob(_s, _config(), msg.sender, jobKey, expectedBudget);
    }

    /// @inheritdoc ICzarVault
    function cancelJob(bytes32 jobKey) external nonReentrant {
        JobLogic.cancelJob(_s, _config(), msg.sender, jobKey);
    }

    /// @inheritdoc ICzarVault
    function syncJob(bytes32 jobKey) external nonReentrant {
        JobLogic.syncJob(_s, _config(), jobKey);
    }

    /// @inheritdoc ICzarVault
    function claimJobRefund(bytes32 jobKey) external nonReentrant {
        JobLogic.claimJobRefund(_s, _config(), jobKey);
    }
}
```

## 7. `src/libraries/JobEscrowAdapter.sol` (copy exactly)
- **What it is:** the vault-internal adapter over the two ERC-8183 instances, with exactly the seven `internal` functions of `job-escrow-adapter.md` §3, plus one `private` encoder. `JobLogic` (a linked library) uses it, so its code ends up inside `JobLogic`.
- **Why it is printed in full:** the seven signatures are binding (D88, G-05), and the two instances differ in subtle ways: Circle's `jobs(jobId)` getter returns a nine-field tuple with the status as a `uint8` and has no `settledAmount`; the Czar instance's `getJob` returns a struct; Circle's `fund(jobId, "")` has no `expectedBudget`, the Czar instance's `fund(jobId, token, budget, "")` does; the Czar instance takes `expiredAt` as `uint48` (`SafeCast`, so a value that does not fit reverts instead of wrapping).
- **The description encoder** (§15.6, JOB-3): `"czar:"` followed by the 64 lowercase hex characters of `descriptionHash`, no `0x`, 69 ASCII characters. OpenZeppelin `Strings.toHexString` adds `0x`, so the adapter has its own fixed-length encoder.
- The library raises no errors of its own; the escrows' own reverts bubble up unchanged (§15.5).
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {
    IJobEscrowAdapter,
    ICircleTestnetAgenticCommerce,
    ICzarJobEscrowClient
} from "../interfaces/IJobEscrowAdapter.sol";
import {DESCRIPTION_PREFIX} from "./CzarConstants.sol";

/// @title JobEscrowAdapter
/// @notice Vault-internal adapter over the two ERC-8183 instances (job-escrow-adapter.md §3, binding signatures,
///         D88 G-05). Selected by the vault's immutable `jobEscrowKind`. The library raises no errors of its own:
///         the vault does every check in czar-vault.md §15.3 order; external reverts bubble unchanged (§15.5).
///         `optParams` is always empty and `hook` is always `address(0)` (JOB-3, A4-03).
library JobEscrowAdapter {
    using SafeERC20 for IERC20;

    /// @dev Lowercase hex digits for the description encoder (§15.6).
    bytes16 private constant HEX_DIGITS = "0123456789abcdef";
    /// @dev 64 hex characters encode one bytes32.
    uint256 private constant HASH_HEX_LENGTH = 64;

    /// @notice createJob with the vault as client; description = "czar:" + 64 lowercase hex chars (JOB-3).
    function create(
        IJobEscrowAdapter.JobEscrowKind kind,
        address escrow,
        address provider,
        address evaluator,
        uint64 expiredAt,
        bytes32 descriptionHash
    ) internal returns (uint256 jobId) {
        string memory description = _description(descriptionHash);
        if (kind == IJobEscrowAdapter.JobEscrowKind.CircleTestnet) {
            jobId = ICircleTestnetAgenticCommerce(escrow)
                .createJob(provider, evaluator, uint256(expiredAt), description, address(0));
        } else {
            jobId = ICzarJobEscrowClient(escrow)
                .createJob(provider, evaluator, SafeCast.toUint48(expiredAt), description, address(0), 0);
        }
    }

    /// @notice Budget, status and payment token, read in the same transaction as fund (A4-05).
    function readBudget(IJobEscrowAdapter.JobEscrowKind kind, address escrow, uint256 jobId)
        internal
        view
        returns (uint256 budget, IJobEscrowAdapter.EscrowStatus status, address token)
    {
        if (kind == IJobEscrowAdapter.JobEscrowKind.CircleTestnet) {
            uint8 s;
            (,,,,, budget,, s,) = ICircleTestnetAgenticCommerce(escrow).jobs(jobId);
            status = IJobEscrowAdapter.EscrowStatus(s);
            token = ICircleTestnetAgenticCommerce(escrow).paymentToken();
        } else {
            ICzarJobEscrowClient.Job memory j = ICzarJobEscrowClient(escrow).getJob(jobId);
            (budget, status, token) = (j.budget, IJobEscrowAdapter.EscrowStatus(j.status), j.paymentToken);
        }
    }

    /// @notice platformFeeBP and evaluatorFeeBP (same selectors on both instances).
    function readFees(IJobEscrowAdapter.JobEscrowKind kind, address escrow)
        internal
        view
        returns (uint256 platformBp, uint256 evaluatorBp)
    {
        if (kind == IJobEscrowAdapter.JobEscrowKind.CircleTestnet) {
            platformBp = ICircleTestnetAgenticCommerce(escrow).platformFeeBP();
            evaluatorBp = ICircleTestnetAgenticCommerce(escrow).evaluatorFeeBP();
        } else {
            platformBp = ICzarJobEscrowClient(escrow).platformFeeBP();
            evaluatorBp = ICzarJobEscrowClient(escrow).evaluatorFeeBP();
        }
    }

    /// @notice Approve exactly `budget`, fund, reset the approval to 0 (§15.5 fundJob order).
    function fund(IJobEscrowAdapter.JobEscrowKind kind, address escrow, address usdc, uint256 jobId, uint256 budget)
        internal
    {
        IERC20(usdc).forceApprove(escrow, budget);
        if (kind == IJobEscrowAdapter.JobEscrowKind.CircleTestnet) {
            ICircleTestnetAgenticCommerce(escrow).fund(jobId, "");
        } else {
            ICzarJobEscrowClient(escrow).fund(jobId, usdc, budget, "");
        }
        IERC20(usdc).forceApprove(escrow, 0);
    }

    /// @notice Status, budget, already-settled amount and expiry, as syncJob reads them (RV-009).
    ///         Circle's instance has no partial claims, so `settledAmount` is 0 there.
    function readOutcome(IJobEscrowAdapter.JobEscrowKind kind, address escrow, uint256 jobId)
        internal
        view
        returns (IJobEscrowAdapter.EscrowStatus status, uint256 budget, uint256 settledAmount, uint64 expiredAt)
    {
        if (kind == IJobEscrowAdapter.JobEscrowKind.CircleTestnet) {
            uint8 s;
            uint256 exp;
            (,,,,, budget, exp, s,) = ICircleTestnetAgenticCommerce(escrow).jobs(jobId);
            status = IJobEscrowAdapter.EscrowStatus(s);
            expiredAt = SafeCast.toUint64(exp);
        } else {
            ICzarJobEscrowClient.Job memory j = ICzarJobEscrowClient(escrow).getJob(jobId);
            (status, budget, settledAmount, expiredAt) =
            (IJobEscrowAdapter.EscrowStatus(j.status), j.budget, j.settledAmount, j.expiredAt);
        }
    }

    /// @notice Client reject while Open (H2); the vault is msg.sender, which is job.client.
    function cancel(IJobEscrowAdapter.JobEscrowKind kind, address escrow, uint256 jobId, bytes32 reason) internal {
        if (kind == IJobEscrowAdapter.JobEscrowKind.CircleTestnet) {
            ICircleTestnetAgenticCommerce(escrow).reject(jobId, reason, "");
        } else {
            ICzarJobEscrowClient(escrow).reject(jobId, reason, "");
        }
    }

    /// @notice claimRefund on the escrow (never hookable, A4-03).
    function claimRefund(IJobEscrowAdapter.JobEscrowKind kind, address escrow, uint256 jobId) internal {
        if (kind == IJobEscrowAdapter.JobEscrowKind.CircleTestnet) {
            ICircleTestnetAgenticCommerce(escrow).claimRefund(jobId);
        } else {
            ICzarJobEscrowClient(escrow).claimRefund(jobId);
        }
    }

    /// @dev DESCRIPTION_PREFIX + 64 lowercase hex characters of `h`, no "0x": 69 ASCII characters (§15.6).
    ///      OpenZeppelin Strings.toHexString adds "0x", so this fixed-length encoder is used instead.
    function _description(bytes32 h) private pure returns (string memory) {
        bytes memory prefix = bytes(DESCRIPTION_PREFIX);
        bytes memory out = new bytes(prefix.length + HASH_HEX_LENGTH);
        for (uint256 i = 0; i < prefix.length; i++) {
            out[i] = prefix[i];
        }
        uint256 value = uint256(h);
        for (uint256 i = HASH_HEX_LENGTH; i > 0; i--) {
            out[prefix.length + i - 1] = HEX_DIGITS[value & 0xf];
            value >>= 4;
        }
        return string(out);
    }
}
```

- **Copy §7 exactly, then diff it.** `readOutcome` returns four values; JobLogic never uses the fourth (`expiredAt`), so a transcription slip there passes every test. After writing the file, compare it with the block above (`diff` against a copy of the block) and fix any difference.

## 8. `src/vault/logic/JobLogic.sol`

### 8.1 Header and struct
- `// SPDX-License-Identifier: MIT`, `pragma solidity 0.8.30;`
- Imports, exactly:
  - `{ICzarVault}` from `../../interfaces/ICzarVault.sol`
  - `{IJobEscrowAdapter}` from `../../interfaces/IJobEscrowAdapter.sol`
  - `{VaultState, VaultConfig}` from `../VaultState.sol`
  - `{VaultGuards}` from `../VaultGuards.sol`
  - `{JobEscrowAdapter}` from `../../libraries/JobEscrowAdapter.sol`
  - `{PayeeLeaf}` from `../../libraries/PayeeLeaf.sol`
  - `{PAYEE_KIND_JOB, POCKET_STEP_INDEX, MIN_JOB_EXPIRY_LEAD, MAX_JOB_FEE_BPS, CANCEL_REASON, CZAR_ESCROW_EVALUATION_GRACE}` from `../../libraries/CzarConstants.sol`
- `/// @title JobLogic`, a `/// @notice` citing `czar-vault.md` §5.5, §8.4, §15, `job-escrow-adapter.md` and T-018. `library JobLogic { … }`.
- First in the library, exactly:
```solidity
    struct OpenJobRequest {
        uint64 envelopeId;
        uint32 stepIndex;
        address provider;
        uint256 stepCap;
        uint64 expiredAt;
        bytes32 descriptionHash;
    }
```
- In the steps, `kind` means `_kind(c)` (§8.7) and `escrow` means `c.jobEscrow`; use them directly, with no extra locals.
- "Circle kind" means `kind == IJobEscrowAdapter.JobEscrowKind.CircleTestnet`; "Czar kind" means `kind == IJobEscrowAdapter.JobEscrowKind.CzarBase` (both declared in `src/interfaces/IJobEscrowAdapter.sol`).
- Wherever a step uses `e` and the function has not declared it yet, declare it at first use: `ICzarVault.Envelope storage e = s.envelopes[<the record's envelopeId>];` (`q.envelopeId` in `_storeJob`, `j.envelopeId` elsewhere).
- Every "→ `X`" in a check means `revert ICzarVault.X();` (or with the arguments shown).

### 8.2 `openJob(VaultState storage s, VaultConfig memory c, address caller, OpenJobRequest memory q, bytes32[] calldata proof) external returns (bytes32 jobKey)`
- Body: `_checkOpenJob(s, c, caller, q, proof); return _storeJob(s, c, q);`
- **`_checkOpenJob(...) private view`**, in this order (§15.3 general order):
  1. `VaultGuards.requireAgent(s, caller);` then `VaultGuards.requireNotPausedOrFrozen(s, c);`
  2. `ICzarVault.Envelope storage e = s.envelopes[q.envelopeId];` not `Open` → `EnvelopeNotOpen`; `block.timestamp >= e.expiresAt` → `EnvelopeExpired`
  3. `q.stepIndex == POCKET_STEP_INDEX || q.stepCap > e.maxStepAmount` → `BadParams`
  4. `q.expiredAt < block.timestamp + MIN_JOB_EXPIRY_LEAD || q.expiredAt > e.expiresAt` → `BadParams`
  5. `q.provider == s.evaluator` → `BadParams` (JOB-2; base-contracts `ProviderCannotBeEvaluator`)
  6. `!PayeeLeaf.verify(proof, e.payeeRoot, q.provider, PAYEE_KIND_JOB, q.stepIndex, q.stepCap)` → `PayeeNotInPlan`
  7. `uint256 used = s.stepUsed[q.envelopeId][q.stepIndex];` `used + q.stepCap > q.stepCap` → `ICzarVault.StepCapExceeded(q.stepIndex, used, q.stepCap, q.stepCap)` (a job reserves its whole step cap, so nothing else may be on the step; RV-002)
  8. `VaultGuards.exposure(e) + q.stepCap > e.cap` → `CapExceeded`
- **`_storeJob(VaultState storage s, VaultConfig memory c, OpenJobRequest memory q) private returns (bytes32 jobKey)`**, effects before the escrow call (§15.5):
  1. `ICzarVault.Envelope storage e = s.envelopes[q.envelopeId]; e.reserved += q.stepCap; e.openJobs += 1;`
  2. `uint256 used = s.stepUsed[q.envelopeId][q.stepIndex] + q.stepCap; s.stepUsed[q.envelopeId][q.stepIndex] = used;`
  3. `address evaluator = s.evaluator;`
  4. `uint256 jobId = JobEscrowAdapter.create(kind, escrow, q.provider, evaluator, q.expiredAt, q.descriptionHash);`
  5. `jobKey = keccak256(abi.encode(escrow, jobId));` (§15.6)
  6. `ICzarVault.Job storage j = s.jobs[jobKey];` set `provider`, `envelopeId`, `stepIndex`, `state = Opened`, `expiredAt`, `jobId`, `reservedCap = q.stepCap` (`budget` stays 0)
  7. `emit ICzarVault.JobOpened(jobKey, q.envelopeId, q.provider, q.stepIndex, escrow, jobId, evaluator, q.stepCap, q.descriptionHash);`
  8. `emit ICzarVault.StepUsed(q.envelopeId, q.stepIndex, used);`

### 8.3 `fundJob(VaultState storage s, VaultConfig memory c, address caller, bytes32 jobKey, uint256 expectedBudget) external`
1. `ICzarVault.Job storage j = s.jobs[jobKey]; uint256 b = _checkFundJob(s, c, caller, j, expectedBudget);`
2. Effects: `ICzarVault.Envelope storage e = s.envelopes[j.envelopeId]; uint256 unused = j.reservedCap - b;` `e.reserved -= j.reservedCap; e.jobEscrowed += b; s.committedTotal -= b;` (the budget leaves the vault) `s.stepUsed[j.envelopeId][j.stepIndex] -= unused;` `j.budget = b; j.state = ICzarVault.JobState.Funded;`
3. `JobEscrowAdapter.fund(kind, escrow, c.usdc, j.jobId, b);` (approve exactly `b`, fund, reset the approval)
4. `emit ICzarVault.JobFunded(jobKey, b);`
5. `if (unused != 0) emit ICzarVault.StepUsed(j.envelopeId, j.stepIndex, s.stepUsed[j.envelopeId][j.stepIndex]);` (only when the step's use changed)
- **`_checkFundJob(s, c, caller, ICzarVault.Job storage j, uint256 expectedBudget) private view returns (uint256 b)`**, exactly the §15.3 `fundJob` order:
  1. `requireAgent`, then `requireNotPausedOrFrozen`
  2. `j.state != Opened` → `JobWrongState`
  3. envelope not `Open` → `EnvelopeNotOpen`; expired → `EnvelopeExpired`
  4. `(b, status, token) = JobEscrowAdapter.readBudget(kind, escrow, j.jobId);` (declare `IJobEscrowAdapter.EscrowStatus status; address token;` first)
  5. `status != Open` → `JobNotOpen`; `block.timestamp >= j.expiredAt` → `JobNotOpen`
  6. `b != expectedBudget` → `ICzarVault.BudgetChanged(expectedBudget, b)` (M1-b)
  7. `b == 0` → `BadParams` (R2)
  8. `b > j.reservedCap` → `BudgetExceedsReserved` (JOB-1)
  9. `(uint256 platformBp, uint256 evaluatorBp) = JobEscrowAdapter.readFees(kind, escrow);` Circle kind: either non-zero → `ICzarVault.UnexpectedFees(platformBp, evaluatorBp)`; Czar kind: `platformBp + evaluatorBp > MAX_JOB_FEE_BPS` → the same error
  10. `token != c.usdc` → `WrongToken`
- Reading the budget and funding in one transaction is what stops a provider from raising the budget in between on Circle's instance, which has no `expectedBudget` (A4-05).

### 8.4 `cancelJob(VaultState storage s, VaultConfig memory c, address caller, bytes32 jobKey) external`
(H2; owner or agent; not gated by freeze or pause: it only releases exposure)
1. `VaultGuards.requireOwnerOrAgent(s, c, caller);`
2. `j.state != Opened` → `JobWrongState`
3. `(IJobEscrowAdapter.EscrowStatus status,,,) = JobEscrowAdapter.readOutcome(kind, escrow, j.jobId);` `status != Open` → `ICzarVault.JobNotCancellable(uint8(status))`
4. `bool released = _releaseOpened(s, j);`
5. `JobEscrowAdapter.cancel(kind, escrow, j.jobId, CANCEL_REASON);` (the vault, as client, rejects while `Open`)
6. `emit ICzarVault.JobCancelled(jobKey);` then `if (released) emit ICzarVault.StepUsed(j.envelopeId, j.stepIndex, s.stepUsed[j.envelopeId][j.stepIndex]);`

### 8.5 `syncJob(VaultState storage s, VaultConfig memory c, bytes32 jobKey) external`
(anyone; decided from the escrow status only, never from balances or events, RV-009)
1. `ICzarVault.JobState state = j.state;` not `Opened`, `Funded` or `Submitted` → `JobWrongState` (an unknown key is `None`)
2. `(IJobEscrowAdapter.EscrowStatus status,, uint256 settled,) = JobEscrowAdapter.readOutcome(kind, escrow, j.jobId);`
3. Branch, first match wins:
   1. `state == Opened` → `_syncOpened(s, jobKey, j, status);`
   2. `status == Submitted && state == Funded` → `j.state = Submitted;` `emit ICzarVault.JobSynced(jobKey, uint8(ICzarVault.JobState.Submitted), false);`
   3. `status == Completed` → `ICzarVault.Envelope storage e = s.envelopes[j.envelopeId];` `e.jobEscrowed -= j.budget; e.spent += j.budget;` if the envelope is `Open`: `e.openJobs -= 1;` `j.state = Completed;` `emit JobSynced(jobKey, uint8(Completed), false);`
   4. `status == Rejected || status == Expired` → `(uint256 refund, bool credited) = _bookRefund(s, c, j, settled);` `emit JobSynced(jobKey, uint8(Refunded), credited);` and `if (credited && refund != 0) emit StepUsed(...)` with the step's new value
   5. anything else (escrow `Funded`, or `Submitted` already mirrored) → `revert ICzarVault.NoChange();`
- **`_syncOpened(VaultState storage s, bytes32 jobKey, ICzarVault.Job storage j, IJobEscrowAdapter.EscrowStatus status) private`** (RV-009, H1):
  1. `status == Funded` → `revert ICzarVault.NoChange();` (only the vault can fund; impossible while the vault says `Opened`)
  2. `bool envelopeClosed = s.envelopes[j.envelopeId].state != Open;` if `status == Open && block.timestamp < j.expiredAt && !envelopeClosed` → `revert ICzarVault.NoChange();`
  3. Every other case releases (escrow `Rejected`, `Expired`, `Submitted` or `Completed` with no funding, `Open` after `expiredAt`, or the envelope closed): `bool released = _releaseOpened(s, j);`
  4. `emit ICzarVault.JobSynced(jobKey, uint8(ICzarVault.JobState.Released), false);` (§15.4: from `Opened` the state is 6 and the flag false) then `if (released) emit StepUsed(...)`

### 8.6 `claimJobRefund(VaultState storage s, VaultConfig memory c, bytes32 jobKey) external`
(anyone; §15.7 time gate)
1. `j.state` neither `Funded` nor `Submitted` → `JobWrongState`
2. `(IJobEscrowAdapter.EscrowStatus status,,,) = JobEscrowAdapter.readOutcome(kind, escrow, j.jobId);` (the **escrow's** status, not the vault's record)
3. `uint256 opensAt = j.expiredAt;` if Czar kind and `status == Submitted`: `opensAt += CZAR_ESCROW_EVALUATION_GRACE;`
4. `block.timestamp < opensAt` → `NotExpired`
5. `JobEscrowAdapter.claimRefund(kind, escrow, j.jobId);` (the one call before effects, §15.5: the function is guarded and the escrow is pinned)
6. `(,, uint256 settled,) = JobEscrowAdapter.readOutcome(kind, escrow, j.jobId);`
7. `(uint256 refund, bool credited) = _bookRefund(s, c, j, settled);`
8. `emit ICzarVault.JobRefunded(jobKey, refund, credited);` (not `JobSynced`, §15.4) then `if (credited && refund != 0) emit StepUsed(...)`

### 8.7 Private helpers
1. **`_releaseOpened(VaultState storage s, ICzarVault.Job storage j) private returns (bool stepChanged)`** — the `Released` transition of an `Opened` job:
   - `j.state = ICzarVault.JobState.Released;`
   - `ICzarVault.Envelope storage e = s.envelopes[j.envelopeId];` if `e.state != Open`: `return false;` (a force-close already released the cap)
   - `e.reserved -= j.reservedCap; e.openJobs -= 1; s.stepUsed[j.envelopeId][j.stepIndex] -= j.reservedCap;`
   - `return j.reservedCap != 0;`
2. **`_bookRefund(VaultState storage s, VaultConfig memory c, ICzarVault.Job storage j, uint256 settled) private returns (uint256 refund, bool credited)`** — the refund branch shared by `syncJob` and `claimJobRefund`. The escrow already sent `budget − settledAmount` back in the transaction that set `Rejected` or `Expired`, so the status alone proves the refund (`job-escrow-adapter.md` §6):
   - `ICzarVault.Envelope storage e = s.envelopes[j.envelopeId]; uint256 budget = j.budget; refund = budget - settled;`
   - `e.jobEscrowed -= budget; e.spent += budget - refund; j.state = ICzarVault.JobState.Refunded;`
   - if `e.state == Open`: `VaultGuards.creditEnvelope(s, c, j.envelopeId, e, refund); s.stepUsed[j.envelopeId][j.stepIndex] -= refund; e.openJobs -= 1; credited = true;` (else the refund is free balance)
3. **`_kind(VaultConfig memory c) private pure returns (IJobEscrowAdapter.JobEscrowKind)`**: `return IJobEscrowAdapter.JobEscrowKind(c.jobEscrowKind);` (the constructor refuses any value above 1)

### 8.8 Order in the file
`OpenJobRequest`, `openJob`, `_checkOpenJob`, `_storeJob`, `fundJob`, `_checkFundJob`, `cancelJob`, `syncJob`, `_syncOpened`, `claimJobRefund`, `_releaseOpened`, `_bookRefund`, `_kind`, under the dividers `Open and fund`, `Cancel`, `Sync and refund`, `Helpers`.

## 9. `test/JobTest.t.sol`
- `JobTestBase` (abstract) holds 40 tests that run against both kinds through four hooks (`_escrow`, `_setBudget`, `_escrowDescription`, `_escrowStatus`). `JobCircleTest` adds 2 (fees must be zero; no evaluation grace), `JobCzarTest` 6 (fee cap, another token, provider reject while `Open`, the partial-claim refund with the spec's figures, the evaluation grace, a third party's `claimRefund` on an `Open` job).
- Every named test of `security-and-testing.md` §3.7 and §3.7a assigned to T-018 is here with its exact name. Three of them need a payee tree other than the four-leaf fixture (`test_openJob_afterReserveOnSameStep_reverts` and `test_cancelJob_open_releasesAndAlternateOpens` a two-leaf tree, `test_syncJob_czarPartialClaim_refundsBudgetMinusSettled` a one-leaf tree); each builds it in place with `PayeeLeaf.hash` and OpenZeppelin `Hashes.commutativeKeccak256` (a two-leaf root is the sorted-pair hash, and each proof is the other leaf; a one-leaf root is the leaf itself, with an empty proof).
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {ICzarVault} from "../src/interfaces/ICzarVault.sol";
import {ICzarVaultFactory} from "../src/interfaces/ICzarVaultFactory.sol";
import {ICircleTestnetAgenticCommerce} from "../src/interfaces/IJobEscrowAdapter.sol";
import {PayeeLeaf} from "../src/libraries/PayeeLeaf.sol";
import {
    USDC_ADDRESS,
    MIN_JOB_EXPIRY_LEAD,
    CANCEL_REASON,
    CZAR_ESCROW_EVALUATION_GRACE,
    FORCE_CLOSE_DELAY,
    PAYEE_KIND_X402,
    PAYEE_KIND_JOB
} from "../src/libraries/CzarConstants.sol";
import {MockCzarJobEscrow} from "./mocks/MockCzarJobEscrow.sol";
import {MockVaultFactory} from "./mocks/MockVaultFactory.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";
import {PayeeTree} from "./helpers/PayeeTree.sol";

/// @dev The escrow event both instances emit on a reject (ERC-8183), declared here for expectEmit.
interface IEscrowRejectEvent {
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
}

/// @notice T-018, 07 PRD 09. Every test in JobTestBase runs against both escrow kinds: JobCircleTest (kind 0,
///         Circle's testnet instance) and JobCzarTest (kind 1, CzarJobEscrow). czar-vault.md §5.5, §8.4, §15;
///         job-escrow-adapter.md; INV-2, INV-12, INV-16, JOB-1 … JOB-5; security-and-testing.md §3.7, §3.7a.
abstract contract JobTestBase is VaultTestBase, PayeeTree {
    uint256 internal constant CAP = 4 * ONE_USDC;
    uint64 internal constant LIFETIME = 1 days;
    uint64 internal constant JOB_LIFETIME = 1 hours;
    uint256 internal constant BUDGET = 300_000;
    bytes32 internal constant DESCRIPTION_HASH = 0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff;
    string internal constant DESCRIPTION = "czar:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    bytes32 internal constant DELIVERABLE = keccak256("deliverable");
    bytes32 internal constant REPORT = keccak256("report");
    uint8 internal constant ESCROW_SUBMITTED = 2;
    uint8 internal constant ESCROW_REJECTED = 4;
    address internal constant PROVIDER_ALT = address(0xd00e); // a second job leaf on STEP_JOB (two-leaf trees)

    uint64 internal env;

    function setUp() public virtual override {
        super.setUp();
        _fundVault(10 * ONE_USDC);
        env = _openEnvelope(CAP, ONE_USDC, PAYEE_ROOT);
    }

    // ───────────── Kind hooks ─────────────

    function _escrow() internal view virtual returns (address);
    function _setBudget(uint256 jobId, uint256 amount) internal virtual;
    function _escrowDescription(uint256 jobId) internal view virtual returns (string memory);
    function _escrowStatus(uint256 jobId) internal view virtual returns (uint8);

    // ───────────── Helpers ─────────────

    function _openEnvelope(uint256 cap, uint256 maxStep, bytes32 root) internal returns (uint64 id) {
        ICzarVault.OpenEnvelopeParams memory p;
        p.cap = cap;
        p.maxStepAmount = maxStep;
        p.expiresAt = uint64(block.timestamp + LIFETIME);
        p.categoryId = keccak256("category");
        p.payeeRoot = root;
        vm.prank(owner);
        id = vault.openEnvelope(p);
    }

    /// @dev A two-leaf payeeRoot (czar-merkle-v1: the root is the sorted-pair hash; each proof is the other leaf).
    function _twoLeafRoot(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return Hashes.commutativeKeccak256(a, b);
    }

    function _one(bytes32 x) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = x;
    }

    function _open() internal returns (bytes32 jobKey) {
        bytes32[] memory proof = _proofD00d();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.prank(agent);
        jobKey = vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
    }

    function _openAndFund(uint256 budget) internal returns (bytes32 jobKey) {
        jobKey = _open();
        _setBudget(vault.getJob(jobKey).jobId, budget);
        vm.prank(agent);
        vault.fundJob(jobKey, budget);
    }

    function _escrowCall() internal view returns (ICircleTestnetAgenticCommerce) {
        return ICircleTestnetAgenticCommerce(_escrow()); // submit / complete / reject / claimRefund share selectors
    }

    function _submit(uint256 jobId) internal {
        vm.prank(PROVIDER_D00D);
        _escrowCall().submit(jobId, DELIVERABLE, "");
    }

    function _evaluatorReject(uint256 jobId) internal {
        vm.prank(evaluatorKey);
        _escrowCall().reject(jobId, REPORT, "");
    }

    function _evaluatorComplete(uint256 jobId) internal {
        vm.prank(evaluatorKey);
        _escrowCall().complete(jobId, REPORT, "");
    }

    function _assertInv2() internal view {
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        if (e.state == ICzarVault.EnvelopeState.Open) {
            assertEq(vault.committedTotal(), e.cap - e.spent - e.pocketOutstanding - e.jobEscrowed - e.shortfall);
        }
        assertLe(vault.committedTotal(), usdc.balanceOf(address(vault)));
    }

    /// @dev The Released transition left nothing behind: reserved, stepUsed and openJobs are back to 0.
    function _assertReleased(bytes32 jobKey) internal view {
        assertEq(uint8(vault.getJob(jobKey).state), uint8(ICzarVault.JobState.Released));
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.reserved, 0);
        assertEq(e.openJobs, 0);
        assertEq(vault.stepUsed(env, STEP_JOB), 0);
    }

    // ───────────── openJob ─────────────

    function test_openJob_createsEscrowJobAndReserves() public {
        bytes32[] memory proof = _proofD00d();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        bytes32 expectedKey = keccak256(abi.encode(_escrow(), uint256(1)));
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobOpened(
            expectedKey, env, PROVIDER_D00D, STEP_JOB, _escrow(), 1, evaluatorKey, STEP_JOB_CAP, DESCRIPTION_HASH
        );
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.StepUsed(env, STEP_JOB, STEP_JOB_CAP);
        vm.prank(agent);
        bytes32 jobKey = vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
        assertEq(jobKey, expectedKey);
        ICzarVault.Job memory j = vault.getJob(jobKey);
        assertEq(j.provider, PROVIDER_D00D);
        assertEq(j.envelopeId, env);
        assertEq(j.stepIndex, STEP_JOB);
        assertEq(uint8(j.state), uint8(ICzarVault.JobState.Opened));
        assertEq(j.expiredAt, expiredAt);
        assertEq(j.jobId, 1);
        assertEq(j.reservedCap, STEP_JOB_CAP);
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.reserved, STEP_JOB_CAP);
        assertEq(e.openJobs, 1);
        assertEq(vault.stepUsed(env, STEP_JOB), STEP_JOB_CAP);
        assertEq(_escrowDescription(1), DESCRIPTION); // JOB-3: 69 ASCII characters, no "0x"
        assertEq(bytes(_escrowDescription(1)).length, 69);
        _assertInv2();
    }

    function test_openJob_notAgent_reverts() public {
        bytes32[] memory proof = _proofD00d();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.prank(owner);
        vm.expectRevert(ICzarVault.NotAgent.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
    }

    function test_openJob_frozenOrPaused_reverts() public {
        bytes32[] memory proof = _proofD00d();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.prank(owner);
        vault.freeze();
        vm.prank(agent);
        vm.expectRevert(ICzarVault.FrozenVault.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
        vm.prank(owner);
        vault.unfreeze();
        vaultFactory.setGuardianPaused(true);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.Paused.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
    }

    function test_openJob_envelopeState_revert() public {
        bytes32[] memory proof = _proofD00d();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.EnvelopeNotOpen.selector);
        vault.openJob(env + 1, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
        vm.warp(block.timestamp + LIFETIME);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.EnvelopeExpired.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
    }

    function test_openJob_badParams_revert() public {
        bytes32[] memory proof = _proofD00d();
        uint64 ok = uint64(block.timestamp + JOB_LIFETIME);
        uint64 tooSoon = uint64(block.timestamp + MIN_JOB_EXPIRY_LEAD - 1);
        uint64 afterEnvelope = vault.getEnvelope(env).expiresAt + 1;
        uint32 pocketStep = vault.POCKET_STEP_INDEX();
        vm.startPrank(agent);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.openJob(env, pocketStep, PROVIDER_D00D, STEP_JOB_CAP, proof, ok, DESCRIPTION_HASH);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, ONE_USDC + 1, proof, ok, DESCRIPTION_HASH);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, tooSoon, DESCRIPTION_HASH);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, afterEnvelope, DESCRIPTION_HASH);
        vm.stopPrank();
    }

    function test_openJob_minimumLead_accepted() public {
        bytes32[] memory proof = _proofD00d();
        uint64 edge = uint64(block.timestamp + MIN_JOB_EXPIRY_LEAD);
        vm.prank(agent);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, edge, DESCRIPTION_HASH);
    }

    /// @dev JOB-2: the vault always names its own evaluator, which may never be the provider.
    function test_openJob_providerIsEvaluator_reverts() public {
        vm.prank(owner);
        vault.rotateSigners(agent, autonomy, PROVIDER_D00D);
        bytes32[] memory proof = _proofD00d();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
    }

    /// @dev JOB-2: the provider must be a kind-2 leaf of payeeRoot with the exact step and cap.
    function test_openJob_notInPlan_reverts() public {
        bytes32[] memory proof = _proofD00d();
        bytes32[] memory payeeProof = _proofBeef();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.startPrank(agent);
        vm.expectRevert(ICzarVault.PayeeNotInPlan.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP - 1, proof, expiredAt, DESCRIPTION_HASH);
        vm.expectRevert(ICzarVault.PayeeNotInPlan.selector);
        vault.openJob(env, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, payeeProof, expiredAt, DESCRIPTION_HASH);
        vm.stopPrank();
    }

    /// @dev RV-002 named test: a job needs the whole step cap free, so a reservation on the step blocks it.
    function test_openJob_afterReserveOnSameStep_reverts() public {
        bytes32 x402Leaf = PayeeLeaf.hash(PAYEE_BEEF, PAYEE_KIND_X402, STEP_JOB, STEP_JOB_CAP);
        bytes32 jobLeaf = PayeeLeaf.hash(PROVIDER_D00D, PAYEE_KIND_JOB, STEP_JOB, STEP_JOB_CAP);
        env = _openEnvelope(CAP, ONE_USDC, _twoLeafRoot(x402Leaf, jobLeaf));
        vm.prank(agent);
        vault.reserve(env, STEP_JOB, PAYEE_BEEF, STEP_JOB_CAP, _one(jobLeaf), 10_000, 1, uint64(block.timestamp + 60));
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        bytes32[] memory proof = _one(x402Leaf);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(ICzarVault.StepCapExceeded.selector, STEP_JOB, 10_000, STEP_JOB_CAP, STEP_JOB_CAP)
        );
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
    }

    /// @dev RV-009 named test (D88, G-19): two openJob calls on one step can never both succeed.
    function test_closeEnvelope_afterDuplicateOpenJobRetry() public {
        bytes32 first = _open(); // the agent lost this receipt and retries
        bytes32[] memory proof = _proofD00d();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                ICzarVault.StepCapExceeded.selector, STEP_JOB, STEP_JOB_CAP, STEP_JOB_CAP, STEP_JOB_CAP
            )
        );
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
        vm.warp(vault.getJob(first).expiredAt);
        vault.syncJob(first);
        _assertReleased(first);
        vm.prank(owner);
        vault.closeEnvelope(env);
    }

    function test_openJob_envelopeCap_reverts() public {
        env = _openEnvelope(ONE_USDC, ONE_USDC, PAYEE_ROOT);
        bytes32[] memory payeeProof = _proofBeef();
        vm.prank(agent);
        vault.reserve(env, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, payeeProof, 70_000, 10, uint64(block.timestamp + 60));
        bytes32[] memory proof = _proofD00d();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.CapExceeded.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
    }

    // ───────────── fundJob ─────────────

    function test_fundJob_movesBudgetIntoEscrow() public {
        bytes32 jobKey = _open();
        _setBudget(1, BUDGET);
        uint256 committedBefore = vault.committedTotal();
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobFunded(jobKey, BUDGET);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.StepUsed(env, STEP_JOB, BUDGET); // the unused 100,000 of the step cap is free again
        vm.prank(agent);
        vault.fundJob(jobKey, BUDGET);
        ICzarVault.Job memory j = vault.getJob(jobKey);
        assertEq(uint8(j.state), uint8(ICzarVault.JobState.Funded));
        assertEq(j.budget, BUDGET);
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.reserved, 0);
        assertEq(e.jobEscrowed, BUDGET);
        assertEq(vault.committedTotal(), committedBefore - BUDGET);
        assertEq(vault.stepUsed(env, STEP_JOB), BUDGET);
        assertEq(usdc.balanceOf(_escrow()), BUDGET);
        assertEq(usdc.allowance(address(vault), _escrow()), 0); // approval reset
        _assertInv2();
    }

    function test_fundJob_fullStepCap_emitsNoStepUsed() public {
        bytes32 jobKey = _open();
        _setBudget(1, STEP_JOB_CAP);
        vm.recordLogs();
        vm.prank(agent);
        vault.fundJob(jobKey, STEP_JOB_CAP);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(vault)) assertTrue(logs[i].topics[0] != ICzarVault.StepUsed.selector);
        }
    }

    function test_fundJob_notAgent_reverts() public {
        bytes32 jobKey = _open();
        _setBudget(1, BUDGET);
        vm.prank(owner);
        vm.expectRevert(ICzarVault.NotAgent.selector);
        vault.fundJob(jobKey, BUDGET);
    }

    /// @dev RV-006 named test.
    function test_fundJob_whileFrozenOrPaused_reverts() public {
        bytes32 jobKey = _open();
        _setBudget(1, BUDGET);
        vm.prank(agent);
        vault.freeze();
        vm.prank(agent);
        vm.expectRevert(ICzarVault.FrozenVault.selector);
        vault.fundJob(jobKey, BUDGET);
        vm.prank(owner);
        vault.unfreeze();
        vaultFactory.setGuardianPaused(true);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.Paused.selector);
        vault.fundJob(jobKey, BUDGET);
    }

    function test_fundJob_wrongState_reverts() public {
        vm.prank(agent);
        vm.expectRevert(ICzarVault.JobWrongState.selector);
        vault.fundJob(keccak256("unknown"), BUDGET);
        bytes32 jobKey = _openAndFund(BUDGET);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.JobWrongState.selector);
        vault.fundJob(jobKey, BUDGET);
    }

    /// @dev RV-005 / RV-006: no funding once the envelope is expired.
    function test_fundJob_envelopeExpired_reverts() public {
        bytes32 jobKey = _open();
        _setBudget(1, BUDGET);
        vm.warp(vault.getEnvelope(env).expiresAt);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.EnvelopeExpired.selector);
        vault.fundJob(jobKey, BUDGET);
    }

    /// @dev RV-005 named test: after a force-close, fundJob reverts and syncJob releases without accounting.
    function test_forceClose_openedJob_fundJobReverts() public {
        bytes32 jobKey = _open();
        _setBudget(1, BUDGET);
        vm.warp(vault.getEnvelope(env).expiresAt + FORCE_CLOSE_DELAY);
        vm.prank(owner);
        vault.forceCloseEnvelope(env);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.EnvelopeNotOpen.selector);
        vault.fundJob(jobKey, BUDGET);
        uint256 committed = vault.committedTotal();
        vm.recordLogs();
        vault.syncJob(jobKey);
        assertEq(vm.getRecordedLogs().length, 1); // JobSynced only: no StepUsed for a closed envelope
        assertEq(uint8(vault.getJob(jobKey).state), uint8(ICzarVault.JobState.Released));
        assertEq(vault.committedTotal(), committed);
    }

    /// @dev H1 named test: a provider's zero-budget submit leaves nothing to fund.
    function test_fundJob_afterEarlySubmit_revertsJobNotOpen() public {
        bytes32 jobKey = _open();
        _submit(1);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.JobNotOpen.selector);
        vault.fundJob(jobKey, 0);
    }

    function test_fundJob_atOrAfterJobExpiry_revertsJobNotOpen() public {
        bytes32 jobKey = _open();
        _setBudget(1, BUDGET);
        vm.warp(vault.getJob(jobKey).expiredAt);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.JobNotOpen.selector);
        vault.fundJob(jobKey, BUDGET);
    }

    /// @dev M1-b named test: the provider changed the budget after the agent read it.
    function test_fundJob_budgetChanged_reverts() public {
        bytes32 jobKey = _open();
        _setBudget(1, BUDGET + 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.BudgetChanged.selector, BUDGET, BUDGET + 1));
        vault.fundJob(jobKey, BUDGET);
    }

    /// @dev R2 named test: both instances accept a budget of 0 at fund, so the vault refuses it.
    function test_fundJob_zeroBudget_reverts() public {
        bytes32 jobKey = _open();
        vm.prank(agent);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.fundJob(jobKey, 0); // never set
        _setBudget(1, 0);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.fundJob(jobKey, 0);
    }

    /// @dev JOB-1.
    function test_fundJob_budgetAboveReservedCap_reverts() public {
        bytes32 jobKey = _open();
        _setBudget(1, STEP_JOB_CAP + 1);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.BudgetExceedsReserved.selector);
        vault.fundJob(jobKey, STEP_JOB_CAP + 1);
    }

    // ───────────── cancelJob ─────────────

    /// @dev H2 named test: the client reject releases the step, and the alternate payee can then open on it.
    function test_cancelJob_open_releasesAndAlternateOpens() public {
        bytes32 leafA = PayeeLeaf.hash(PROVIDER_D00D, PAYEE_KIND_JOB, STEP_JOB, STEP_JOB_CAP);
        bytes32 leafB = PayeeLeaf.hash(PROVIDER_ALT, PAYEE_KIND_JOB, STEP_JOB, STEP_JOB_CAP);
        env = _openEnvelope(CAP, ONE_USDC, _twoLeafRoot(leafA, leafB));
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        bytes32[] memory proofA = _one(leafB);
        vm.prank(agent);
        bytes32 jobKey = vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proofA, expiredAt, DESCRIPTION_HASH);
        vm.expectEmit(true, true, true, true, _escrow());
        emit IEscrowRejectEvent.JobRejected(1, address(vault), CANCEL_REASON);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobCancelled(jobKey);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.StepUsed(env, STEP_JOB, 0);
        vm.prank(agent);
        vault.cancelJob(jobKey);
        assertEq(_escrowStatus(1), ESCROW_REJECTED);
        _assertReleased(jobKey);
        bytes32[] memory proofB = _one(leafA);
        vm.prank(agent);
        vault.openJob(env, STEP_JOB, PROVIDER_ALT, STEP_JOB_CAP, proofB, expiredAt, DESCRIPTION_HASH);
        assertEq(vault.stepUsed(env, STEP_JOB), STEP_JOB_CAP);
    }

    function test_cancelJob_owner_releasesAndEnvelopeCloses() public {
        bytes32 jobKey = _open();
        vm.prank(owner);
        vault.cancelJob(jobKey);
        _assertReleased(jobKey);
        vm.prank(owner);
        vault.closeEnvelope(env);
    }

    /// @dev H2 named test: cancelJob only releases exposure, so freeze and pause do not block it.
    function test_cancelJob_frozen_allowed() public {
        bytes32 a = _open();
        vm.prank(owner);
        vault.freeze();
        vm.prank(agent);
        vault.cancelJob(a);
        _assertReleased(a);
        bytes32[] memory proof = _proofD00d();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.prank(owner);
        vault.unfreeze();
        vm.prank(agent);
        bytes32 b = vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
        vaultFactory.setGuardianPaused(true);
        vm.prank(owner);
        vault.cancelJob(b);
        _assertReleased(b);
    }

    function test_cancelJob_stranger_reverts() public {
        bytes32 jobKey = _open();
        vm.prank(stranger);
        vm.expectRevert(ICzarVault.NotAuthorized.selector);
        vault.cancelJob(jobKey);
    }

    /// @dev H2 named test.
    function test_cancelJob_funded_reverts() public {
        bytes32 jobKey = _openAndFund(BUDGET);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.JobWrongState.selector);
        vault.cancelJob(jobKey);
    }

    /// @dev N7 named test: a zero-budget submit landed first; cancel refuses and syncJob releases.
    function test_cancelJob_frontRunBySubmit_fallsBackToSync() public {
        bytes32 jobKey = _open();
        _submit(1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.JobNotCancellable.selector, ESCROW_SUBMITTED));
        vault.cancelJob(jobKey);
        vault.syncJob(jobKey);
        _assertReleased(jobKey);
    }

    // ───────────── syncJob from Opened (RV-009, H1) ─────────────

    /// @dev RV-009 named test: an Open escrow job is released once its expiredAt passes.
    function test_syncJob_openedAfterExpiry_released() public {
        bytes32 jobKey = _open();
        vm.expectRevert(ICzarVault.NoChange.selector);
        vault.syncJob(jobKey);
        vm.warp(vault.getJob(jobKey).expiredAt);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobSynced(jobKey, uint8(ICzarVault.JobState.Released), false);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.StepUsed(env, STEP_JOB, 0);
        vm.prank(stranger); // anyone
        vault.syncJob(jobKey);
        _assertReleased(jobKey);
        _assertInv2();
        vm.prank(owner);
        vault.closeEnvelope(env);
    }

    /// @dev H1 named test.
    function test_syncJob_zeroBudgetSubmit_releases() public {
        bytes32 jobKey = _open();
        _submit(1);
        vault.syncJob(jobKey);
        _assertReleased(jobKey);
        vm.prank(owner);
        vault.closeEnvelope(env);
    }

    /// @dev H1 named test: the evaluator completed a zero-budget submission; no money ever moved.
    function test_syncJob_unfundedCompleted_releases() public {
        bytes32 jobKey = _open();
        _submit(1);
        _evaluatorComplete(1);
        uint256 balance = usdc.balanceOf(address(vault));
        vault.syncJob(jobKey);
        _assertReleased(jobKey);
        assertEq(usdc.balanceOf(address(vault)), balance);
        assertEq(vault.getEnvelope(env).spent, 0);
    }

    // ───────────── syncJob from Funded / Submitted ─────────────

    function test_syncJob_submittedThenCompleted_booksSpent() public {
        bytes32 jobKey = _openAndFund(BUDGET);
        vm.expectRevert(ICzarVault.NoChange.selector);
        vault.syncJob(jobKey); // escrow still Funded
        _submit(1);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobSynced(jobKey, uint8(ICzarVault.JobState.Submitted), false);
        vault.syncJob(jobKey);
        vm.expectRevert(ICzarVault.NoChange.selector);
        vault.syncJob(jobKey);
        _evaluatorComplete(1);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobSynced(jobKey, uint8(ICzarVault.JobState.Completed), false);
        vault.syncJob(jobKey);
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.jobEscrowed, 0);
        assertEq(e.spent, BUDGET);
        assertEq(e.openJobs, 0);
        assertEq(usdc.balanceOf(PROVIDER_D00D), BUDGET);
        _assertInv2();
        vm.expectRevert(ICzarVault.JobWrongState.selector);
        vault.syncJob(jobKey);
    }

    function test_syncJob_rejected_refundCreditsEnvelope() public {
        bytes32 jobKey = _openAndFund(BUDGET);
        uint256 committedBefore = vault.committedTotal();
        _submit(1);
        _evaluatorReject(1); // D77: a deliverable mismatch is a reject; the escrow refunds in the same transaction
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobSynced(jobKey, uint8(ICzarVault.JobState.Refunded), true);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.StepUsed(env, STEP_JOB, 0);
        vault.syncJob(jobKey);
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.jobEscrowed, 0);
        assertEq(e.spent, 0);
        assertEq(e.openJobs, 0);
        assertEq(vault.committedTotal(), committedBefore + BUDGET);
        assertEq(uint8(vault.getJob(jobKey).state), uint8(ICzarVault.JobState.Refunded));
        _assertInv2();
    }

    /// @dev RV-011: the refund reached the vault but the owner withdrew it as free balance before the sync.
    function test_syncJob_refundAfterWithdraw_recordsShortfall() public {
        bytes32 jobKey = _openAndFund(BUDGET);
        _evaluatorReject(1);
        uint256 free = vault.freeBalance();
        vm.prank(owner);
        vault.withdraw(owner, free);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.ShortfallRecorded(env, BUDGET, BUDGET);
        vault.syncJob(jobKey);
        assertEq(vault.envelopeShortfall(env), BUDGET);
        _assertInv2();
    }

    /// @dev RV-005: a refund after force-close is free balance (creditedToEnvelope = false).
    function test_syncJob_refundAfterForceClose_isFreeBalance() public {
        bytes32 jobKey = _openAndFund(BUDGET);
        vm.warp(vault.getEnvelope(env).expiresAt + FORCE_CLOSE_DELAY);
        vm.prank(owner);
        vault.forceCloseEnvelope(env);
        assertEq(vault.getEnvelope(env).jobEscrowed, BUDGET); // still tracked for the job (JOB-4)
        uint256 freeBefore = vault.freeBalance();
        _evaluatorReject(1); // the refund lands in the vault as free balance; the sync only closes the record
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobSynced(jobKey, uint8(ICzarVault.JobState.Refunded), false);
        vault.syncJob(jobKey);
        assertEq(vault.freeBalance(), freeBefore + BUDGET);
        assertEq(vault.committedTotal(), 0);
        assertEq(vault.getEnvelope(env).jobEscrowed, 0);
    }

    function test_syncJob_unknownJob_reverts() public {
        vm.expectRevert(ICzarVault.JobWrongState.selector);
        vault.syncJob(keccak256("unknown"));
    }

    // ───────────── claimJobRefund ─────────────

    function test_claimJobRefund_afterExpiry_refunds() public {
        bytes32 jobKey = _openAndFund(BUDGET);
        uint64 expiredAt = vault.getJob(jobKey).expiredAt;
        vm.warp(expiredAt - 1);
        vm.expectRevert(ICzarVault.NotExpired.selector);
        vault.claimJobRefund(jobKey);
        vm.warp(expiredAt);
        uint256 committedBefore = vault.committedTotal();
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobRefunded(jobKey, BUDGET, true);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.StepUsed(env, STEP_JOB, 0);
        vm.prank(stranger); // anyone
        vault.claimJobRefund(jobKey);
        assertEq(vault.committedTotal(), committedBefore + BUDGET);
        assertEq(uint8(vault.getJob(jobKey).state), uint8(ICzarVault.JobState.Refunded));
        _assertInv2();
    }

    function test_claimJobRefund_wrongState_reverts() public {
        bytes32 jobKey = _open();
        vm.expectRevert(ICzarVault.JobWrongState.selector);
        vault.claimJobRefund(jobKey);
    }

    // ───────────── Fuzz: JOB-4 and INV-2 across fund and refund ─────────────

    function testFuzz_fundThenReject_restoresAccounting(uint256 budget) public {
        budget = bound(budget, 1, STEP_JOB_CAP);
        uint256 committed0 = vault.committedTotal();
        bytes32 jobKey = _openAndFund(budget);
        assertEq(vault.getEnvelope(env).jobEscrowed, budget); // JOB-4
        assertEq(vault.stepUsed(env, STEP_JOB), budget);
        _assertInv2();
        _evaluatorReject(1);
        vault.syncJob(jobKey);
        assertEq(vault.committedTotal(), committed0);
        assertEq(vault.stepUsed(env, STEP_JOB), 0);
        assertEq(vault.getEnvelope(env).jobEscrowed, 0);
        _assertInv2();
    }
}

/// @notice T-018, 07 PRD 09: kind 0, Circle's Arc testnet instance (VaultTestBase deploys MockCircleAgenticCommerce).
contract JobCircleTest is JobTestBase {
    function _escrow() internal view override returns (address) {
        return address(jobEscrow);
    }

    function _setBudget(uint256 jobId, uint256 amount) internal override {
        vm.prank(PROVIDER_D00D);
        jobEscrow.setBudget(jobId, amount, "");
    }

    function _escrowDescription(uint256 jobId) internal view override returns (string memory d) {
        (,,,, d,,,,) = jobEscrow.jobs(jobId);
    }

    function _escrowStatus(uint256 jobId) internal view override returns (uint8) {
        return uint8(jobEscrow.getJob(jobId).status);
    }

    /// @dev A4-07: Circle's instance must charge no fees at all.
    function test_fundJob_circleFees_revertUnexpectedFees() public {
        bytes32 jobKey = _open();
        _setBudget(1, BUDGET);
        jobEscrow.setEvaluatorFee(1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.UnexpectedFees.selector, 0, 1));
        vault.fundJob(jobKey, BUDGET);
    }

    /// @dev Circle's instance has no evaluation grace: a Submitted job refunds at expiredAt.
    function test_claimJobRefund_circleSubmitted_noGrace() public {
        bytes32 jobKey = _openAndFund(BUDGET);
        _submit(1);
        vault.syncJob(jobKey);
        vm.warp(vault.getJob(jobKey).expiredAt);
        vault.claimJobRefund(jobKey);
        assertEq(uint8(vault.getJob(jobKey).state), uint8(ICzarVault.JobState.Refunded));
    }
}

/// @notice T-018, 07 PRD 09: kind 1, CzarJobEscrow (erc-8183/base-contracts), with USDC on its token allowlist.
contract JobCzarTest is JobTestBase {
    MockCzarJobEscrow internal czarEscrow;

    function setUp() public override {
        VaultTestBase.setUp();
        czarEscrow = new MockCzarJobEscrow(treasury, address(this));
        czarEscrow.setPaymentTokenAllowed(USDC_ADDRESS, true);
        ICzarVaultFactory.NetworkConfig memory cfg = _networkConfig();
        cfg.jobEscrow = address(czarEscrow);
        cfg.jobEscrowKind = 1;
        vaultFactory = new MockVaultFactory(cfg, _defaults());
        vault = vaultFactory.deploy(owner);
        _fundVault(10 * ONE_USDC);
        env = _openEnvelope(CAP, ONE_USDC, PAYEE_ROOT);
    }

    function _escrow() internal view override returns (address) {
        return address(czarEscrow);
    }

    function _setBudget(uint256 jobId, uint256 amount) internal override {
        vm.prank(PROVIDER_D00D);
        czarEscrow.setBudget(jobId, USDC_ADDRESS, amount, "");
    }

    function _escrowDescription(uint256 jobId) internal view override returns (string memory) {
        return czarEscrow.getJob(jobId).description;
    }

    function _escrowStatus(uint256 jobId) internal view override returns (uint8) {
        return uint8(czarEscrow.getJob(jobId).status);
    }

    /// @dev The Czar instance allows fees up to MAX_JOB_FEE_BPS (500) in total.
    function test_fundJob_czarFees_boundedByMaxJobFeeBps() public {
        bytes32 jobKey = _open();
        _setBudget(1, BUDGET);
        czarEscrow.setPlatformFee(300, treasury);
        czarEscrow.setEvaluatorFee(201);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.UnexpectedFees.selector, 300, 201));
        vault.fundJob(jobKey, BUDGET);
        czarEscrow.setEvaluatorFee(200);
        vm.prank(agent);
        vault.fundJob(jobKey, BUDGET);
    }

    function test_fundJob_czarOtherToken_revertsWrongToken() public {
        address other = makeAddr("otherToken");
        czarEscrow.setPaymentTokenAllowed(other, true);
        bytes32 jobKey = _open();
        vm.prank(PROVIDER_D00D);
        czarEscrow.setBudget(1, other, BUDGET, "");
        vm.prank(agent);
        vm.expectRevert(ICzarVault.WrongToken.selector);
        vault.fundJob(jobKey, BUDGET);
    }

    /// @dev RV-009 named test: on the Czar instance the provider may reject while Open; the job is released.
    function test_syncJob_openedRejected_released() public {
        bytes32 jobKey = _open();
        vm.prank(PROVIDER_D00D);
        czarEscrow.reject(1, REPORT, "");
        vault.syncJob(jobKey);
        _assertReleased(jobKey);
        vm.prank(owner);
        vault.closeEnvelope(env);
    }

    /// @dev RV-009 named test, with the spec's figures: budget 1.0, settled 0.3 through approveClaim, then a reject
    ///      → credit 0.7 and spent 0.3. A one-leaf tree gives the provider a 1.0 USDC step (root = the leaf).
    function test_syncJob_czarPartialClaim_refundsBudgetMinusSettled() public {
        bytes32 leaf = PayeeLeaf.hash(PROVIDER_D00D, PAYEE_KIND_JOB, STEP_JOB, ONE_USDC);
        env = _openEnvelope(CAP, ONE_USDC, leaf);
        bytes32[] memory noProof = new bytes32[](0);
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.prank(agent);
        bytes32 jobKey = vault.openJob(env, STEP_JOB, PROVIDER_D00D, ONE_USDC, noProof, expiredAt, DESCRIPTION_HASH);
        _setBudget(1, ONE_USDC);
        vm.prank(agent);
        vault.fundJob(jobKey, ONE_USDC);
        uint256 committedBefore = vault.committedTotal();
        vm.prank(PROVIDER_D00D);
        czarEscrow.submitClaim(1, 300_000, DELIVERABLE, "");
        vm.prank(evaluatorKey);
        czarEscrow.approveClaim(1, 300_000, DELIVERABLE, "");
        _evaluatorReject(1);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobSynced(jobKey, uint8(ICzarVault.JobState.Refunded), true);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.StepUsed(env, STEP_JOB, 300_000);
        vault.syncJob(jobKey);
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.spent, 300_000);
        assertEq(e.jobEscrowed, 0);
        assertEq(vault.committedTotal(), committedBefore + 700_000);
        assertEq(vault.committedTotal(), CAP + (e.cap - e.spent)); // INV-2 over both open envelopes
    }

    /// @dev §15.7: a Submitted job on the Czar instance refunds only after expiredAt + 1 h; the status is the escrow's.
    function test_claimJobRefund_czarSubmitted_needsGrace() public {
        bytes32 jobKey = _openAndFund(BUDGET);
        _submit(1); // the vault record still says Funded
        uint64 expiredAt = vault.getJob(jobKey).expiredAt;
        vm.warp(expiredAt + CZAR_ESCROW_EVALUATION_GRACE - 1);
        vm.expectRevert(ICzarVault.NotExpired.selector);
        vault.claimJobRefund(jobKey);
        vm.warp(expiredAt + CZAR_ESCROW_EVALUATION_GRACE);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobRefunded(jobKey, BUDGET, true);
        vault.claimJobRefund(jobKey);
    }

    /// @dev RV-009: anyone may claimRefund an Open job on the Czar instance after expiry (Expired, no transfer).
    function test_syncJob_czarOpenJobExpiredByThirdParty_released() public {
        bytes32 jobKey = _open();
        vm.warp(vault.getJob(jobKey).expiredAt);
        vm.prank(stranger);
        czarEscrow.claimRefund(1);
        vault.syncJob(jobKey);
        _assertReleased(jobKey);
    }
}
```

## 10. Build steps (tests first)
1. Create `test/JobTest.t.sol` (§9).
2. Run `FOUNDRY_PROFILE=arc arc-forge test --match-path test/JobTest.t.sol`. Expected: two suites, `0 passed; 42 failed` and `0 passed; 46 failed`, every failure mentioning `NotBuilt()`. Paste both summary lines into your report.
3. Create `src/libraries/JobEscrowAdapter.sol` (§7), then write `src/vault/logic/JobLogic.sol` from §8.
4. Do §5 (delete the 5 stubs) and §6 (replace `CzarVault.sol`).
5. Run the test file again: 42 passed and 46 passed.
6. `arc-forge fmt src/vault/logic/JobLogic.sol src/libraries/JobEscrowAdapter.sol src/vault/VaultStubs.sol`, then `arc-forge fmt --check` on those files plus `src/CzarVault.sol` and `test/JobTest.t.sol`: nothing printed apart from the flag notice.
7. Run the clean gate build and the full suite (00-conventions §2.2).

## 11. Definition of done
- `FOUNDRY_PROFILE=arc arc-forge test --match-path test/JobTest.t.sol` → `JobCircleTest` 42 passed and `JobCzarTest` 46 passed, 0 failed (T-018 acceptance: both mock ABIs; the front-run `setBudget` is `test_fundJob_budgetChanged_reverts`; the refund after the envelope closed is `test_syncJob_refundAfterForceClose_isFreeBalance`).
- `FOUNDRY_PROFILE=arc arc-forge test` → 373 passed, 0 failed.
- `rm -rf out cache && FOUNDRY_PROFILE=arc arc-forge build --deny-warnings --sizes` → no warnings; `CzarVault` runtime about 13,808 B and `JobLogic` about 11,867 B (more than 300 B off means your code differs from §6–§8).
- `grep -c "revert NotBuilt" src/vault/VaultStubs.sol` → 3.
- `diff -r src/interfaces ../docs/specs/03-smart-contracts/interfaces` → nothing.

## 12. Stop conditions
- A test fails after you have compared the function with its numbered steps in §8: stop and report the suite, the test name and the failure line. Never change a test or a mock.
- An escrow mock behaves differently from `job-escrow-adapter.md` §2: stop and file an SCR (00-conventions §1.4).

## Change log
| Date | Change |
|---|---|
| 2026-10-20 | First version (D89 library layout), verified on Arc Foundry v0.8.0-2 against a reference implementation, both escrow kinds. |
| 2026-10-20 | Pilot build by a smaller model (all 373 tests, exact sizes): acceptance uses `--match-path`; `e` declared at first use; `revert` written out; kind names; three custom trees named; diff note for §7. |
| 2026-10-20 | Sources: PRD 01 and PRD 03 §7 (review). |
