# 08 — Pockets and the `GATEWAY_BURN` signature

## 1. Scope
- **Task:** T-017 (pocket wallets on Circle Gateway: `registerPocket`, `grantPocketGas`, `fundPocket`, `requestPullback`, `confirmPullback`, `cancelPullback`, `writeOffPocket`, `recordManualReturn`, and the `GATEWAY_BURN` branch of `isValidSignature`).
- **You build:**
  - `contracts/src/vault/logic/PocketLogic.sol`: a linked library with 8 external functions (§7).
  - In `contracts/src/vault/logic/SignatureLogic.sol`: the real `_checkGatewayBurn` in place of PRD 07's placeholder, and one more import (§8).
  - `contracts/src/CzarVault.sol`: replaced with the version in §6 (adds 8 wrappers).
  - `contracts/test/PocketTest.t.sol` (§9).
  - You delete 8 stubs from `VaultStubs.sol`.
- **Dependencies:**
  - PRD 07 done (242 tests, `SignatureTest` 38 passed, 16 stubs).
  - Gate check **G0-09** recorded in `docs/specs/05-build-plan/gate-0-results/` (`gate-0-checks.md` §G0-09; read-only, no approval needed). It confirms that the testnet GatewayMinter has `isTransferSpecHashUsed(bytes32)`, the view `confirmPullback` and `cancelPullback` read. If G0-09 is not recorded, run it first. If it fails, stop and file the SCR that G0-09 names; do not build §7.5–§7.6.

## 2. This PRD is already verified
- A reference `PocketLogic` written from §7, with `_checkGatewayBurn` from §8, passed on **Arc Foundry v0.8.0-2** with `FOUNDRY_PROFILE=arc`: clean `--deny-warnings` build (compiler and lint), `fmt --check` clean, 285 tests passed (242 earlier plus 43 here).
- Mutation checks were run: without the `PullbackTooLarge` check two tests fail; without the "pocket Draining, or Closed for a recovery record" check of §8 step 6 the force-close test fails.
- Sizes after this PRD: `CzarVault` runtime 12,989 B, initcode 14,682 B; `CzarVaultFactory` runtime 19,196 B; `PocketLogic` runtime 9,353 B; `SignatureLogic` 6,300 B.

## 3. Sources (read these, nothing else)
- `07-contract-build/00-conventions.md` (§2.4 lint, §3.2 library rules, §4.8 arithmetic, §5 tests).
- `docs/specs/03-smart-contracts/czar-vault.md`: §5.4 (the eight functions, recovery pullbacks, `confirmPullback` branches), §6.2 (`GATEWAY_BURN`, the `TransferSpec` table), §8.3 (pocket and pullback state machines), §11 INV-2, INV-3, INV-6, INV-7, INV-14, INV-15, §15.1–§15.5, §15.7 (`requestPullback` and `cancelPullback` block bounds), §15.11 (repeat `fundPocket`, the re-entering pocket).
- `docs/specs/02-data-and-protocol/data-and-protocol.md` §6.3.2 (`GATEWAY_BURN` encoding), §7 (`pullbackSalt`, `transferSpecReplayHash`).
- `docs/specs/03-smart-contracts/interfaces/ICzarVault.sol` (`Pocket`, `Pullback`, their states, events, errors).
- `docs/specs/03-smart-contracts/security-and-testing.md` §3.7 rows RV-003, RV-004, RV-005, RV-006, RV-010, RV-011, RV-036, RV-037, RV-049.

## 4. Files
| File | Action | Section |
|---|---|---|
| `contracts/test/PocketTest.t.sol` | create | §9 |
| `contracts/src/vault/logic/PocketLogic.sol` | create | §7 |
| `contracts/src/vault/logic/SignatureLogic.sol` | edit (import and one function) | §8 |
| `contracts/src/vault/VaultStubs.sol` | delete 8 stubs | §5 |
| `contracts/src/CzarVault.sol` | replace | §6 |

## 5. Delete the stubs
- In `VaultStubs.sol`, delete the whole stub of `cancelPullback`, `confirmPullback`, `fundPocket`, `grantPocketGas`, `recordManualReturn`, `registerPocket`, `requestPullback` and `writeOffPocket`. Afterwards `grep -c "revert NotBuilt" src/vault/VaultStubs.sol` prints `8`.

## 6. `src/CzarVault.sol` (replace the whole file)
- Adds eight wrappers. Guarded (`nonReentrant`, §15.5): `grantPocketGas`, `fundPocket`, `confirmPullback`, `cancelPullback`, `recordManualReturn`. Not guarded: `registerPocket`, `requestPullback`, `writeOffPocket` (no external call other than the factory's `guardianPaused()` view).
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
}
```

## 7. `src/vault/logic/PocketLogic.sol`

### 7.1 Header and interfaces
- `// SPDX-License-Identifier: MIT`, `pragma solidity 0.8.30;`
- Imports, exactly:
  - `{IERC20}` from `@openzeppelin/contracts/token/ERC20/IERC20.sol`
  - `{SafeERC20}` from `@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol`
  - `{SafeCast}` from `@openzeppelin/contracts/utils/math/SafeCast.sol`
  - `{ICzarVault}` from `../../interfaces/ICzarVault.sol`
  - `{VaultState, VaultConfig}` from `../VaultState.sol`
  - `{VaultGuards}` from `../VaultGuards.sol`
  - `{PayeeLeaf}` from `../../libraries/PayeeLeaf.sol`
  - `{CzarNonces}` from `../../libraries/CzarNonces.sol`
  - `{CzarHashing}` from `../../libraries/CzarHashing.sol`
  - `{PAYEE_KIND_POCKET, POCKET_STEP_INDEX, MAX_GAS_GRANT_PER_POCKET, GAS_GRANT_UNIT_WEI, BPS, MAX_PULLBACK_WINDOW_BLOCKS, PULLBACK_CANCEL_DELAY_BLOCKS}` from `../../libraries/CzarConstants.sol`
- Two file-level interfaces, each with a `/// @dev` line citing its source, exactly:
```solidity
/// @dev The two GatewayWallet functions the vault calls (Deposits.sol lines 79–96; Delegation.sol lines 137–144; A2-02, A2-04).
interface IGatewayWalletDeposits {
    function depositFor(address token, address depositor, uint256 value) external;
    function isAuthorizedForBalance(address token, address depositor, address addr) external view returns (bool);
}

/// @dev The GatewayMinter replay-set read (TransferSpecHashes.sol line 35; A2-16).
interface IGatewayMinterReplay {
    function isTransferSpecHashUsed(bytes32 transferSpecHash) external view returns (bool);
}
```
- `/// @title PocketLogic`, a `/// @notice` citing `czar-vault.md` §5.4, §15 and T-017. `library PocketLogic { using SafeERC20 for IERC20; … }`.
- Every function below is `external` and starts `(VaultState storage s, VaultConfig memory c, …)`. `confirmPullback` has no `caller` (anyone).

### 7.2 `registerPocket(s, c, address caller, uint64 envelopeId, address pocket, bytes32[] calldata proof)`
Order fixed by §15.3:
1. `VaultGuards.requireAgent(s, caller);`
2. `VaultGuards.requireNotPausedOrFrozen(s, c);`
3. `ICzarVault.Envelope storage e = s.envelopes[envelopeId];` not `Open` → `ICzarVault.EnvelopeNotOpen()`
4. `block.timestamp >= e.expiresAt` → `ICzarVault.EnvelopeExpired()`
5. `e.pocketCapBps == 0` → `ICzarVault.PocketCapZero()`
6. `pocket == address(0)` → `ICzarVault.ZeroAddress()`
7. `e.pocket != address(0) || s.pockets[pocket].envelopeId != 0` → `ICzarVault.PocketExists()` (one pocket per envelope, D48; one envelope per pocket)
8. `pocket.code.length != 0` → `ICzarVault.NotEoa()`
9. `!PayeeLeaf.verify(proof, e.payeeRoot, pocket, PAYEE_KIND_POCKET, POCKET_STEP_INDEX, 0)` → `ICzarVault.PocketNotInPlan()` (RV-003)
10. `ICzarVault.Pocket storage k = s.pockets[pocket]; k.envelopeId = envelopeId; k.state = ICzarVault.PocketState.Registered;`
11. `e.pocket = pocket; e.openPockets += 1;`
12. `emit ICzarVault.PocketRegistered(envelopeId, pocket);`

### 7.3 `grantPocketGas(s, c, address caller, address pocket, uint256 units)`
- Put these two lines directly above the `function` line (after its `/// @notice` line), exactly:
```solidity
    /// @dev `pocket` cannot be address(0) here: only a Registered pocket passes, and registerPocket refuses zero.
    // forge-lint: disable-next-item(missing-zero-check)
```
  The lint cannot see that the state check rules out a zero pocket; adding a `ZeroAddress` check would be dead code (the zero address is never `Registered`). This is the one `forge-lint` comment 00-conventions §2.4 allows.
1. `VaultGuards.requireAgent(s, caller);` then `VaultGuards.requireNotPausedOrFrozen(s, c);`
2. `ICzarVault.Pocket storage k = s.pockets[pocket];` state not `Registered` → `ICzarVault.PocketWrongState()` (gas only before funding)
3. `ICzarVault.Envelope storage e = s.envelopes[k.envelopeId];` not `Open` → `EnvelopeNotOpen`; `block.timestamp >= e.expiresAt` → `EnvelopeExpired` (RV-006)
4. `units == 0` → `ICzarVault.BadParams()`
5. `k.gasGranted + units > MAX_GAS_GRANT_PER_POCKET` → `ICzarVault.GasGrantExceeded()`
6. `VaultGuards.exposure(e) + units > e.cap` → `ICzarVault.CapExceeded()`
7. Effects: `k.gasGranted += units; e.spent += units; s.committedTotal -= units;` (gas counts as spent, §5.4)
8. `emit ICzarVault.PocketGasGranted(pocket, units);`
9. `(bool ok,) = pocket.call{value: units * GAS_GRANT_UNIT_WEI}("");` `if (!ok) revert ICzarVault.NativeSendFailed();` (one ledger: the native send lowers the vault's USDC balance by `units`; a re-entering pocket hits the vault's guard and the send fails, §15.11)

### 7.4 `fundPocket(s, c, address caller, address pocket, uint256 amount)`
1. `requireAgent`, then `requireNotPausedOrFrozen`.
2. `k.state` neither `Registered` nor `Funded` → `PocketWrongState` (repeat funding is allowed, §15.11)
3. envelope `Open` (`EnvelopeNotOpen`), not expired (`EnvelopeExpired`)
4. `amount == 0` → `BadParams`
5. `uint256 pocketCap = e.cap * e.pocketCapBps / BPS;` `k.funded + amount > pocketCap` → `ICzarVault.PocketCapExceeded(pocketCap, k.funded, amount)` (cumulative)
6. `VaultGuards.exposure(e) + amount > e.cap` → `CapExceeded`
7. `!IGatewayWalletDeposits(c.gatewayWallet).isAuthorizedForBalance(c.usdc, pocket, address(this))` → `ICzarVault.DelegateNotSet()` (the external view read is the last check, §15.3)
8. Effects: `k.funded += amount; k.outstanding += amount; k.state = ICzarVault.PocketState.Funded; e.pocketOutstanding += amount; s.committedTotal -= amount;`
9. `emit ICzarVault.PocketFunded(pocket, k.envelopeId, amount, k.funded);`
10. `IERC20(c.usdc).forceApprove(c.gatewayWallet, amount);` `IGatewayWalletDeposits(c.gatewayWallet).depositFor(c.usdc, pocket, amount);` `IERC20(c.usdc).forceApprove(c.gatewayWallet, 0);` (§15.5)

### 7.5 `requestPullback(s, c, address caller, address pocket, uint256 value, uint256 maxFee, uint256 maxBlockHeight) returns (uint64 pullbackId)`
Not gated by freeze or pause (money only comes back).
1. `VaultGuards.requireOwnerOrAgent(s, c, caller);`
2. `ICzarVault.Pocket storage k = s.pockets[pocket];` `bool recovery = k.state == ICzarVault.PocketState.Closed;` (RV-004)
3. `!recovery && k.state != Funded && k.state != Draining` → `PocketWrongState`
4. `value == 0 || maxBlockHeight <= block.number || maxBlockHeight > block.number + MAX_PULLBACK_WINDOW_BLOCKS` → `BadParams` (§15.7)
5. `!recovery && value > k.outstanding - k.pendingPullback` → `ICzarVault.PullbackTooLarge()`
6. `maxFee > s.maxPullbackFee` → `ICzarVault.FeeTooHigh()` (RV-037: the fee bound at request time)
7. `pullbackId = ++s.pullbackCount;` `ICzarVault.Pullback storage p = s.pullbacks[pullbackId];`
8. Set, in this order: `p.pocket = pocket; p.requestedAtBlock = SafeCast.toUint64(block.number); p.state = ICzarVault.PullbackState.Pending; p.recovery = recovery; p.value = value; p.maxFee = maxFee; p.maxBlockHeight = maxBlockHeight;`
9. `p.salt = CzarNonces.pullbackSalt(address(this), pullbackId);`
10. `p.transferSpecHash = CzarHashing.transferSpecReplayHash(VaultGuards.pullbackTransferSpec(c, p));` (the spec table of §6.2, built from the stored record and the immutables)
11. If `!recovery`: `k.pendingPullback += value; k.state = ICzarVault.PocketState.Draining;`
12. `emit ICzarVault.PullbackRequested(pullbackId, pocket, value, maxFee, maxBlockHeight, p.transferSpecHash, p.salt);`

### 7.6 `confirmPullback(s, c, uint64 pullbackId)` (anyone)
1. `ICzarVault.Pullback storage p = s.pullbacks[pullbackId];` state neither `Pending` nor `Cancelled` → `ICzarVault.PullbackWrongState()`
2. `!IGatewayMinterReplay(c.gatewayMinter).isTransferSpecHashUsed(p.transferSpecHash)` → `ICzarVault.NotMinted()`
3. `bool wasPending = p.state == Pending; p.state = ICzarVault.PullbackState.Confirmed;`
4. `ICzarVault.Pocket storage k = s.pockets[p.pocket]; ICzarVault.Envelope storage e = s.envelopes[k.envelopeId]; bool credited = false;`
5. If `!p.recovery && k.state != Closed && e.state == Open` (the mint goes back to the envelope):
   - `uint256 x;`
   - branch (a), `wasPending`: `k.pendingPullback -= p.value; x = p.value < k.outstanding ? p.value : k.outstanding;`
   - branch (b), late mint of a cancelled record: `uint256 room = k.outstanding - k.pendingPullback; x = p.value < room ? p.value : room;` (keeps INV-7 true, RV-036)
   - `k.outstanding -= x; e.pocketOutstanding -= x;`
   - `VaultGuards.creditEnvelope(s, c, k.envelopeId, e, x);` (bounded by free balance; the rest is shortfall, RV-011)
   - `credited = true;`
6. Else if `wasPending && !p.recovery`: `k.pendingPullback -= p.value;` (branch (c): the mint is free balance)
7. `emit ICzarVault.PullbackConfirmed(pullbackId, p.pocket, p.value, credited);`
- `confirmPullback` never closes a pocket (RV-049).

### 7.7 `cancelPullback(s, c, address caller, uint64 pullbackId)`
1. `requireOwnerOrAgent`
2. `p.state != Pending` → `PullbackWrongState`
3. `block.number < p.maxBlockHeight + PULLBACK_CANCEL_DELAY_BLOCKS` → `ICzarVault.TooEarly()` (RV-036)
4. `IGatewayMinterReplay(c.gatewayMinter).isTransferSpecHashUsed(p.transferSpecHash)` → `ICzarVault.AlreadyMinted()`
5. `p.state = ICzarVault.PullbackState.Cancelled;` if `!p.recovery`: `s.pockets[p.pocket].pendingPullback -= p.value;`
6. `emit ICzarVault.PullbackCancelled(pullbackId);`

### 7.8 `writeOffPocket(s, c, address caller, address pocket)`
1. `requireOwnerOrAgent`
2. `k.state` not `Registered`, `Funded` or `Draining` → `PocketWrongState` (a `Registered` pocket can be closed, RV-049)
3. envelope not `Open` → `EnvelopeNotOpen`
4. `k.pendingPullback != 0` → `ICzarVault.PullbackPending()`
5. `uint256 writtenOff = k.outstanding; e.spent += writtenOff; e.pocketOutstanding -= writtenOff; k.outstanding = 0; k.state = ICzarVault.PocketState.Closed; e.openPockets -= 1;`
6. `emit ICzarVault.PocketClosed(pocket, writtenOff);`

### 7.9 `recordManualReturn(s, c, address caller, address pocket, uint256 amount)` (owner only; D41, RV-010)
1. `VaultGuards.requireOwner(c, caller);`
2. `k.state` neither `Funded` nor `Draining` → `PocketWrongState`
3. envelope not `Open` → `EnvelopeNotOpen`
4. `amount == 0` → `BadParams`
5. `uint256 credit = amount;` `uint256 room = k.outstanding - k.pendingPullback; if (room < credit) credit = room;` `uint256 free = VaultGuards.freeBalance(s, c); if (free < credit) credit = free;`
6. `credit == 0` → `ICzarVault.NoChange()`
7. `k.outstanding -= credit; e.pocketOutstanding -= credit; s.committedTotal += credit;`
8. `emit ICzarVault.ManualReturnRecorded(pocket, credit);`

### 7.10 Order in the file
The two interfaces, then in the library: `registerPocket`, `grantPocketGas`, `fundPocket`, `requestPullback`, `confirmPullback`, `cancelPullback`, `writeOffPocket`, `recordManualReturn`, under the dividers `Register, gas, fund`, `Pullbacks`, `Close and manual return`. Each function: one `/// @notice` line citing its spec section.

## 8. `SignatureLogic.sol`: the real `GATEWAY_BURN` check (§6.2)
1. Add `GATEWAY_DOMAIN_SEPARATOR` to the `CzarConstants.sol` import (after `EIP1271_INVALID`).
2. Replace the whole placeholder `_checkGatewayBurn` (PRD 07 §7.5, including its `/// @dev` line) with `function _checkGatewayBurn(VaultState storage s, VaultConfig memory c, bytes32 digest, bytes calldata sig) private view returns (bool)` and a two-line `/// @dev` citing §6.2 and saying it is not gated by freeze. Any failed line returns `false`:
   1. `sig.length == GATEWAY_BURN_LENGTH`
   2. `_word(sig, 2) == GATEWAY_BURN_SIG_OFFSET` and `_word(sig, 3) == AGENT_SIG_LENGTH`
   3. `_word(sig, 1) <= type(uint64).max` (range check before the decode)
   4. `(, uint64 pullbackId, bytes memory agentSig) = abi.decode(sig, (bytes32, uint64, bytes));`
   5. `ICzarVault.Pullback storage p = s.pullbacks[pullbackId];` `p.state == Pending` and `block.number <= p.maxBlockHeight` (RV-036)
   6. `ICzarVault.Pocket storage k = s.pockets[p.pocket];` `k.envelopeId != 0`; `k.state == Draining`, or `k.state == Closed && p.recovery` (RV-004)
   7. `bytes32 structHash = CzarHashing.burnIntentStructHash(p.maxBlockHeight, p.maxFee, CzarHashing.transferSpecStructHash(VaultGuards.pullbackTransferSpec(c, p)));`
   8. `digest == CzarHashing.typedDataHash(GATEWAY_DOMAIN_SEPARATOR, structHash)`
   9. `return VaultGuards.agentSigned(s, digest, agentSig);`
- Freeze and pause do not block this kind (§6.2 step 2): there is no `_spendingAllowed` call here.
- `VaultGuards.pullbackTransferSpec` (PRD 03) fills every `TransferSpec` field from the §6.2 table: recipient and signer are always the vault.

## 9. `test/PocketTest.t.sol`
- 43 tests: every check and error of the eight functions in order; gas grants (one ledger: the vault's USDC balance drops by the units sent), the re-entering pocket (`NativeSendFailed`, RV-006); repeat funding within the cumulative cap; partial pullbacks; the `GATEWAY_BURN` signature end to end (request → `isValidSignature` → the Gateway mock burns `value + fee` → `confirmPullback`), every `TransferSpec` field mutated (all `INVALID`), the `maxBlockHeight` bound, wrong signer and malformed layouts; recovery pullbacks of a `Closed` pocket (RV-004); force-close with a pocket and a pending record (RV-005); `cancelPullback` timing and a late mint of a cancelled record (RV-036); write-off of a `Registered` pocket (RV-049); `recordManualReturn` bounds (RV-010); the shortfall when the owner withdrew first (RV-011); the fee bound (RV-037); and a fuzz test of INV-7.
- The Gateway fee comes out of the pocket's Gateway balance, so full pullbacks in the tests request `funded − FEE`.
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICzarVault} from "../src/interfaces/ICzarVault.sol";
import {CzarHashing, TransferSpecFields} from "../src/libraries/CzarHashing.sol";
import {CzarNonces} from "../src/libraries/CzarNonces.sol";
import {
    USDC_ADDRESS,
    KIND_GATEWAY_BURN,
    GATEWAY_DOMAIN_SEPARATOR,
    MAX_GAS_GRANT_PER_POCKET,
    MAX_PULLBACK_WINDOW_BLOCKS,
    PULLBACK_CANCEL_DELAY_BLOCKS,
    FORCE_CLOSE_DELAY
} from "../src/libraries/CzarConstants.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";
import {PayeeTree} from "./helpers/PayeeTree.sol";

/// @dev A pocket EOA that later carries code (EIP-7702 style) and re-enters the vault when it receives gas.
contract ReenteringPocket {
    receive() external payable {
        ICzarVault(msg.sender).sync(); // a guarded vault function; the revert is not caught
    }
}

/// @dev 07 PRD 08 (T-017). czar-vault.md §5.4, §6.2, §15; INV-2, INV-3, INV-6, INV-7, INV-14, INV-15.
contract PocketTest is VaultTestBase, PayeeTree {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant INVALID = 0xffffffff;
    uint256 internal constant CAP = 4 * ONE_USDC;
    uint16 internal constant POCKET_BPS = 2500; // pocket cap = 1 USDC
    uint256 internal constant POCKET_CAP = ONE_USDC;
    uint256 internal constant FEE = 3_500; // measured Gateway fee at 20 Gwei (A2-17)
    uint64 internal constant LIFETIME = 1 days;

    uint256 internal agentPk = uint256(keccak256(abi.encodePacked("agent")));
    address internal pocket = POCKET_B0C0;
    address internal feeSink = makeAddr("gatewayFees");
    uint64 internal env;

    function setUp() public override {
        super.setUp();
        _fundVault(10 * ONE_USDC);
        env = _openEnvelope(POCKET_BPS);
    }

    // ───────────── Helpers ─────────────

    function _openEnvelope(uint16 bps) internal returns (uint64 id) {
        ICzarVault.OpenEnvelopeParams memory p;
        p.cap = CAP;
        p.maxStepAmount = ONE_USDC;
        p.pocketCapBps = bps;
        p.expiresAt = uint64(block.timestamp + LIFETIME);
        p.categoryId = keccak256("category");
        p.payeeRoot = PAYEE_ROOT;
        vm.prank(owner);
        id = vault.openEnvelope(p);
    }

    function _register() internal {
        bytes32[] memory proof = _proofB0c0();
        vm.prank(agent);
        vault.registerPocket(env, pocket, proof);
    }

    function _delegate() internal {
        vm.prank(pocket);
        gatewayWallet.addDelegate(USDC_ADDRESS, address(vault));
    }

    function _registerAndFund(uint256 amount) internal {
        _register();
        _delegate();
        vm.prank(agent);
        vault.fundPocket(pocket, amount);
    }

    function _request(address caller, uint256 value) internal returns (uint64 id) {
        uint256 maxBlock = block.number + 100;
        vm.prank(caller);
        id = vault.requestPullback(pocket, value, FEE, maxBlock);
    }

    function _spec(ICzarVault.Pullback memory p) internal view returns (TransferSpecFields memory f) {
        f.version = 1;
        f.sourceDomain = ARC_GATEWAY_DOMAIN;
        f.destinationDomain = ARC_GATEWAY_DOMAIN;
        f.sourceContract = CzarHashing.toBytes32(address(gatewayWallet));
        f.destinationContract = CzarHashing.toBytes32(address(gatewayMinter));
        f.sourceToken = CzarHashing.toBytes32(USDC_ADDRESS);
        f.destinationToken = CzarHashing.toBytes32(USDC_ADDRESS);
        f.sourceDepositor = CzarHashing.toBytes32(p.pocket);
        f.destinationRecipient = CzarHashing.toBytes32(address(vault));
        f.sourceSigner = CzarHashing.toBytes32(address(vault));
        f.destinationCaller = bytes32(0);
        f.value = p.value;
        f.salt = p.salt;
    }

    function _burnDigest(TransferSpecFields memory f, uint256 maxBlockHeight, uint256 maxFee)
        internal
        pure
        returns (bytes32)
    {
        return CzarHashing.typedDataHash(
            GATEWAY_DOMAIN_SEPARATOR,
            CzarHashing.burnIntentStructHash(maxBlockHeight, maxFee, CzarHashing.transferSpecStructHash(f))
        );
    }

    function _burnSig(uint64 pullbackId, bytes32 digest, uint256 pk) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encode(KIND_GATEWAY_BURN, pullbackId, abi.encodePacked(r, s, v));
    }

    /// @dev Circle's TEE checks the vault signature when the agent submits the burn intent (A2-08).
    function _attest(uint64 pullbackId) internal view {
        ICzarVault.Pullback memory p = vault.getPullback(pullbackId);
        bytes32 digest = _burnDigest(_spec(p), p.maxBlockHeight, p.maxFee);
        assertEq(vault.isValidSignature(digest, _burnSig(pullbackId, digest, agentPk)), MAGIC);
    }

    /// @dev The mint of an attested intent: the pocket's Gateway balance loses `value + fee`, the vault
    ///      receives `value`, and the transfer-spec hash is marked used (A2-16). The fee comes out of the
    ///      pocket's balance, so a request leaves `FEE` behind in the pocket.
    function _mint(uint64 pullbackId) internal {
        ICzarVault.Pullback memory p = vault.getPullback(pullbackId);
        gatewayWallet.testBurn(USDC_ADDRESS, p.pocket, p.value, address(vault));
        gatewayWallet.testBurn(USDC_ADDRESS, p.pocket, FEE, feeSink);
        gatewayMinter.testMarkTransferSpecHashUsed(p.transferSpecHash);
    }

    function _gatewayMint(uint64 pullbackId) internal {
        _attest(pullbackId);
        _mint(pullbackId);
    }

    /// @dev INV-2 for the single open envelope, and INV-7 for the pocket while it is not Closed.
    function _assertInvariants() internal view {
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        if (e.state == ICzarVault.EnvelopeState.Open) {
            assertEq(vault.committedTotal(), e.cap - e.spent - e.pocketOutstanding - e.jobEscrowed - e.shortfall);
        }
        ICzarVault.Pocket memory k = vault.getPocket(pocket);
        if (k.state != ICzarVault.PocketState.Closed) {
            assertLe(k.pendingPullback, k.outstanding);
            assertLe(k.outstanding, k.funded);
            assertLe(k.funded, e.cap * e.pocketCapBps / 10_000);
        }
    }

    // ───────────── registerPocket ─────────────

    function test_registerPocket_registers() public {
        bytes32[] memory proof = _proofB0c0();
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.PocketRegistered(env, pocket);
        vm.prank(agent);
        vault.registerPocket(env, pocket, proof);
        ICzarVault.Pocket memory k = vault.getPocket(pocket);
        assertEq(k.envelopeId, env);
        assertEq(uint8(k.state), uint8(ICzarVault.PocketState.Registered));
        assertEq(vault.envelopePocket(env), pocket);
        assertEq(vault.getEnvelope(env).openPockets, 1);
    }

    function test_registerPocket_notAgent_reverts() public {
        bytes32[] memory proof = _proofB0c0();
        vm.prank(owner);
        vm.expectRevert(ICzarVault.NotAgent.selector);
        vault.registerPocket(env, pocket, proof);
    }

    function test_registerPocket_frozenOrPaused_reverts() public {
        bytes32[] memory proof = _proofB0c0();
        vm.prank(owner);
        vault.freeze();
        vm.prank(agent);
        vm.expectRevert(ICzarVault.FrozenVault.selector);
        vault.registerPocket(env, pocket, proof);
        vm.prank(owner);
        vault.unfreeze();
        vaultFactory.setGuardianPaused(true);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.Paused.selector);
        vault.registerPocket(env, pocket, proof);
    }

    function test_registerPocket_expired_reverts() public {
        bytes32[] memory proof = _proofB0c0();
        vm.warp(block.timestamp + LIFETIME);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.EnvelopeExpired.selector);
        vault.registerPocket(env, pocket, proof);
    }

    /// @dev RV-003 named test (the pocketCapBps check comes before the proof, §15.3).
    function test_registerPocket_pocketCapZero_reverts() public {
        uint64 noPocket = _openEnvelope(0);
        bytes32[] memory proof = _proofB0c0();
        vm.prank(agent);
        vm.expectRevert(ICzarVault.PocketCapZero.selector);
        vault.registerPocket(noPocket, pocket, proof);
    }

    function test_registerPocket_zeroAddress_reverts() public {
        bytes32[] memory proof = _proofB0c0();
        vm.prank(agent);
        vm.expectRevert(ICzarVault.ZeroAddress.selector);
        vault.registerPocket(env, address(0), proof);
    }

    /// @dev RV-003 / RV-005 named test.
    function test_registerPocket_secondPocketOnEnvelope_reverts() public {
        _register();
        bytes32[] memory proof = _proofB0c0();
        vm.prank(agent);
        vm.expectRevert(ICzarVault.PocketExists.selector);
        vault.registerPocket(env, makeAddr("second"), proof);
        uint64 other = _openEnvelope(POCKET_BPS); // the same pocket address in another envelope
        vm.prank(agent);
        vm.expectRevert(ICzarVault.PocketExists.selector);
        vault.registerPocket(other, pocket, proof);
    }

    function test_registerPocket_contract_revertsNotEoa() public {
        vm.etch(pocket, hex"00");
        bytes32[] memory proof = _proofB0c0();
        vm.prank(agent);
        vm.expectRevert(ICzarVault.NotEoa.selector);
        vault.registerPocket(env, pocket, proof);
    }

    /// @dev RV-003 named test.
    function test_registerPocket_addressNotInPayeeRoot_reverts() public {
        bytes32[] memory proof = _proofB0c0();
        vm.prank(agent);
        vm.expectRevert(ICzarVault.PocketNotInPlan.selector);
        vault.registerPocket(env, makeAddr("agentControlled"), proof);
        bytes32[] memory payeeProof = _proofBeef(); // an x402 payee is not a kind-4 leaf
        vm.prank(agent);
        vm.expectRevert(ICzarVault.PocketNotInPlan.selector);
        vault.registerPocket(env, PAYEE_BEEF, payeeProof);
    }

    // ───────────── grantPocketGas ─────────────

    function test_grantPocketGas_sendsNativeAndBooksSpent() public {
        _register();
        uint256 vaultBefore = usdc.balanceOf(address(vault));
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.PocketGasGranted(pocket, 20_000);
        vm.prank(agent);
        vault.grantPocketGas(pocket, 20_000);
        assertEq(pocket.balance, 20_000 * 1e12);
        assertEq(usdc.balanceOf(address(vault)), vaultBefore - 20_000); // one ledger (A1-05)
        assertEq(vault.getPocket(pocket).gasGranted, 20_000);
        assertEq(vault.getEnvelope(env).spent, 20_000);
        _assertInvariants();
    }

    /// @dev RV-006 named test.
    function test_grantPocketGas_whileFrozenPausedOrExpired_reverts() public {
        _register();
        vm.prank(owner);
        vault.freeze();
        vm.prank(agent);
        vm.expectRevert(ICzarVault.FrozenVault.selector);
        vault.grantPocketGas(pocket, 1);
        vm.prank(owner);
        vault.unfreeze();
        vaultFactory.setGuardianPaused(true);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.Paused.selector);
        vault.grantPocketGas(pocket, 1);
        vaultFactory.setGuardianPaused(false);
        vm.warp(block.timestamp + LIFETIME);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.EnvelopeExpired.selector);
        vault.grantPocketGas(pocket, 1);
    }

    function test_grantPocketGas_limitsAndState_revert() public {
        vm.prank(agent);
        vm.expectRevert(ICzarVault.PocketWrongState.selector);
        vault.grantPocketGas(pocket, 1); // not registered
        _register();
        vm.prank(agent);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.grantPocketGas(pocket, 0);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.GasGrantExceeded.selector);
        vault.grantPocketGas(pocket, MAX_GAS_GRANT_PER_POCKET + 1);
        vm.prank(agent);
        vault.grantPocketGas(pocket, MAX_GAS_GRANT_PER_POCKET);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.GasGrantExceeded.selector);
        vault.grantPocketGas(pocket, 1);
    }

    /// @dev RV-006 named test (D88, G-42): the re-entry hits the guard, the native send fails.
    function test_grantPocketGas_reentrantPocket_reverts() public {
        _register();
        vm.etch(pocket, address(new ReenteringPocket()).code); // the EOA gains code after registration
        vm.prank(agent);
        vm.expectRevert(ICzarVault.NativeSendFailed.selector);
        vault.grantPocketGas(pocket, 1_000);
    }

    // ───────────── fundPocket ─────────────

    function test_fundPocket_depositsAndBooks() public {
        _register();
        _delegate();
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.PocketFunded(pocket, env, 600_000, 600_000);
        vm.prank(agent);
        vault.fundPocket(pocket, 600_000);
        ICzarVault.Pocket memory k = vault.getPocket(pocket);
        assertEq(k.funded, 600_000);
        assertEq(k.outstanding, 600_000);
        assertEq(uint8(k.state), uint8(ICzarVault.PocketState.Funded));
        assertEq(vault.getEnvelope(env).pocketOutstanding, 600_000);
        assertEq(gatewayWallet.availableBalance(USDC_ADDRESS, pocket), 600_000);
        assertEq(usdc.allowance(address(vault), address(gatewayWallet)), 0); // approval reset
        vm.prank(agent);
        vault.fundPocket(pocket, 400_000); // repeat funding inside the cumulative cap (D88, G-41)
        assertEq(vault.getPocket(pocket).funded, POCKET_CAP);
        _assertInvariants();
    }

    function test_fundPocket_noDelegate_reverts() public {
        _register();
        vm.prank(agent);
        vm.expectRevert(ICzarVault.DelegateNotSet.selector);
        vault.fundPocket(pocket, 1);
    }

    function test_fundPocket_aboveCaps_revert() public {
        _register();
        _delegate();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.PocketCapExceeded.selector, POCKET_CAP, 0, POCKET_CAP + 1));
        vault.fundPocket(pocket, POCKET_CAP + 1);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.fundPocket(pocket, 0);
    }

    function test_fundPocket_draining_revertsPocketWrongState() public {
        _registerAndFund(500_000);
        _request(agent, 100_000);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.PocketWrongState.selector);
        vault.fundPocket(pocket, 1);
    }

    function test_fundPocket_frozen_reverts() public {
        _register();
        _delegate();
        vm.prank(agent);
        vault.freeze();
        vm.prank(agent);
        vm.expectRevert(ICzarVault.FrozenVault.selector);
        vault.fundPocket(pocket, 1);
    }

    // ───────────── requestPullback ─────────────

    function test_requestPullback_storesRecordAndHash() public {
        _registerAndFund(ONE_USDC);
        uint256 maxBlock = block.number + 100;
        bytes32 salt = CzarNonces.pullbackSalt(address(vault), 1);
        ICzarVault.Pullback memory expect;
        expect.pocket = pocket;
        expect.value = 400_000;
        expect.salt = salt;
        bytes32 replay = CzarHashing.transferSpecReplayHash(_spec(expect));
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.PullbackRequested(1, pocket, 400_000, FEE, maxBlock, replay, salt);
        vm.prank(agent);
        uint64 id = vault.requestPullback(pocket, 400_000, FEE, maxBlock);
        ICzarVault.Pullback memory p = vault.getPullback(id);
        assertEq(p.pocket, pocket);
        assertEq(p.value, 400_000);
        assertEq(p.maxFee, FEE);
        assertEq(p.maxBlockHeight, maxBlock);
        assertEq(p.salt, salt);
        assertEq(p.transferSpecHash, replay);
        assertEq(p.requestedAtBlock, block.number);
        assertEq(uint8(p.state), uint8(ICzarVault.PullbackState.Pending));
        assertFalse(p.recovery);
        ICzarVault.Pocket memory k = vault.getPocket(pocket);
        assertEq(k.pendingPullback, 400_000);
        assertEq(uint8(k.state), uint8(ICzarVault.PocketState.Draining));
        _assertInvariants();
    }

    function test_requestPullback_ownerAllowed_strangerRefused_notGatedByFreeze() public {
        _registerAndFund(ONE_USDC);
        vm.prank(owner);
        vault.freeze();
        vaultFactory.setGuardianPaused(true);
        _request(owner, 100_000); // money only comes back: freeze and pause do not block
        uint256 maxBlock = block.number + 100;
        vm.prank(stranger);
        vm.expectRevert(ICzarVault.NotAuthorized.selector);
        vault.requestPullback(pocket, 1, FEE, maxBlock);
    }

    function test_requestPullback_badParams_revert() public {
        vm.prank(agent);
        vm.expectRevert(ICzarVault.PocketWrongState.selector);
        vault.requestPullback(pocket, 1, FEE, block.number + 1); // unknown pocket
        _registerAndFund(ONE_USDC);
        uint256 tooFar = block.number + MAX_PULLBACK_WINDOW_BLOCKS + 1;
        uint256 now_ = block.number;
        vm.startPrank(agent);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.requestPullback(pocket, 0, FEE, now_ + 1);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.requestPullback(pocket, 1, FEE, now_);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.requestPullback(pocket, 1, FEE, tooFar);
        vm.expectRevert(ICzarVault.PullbackTooLarge.selector);
        vault.requestPullback(pocket, ONE_USDC + 1, FEE, now_ + 1);
        vm.stopPrank();
    }

    /// @dev RV-037 named test.
    function test_requestPullback_feeAboveCurrentMax_reverts() public {
        _registerAndFund(ONE_USDC);
        vm.prank(owner);
        vault.setMaxPullbackFee(FEE - 1);
        uint256 maxBlock = block.number + 100;
        vm.prank(agent);
        vm.expectRevert(ICzarVault.FeeTooHigh.selector);
        vault.requestPullback(pocket, 1, FEE, maxBlock);
    }

    function test_requestPullback_partialRecordsCoexist() public {
        _registerAndFund(ONE_USDC);
        _request(agent, 300_000);
        _request(agent, 700_000);
        uint256 maxBlock = block.number + 100;
        vm.prank(agent);
        vm.expectRevert(ICzarVault.PullbackTooLarge.selector);
        vault.requestPullback(pocket, 1, FEE, maxBlock); // Σ pending == outstanding
        _assertInvariants();
    }

    // ───────────── GATEWAY_BURN signature (§6.2) ─────────────

    function test_gatewayBurn_valid_andNotGatedByFreeze() public {
        _registerAndFund(ONE_USDC);
        uint64 id = _request(agent, 500_000);
        ICzarVault.Pullback memory p = vault.getPullback(id);
        bytes32 digest = _burnDigest(_spec(p), p.maxBlockHeight, p.maxFee);
        bytes memory sig = _burnSig(id, digest, agentPk);
        assertEq(sig.length, 224);
        assertEq(vault.isValidSignature(digest, sig), MAGIC);
        vm.prank(owner);
        vault.freeze();
        assertEq(vault.isValidSignature(digest, sig), MAGIC);
    }

    function test_gatewayBurn_everyFieldMutated_invalid() public {
        _registerAndFund(ONE_USDC);
        uint64 id = _request(agent, 500_000);
        ICzarVault.Pullback memory p = vault.getPullback(id);
        for (uint256 k = 0; k < 13; k++) {
            TransferSpecFields memory f = _spec(p);
            if (k == 0) f.version = 2;
            if (k == 1) f.sourceDomain = 0; // cross-chain intents are refused
            if (k == 2) f.destinationDomain = 6;
            if (k == 3) f.sourceContract = bytes32(uint256(1));
            if (k == 4) f.destinationContract = bytes32(uint256(1));
            if (k == 5) f.sourceToken = bytes32(uint256(1));
            if (k == 6) f.destinationToken = bytes32(uint256(1));
            if (k == 7) f.sourceDepositor = CzarHashing.toBytes32(stranger);
            if (k == 8) f.destinationRecipient = CzarHashing.toBytes32(stranger); // never anywhere but the vault
            if (k == 9) f.sourceSigner = CzarHashing.toBytes32(stranger);
            if (k == 10) f.destinationCaller = CzarHashing.toBytes32(stranger);
            if (k == 11) f.value = p.value + 1;
            if (k == 12) f.salt = bytes32(uint256(p.salt) + 1);
            bytes32 digest = _burnDigest(f, p.maxBlockHeight, p.maxFee);
            assertEq(vault.isValidSignature(digest, _burnSig(id, digest, agentPk)), INVALID);
        }
        bytes32 feeDigest = _burnDigest(_spec(p), p.maxBlockHeight, p.maxFee + 1);
        assertEq(vault.isValidSignature(feeDigest, _burnSig(id, feeDigest, agentPk)), INVALID);
        bytes32 heightDigest = _burnDigest(_spec(p), p.maxBlockHeight + 1, p.maxFee);
        assertEq(vault.isValidSignature(heightDigest, _burnSig(id, heightDigest, agentPk)), INVALID);
    }

    /// @dev RV-036 named test (second half).
    function test_gatewayBurn_afterMaxBlockHeight_invalid() public {
        _registerAndFund(ONE_USDC);
        uint64 id = _request(agent, 500_000);
        ICzarVault.Pullback memory p = vault.getPullback(id);
        bytes32 digest = _burnDigest(_spec(p), p.maxBlockHeight, p.maxFee);
        bytes memory sig = _burnSig(id, digest, agentPk);
        vm.roll(p.maxBlockHeight);
        assertEq(vault.isValidSignature(digest, sig), MAGIC);
        vm.roll(p.maxBlockHeight + 1);
        assertEq(vault.isValidSignature(digest, sig), INVALID);
    }

    function test_gatewayBurn_wrongSignerOrLayout_invalid() public {
        _registerAndFund(ONE_USDC);
        uint64 id = _request(agent, 500_000);
        ICzarVault.Pullback memory p = vault.getPullback(id);
        bytes32 digest = _burnDigest(_spec(p), p.maxBlockHeight, p.maxFee);
        assertEq(vault.isValidSignature(digest, _burnSig(id, digest, 0xBAD)), INVALID);
        bytes memory sig = _burnSig(id, digest, agentPk);
        sig[32] = 0x01; // pullbackId word out of uint64 range: invalid, no revert
        assertEq(vault.isValidSignature(digest, sig), INVALID);
        assertEq(vault.isValidSignature(digest, _burnSig(id + 1, digest, agentPk)), INVALID); // unknown record
    }

    // ───────────── confirmPullback ─────────────

    function test_confirmPullback_creditsEnvelope() public {
        _registerAndFund(ONE_USDC);
        uint64 id = _request(agent, 600_000);
        vm.expectRevert(ICzarVault.NotMinted.selector);
        vault.confirmPullback(id);
        _gatewayMint(id);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.PullbackConfirmed(id, pocket, 600_000, true);
        vm.prank(stranger); // anyone
        vault.confirmPullback(id);
        ICzarVault.Pocket memory k = vault.getPocket(pocket);
        assertEq(k.outstanding, 400_000);
        assertEq(k.pendingPullback, 0);
        assertEq(uint8(k.state), uint8(ICzarVault.PocketState.Draining)); // confirm never closes (RV-049)
        assertEq(vault.getEnvelope(env).pocketOutstanding, 400_000);
        assertEq(uint8(vault.getPullback(id).state), uint8(ICzarVault.PullbackState.Confirmed));
        _assertInvariants();
        vm.expectRevert(ICzarVault.PullbackWrongState.selector);
        vault.confirmPullback(id);
    }

    /// @dev RV-011 named test.
    function test_withdrawBeforeConfirmPullback_recordsShortfall() public {
        _registerAndFund(ONE_USDC);
        uint256 value = ONE_USDC - FEE; // the Gateway fee stays behind in the pocket
        uint64 id = _request(agent, value);
        _gatewayMint(id);
        uint256 free = vault.freeBalance();
        vm.prank(owner);
        vault.withdraw(owner, free); // the minted USDC is free balance until confirmed
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.ShortfallRecorded(env, value, value);
        vault.confirmPullback(id);
        assertEq(vault.envelopeShortfall(env), value);
        assertLe(vault.committedTotal(), usdc.balanceOf(address(vault)));
        _assertInvariants();
    }

    /// @dev RV-004 named test.
    function test_recoveryPullback_closedPocket_mintIsFreeBalance() public {
        _registerAndFund(ONE_USDC);
        vm.prank(agent);
        vault.writeOffPocket(pocket); // Closed; its Gateway balance still exists
        uint256 committedBefore = vault.committedTotal();
        uint64 id = _request(agent, 300_000);
        assertTrue(vault.getPullback(id).recovery);
        _gatewayMint(id); // asserts the GATEWAY_BURN digest is valid for a recovery record
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.PullbackConfirmed(id, pocket, 300_000, false);
        vault.confirmPullback(id);
        assertEq(vault.committedTotal(), committedBefore);
        assertGe(vault.freeBalance(), 300_000);
    }

    /// @dev RV-005 named test.
    function test_confirmPullback_afterForceClose_creditsFreeBalance() public {
        _registerAndFund(ONE_USDC);
        uint64 id = _request(agent, 500_000);
        _attest(id); // attested while Draining; the mint lands after the force-close
        vm.warp(vault.getEnvelope(env).expiresAt + FORCE_CLOSE_DELAY);
        vm.prank(owner);
        vault.forceCloseEnvelope(env);
        assertEq(vault.getPocket(pocket).pendingPullback, 500_000); // kept for the Pending record (INV-7)
        bytes32 digest = _burnDigest(_spec(vault.getPullback(id)), vault.getPullback(id).maxBlockHeight, FEE);
        assertEq(vault.isValidSignature(digest, _burnSig(id, digest, agentPk)), INVALID); // no new attestation (§6.2)
        _mint(id);
        vault.confirmPullback(id);
        assertEq(vault.committedTotal(), 0);
        assertEq(vault.getPocket(pocket).pendingPullback, 0);
    }

    /// @dev RV-005 named test (real fundPocket; PRD 05 has the harness version).
    function test_forceClose_fundedPocket_closesPocketAndReleasesAll() public {
        _registerAndFund(ONE_USDC);
        vm.warp(vault.getEnvelope(env).expiresAt + FORCE_CLOSE_DELAY);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.PocketClosed(pocket, ONE_USDC);
        vm.prank(owner);
        vault.forceCloseEnvelope(env);
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.pocketOutstanding, 0);
        assertEq(e.spent, ONE_USDC);
        assertEq(uint8(vault.getPocket(pocket).state), uint8(ICzarVault.PocketState.Closed));
        assertEq(vault.committedTotal(), 0);
    }

    // ───────────── cancelPullback ─────────────

    /// @dev RV-036 named test (first half).
    function test_cancelPullback_beforeMaxBlockPlusDelay_reverts() public {
        _registerAndFund(ONE_USDC);
        uint64 id = _request(agent, 500_000);
        vm.roll(vault.getPullback(id).maxBlockHeight + PULLBACK_CANCEL_DELAY_BLOCKS - 1);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.TooEarly.selector);
        vault.cancelPullback(id);
        vm.roll(block.number + 1);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.PullbackCancelled(id);
        vm.prank(owner);
        vault.cancelPullback(id);
        assertEq(vault.getPocket(pocket).pendingPullback, 0);
        assertEq(uint8(vault.getPullback(id).state), uint8(ICzarVault.PullbackState.Cancelled));
    }

    function test_cancelPullback_mintedOrStranger_reverts() public {
        _registerAndFund(ONE_USDC);
        uint64 id = _request(agent, 500_000);
        vm.roll(vault.getPullback(id).maxBlockHeight + PULLBACK_CANCEL_DELAY_BLOCKS);
        vm.prank(stranger);
        vm.expectRevert(ICzarVault.NotAuthorized.selector);
        vault.cancelPullback(id);
        gatewayMinter.testMarkTransferSpecHashUsed(vault.getPullback(id).transferSpecHash);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.AlreadyMinted.selector);
        vault.cancelPullback(id);
    }

    /// @dev RV-036 named test: a mint that lands after the cancel still credits, clamped so INV-7 holds.
    function test_lateMintOfCancelledRecord_keepsPendingWithinOutstanding() public {
        _registerAndFund(ONE_USDC);
        uint64 a = _request(agent, 600_000);
        vm.roll(vault.getPullback(a).maxBlockHeight + PULLBACK_CANCEL_DELAY_BLOCKS);
        vm.prank(agent);
        vault.cancelPullback(a);
        uint64 b = _request(agent, 800_000); // re-request after the cancel
        gatewayWallet.testBurn(USDC_ADDRESS, pocket, 600_000, address(vault)); // the old intent minted anyway
        gatewayMinter.testMarkTransferSpecHashUsed(vault.getPullback(a).transferSpecHash);
        vault.confirmPullback(a); // branch (b): x = min(600,000, outstanding − pending) = 200,000
        ICzarVault.Pocket memory k = vault.getPocket(pocket);
        assertEq(k.outstanding, 800_000);
        assertEq(k.pendingPullback, 800_000);
        assertEq(uint8(vault.getPullback(b).state), uint8(ICzarVault.PullbackState.Pending));
        _assertInvariants();
    }

    // ───────────── writeOffPocket ─────────────

    /// @dev RV-049 named test.
    function test_writeOff_registeredPocket_writtenOffZero() public {
        _register();
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.PocketClosed(pocket, 0);
        vm.prank(agent);
        vault.writeOffPocket(pocket);
        assertEq(vault.getEnvelope(env).openPockets, 0);
        vm.prank(owner);
        vault.closeEnvelope(env); // the envelope can close
    }

    function test_writeOff_fundedPocket_countsAsSpent() public {
        _registerAndFund(600_000);
        vm.prank(owner);
        vault.writeOffPocket(pocket);
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.spent, 600_000);
        assertEq(e.pocketOutstanding, 0);
        assertEq(uint8(vault.getPocket(pocket).state), uint8(ICzarVault.PocketState.Closed));
        _assertInvariants();
    }

    function test_writeOff_pendingPullback_reverts() public {
        _registerAndFund(600_000);
        _request(agent, 100_000);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.PullbackPending.selector);
        vault.writeOffPocket(pocket);
    }

    // ───────────── recordManualReturn ─────────────

    /// @dev RV-010 named test.
    function test_recordManualReturn_boundedByOutstandingAndFree() public {
        _registerAndFund(ONE_USDC);
        _request(agent, 300_000); // outstanding − pending = 700,000
        uint256 free = vault.freeBalance();
        vm.prank(owner);
        vault.withdraw(owner, free - 500_000); // leave 500,000 free (as if the slow-path return arrived)
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.ManualReturnRecorded(pocket, 500_000);
        vm.prank(owner);
        vault.recordManualReturn(pocket, 2 * ONE_USDC);
        assertEq(vault.getPocket(pocket).outstanding, 500_000);
        assertEq(vault.freeBalance(), 0);
        _assertInvariants();
    }

    /// @dev RV-010 named test.
    function test_recordManualReturn_notOwner_reverts() public {
        _registerAndFund(ONE_USDC);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.NotOwner.selector);
        vault.recordManualReturn(pocket, 1);
    }

    /// @dev RV-010 named test.
    function test_recordManualReturn_closedPocket_reverts() public {
        _registerAndFund(ONE_USDC);
        vm.prank(agent);
        vault.writeOffPocket(pocket);
        vm.prank(owner);
        vm.expectRevert(ICzarVault.PocketWrongState.selector);
        vault.recordManualReturn(pocket, 1);
    }

    function test_recordManualReturn_nothingToCredit_revertsNoChange() public {
        _registerAndFund(ONE_USDC);
        uint256 free = vault.freeBalance();
        vm.prank(owner);
        vault.withdraw(owner, free);
        vm.prank(owner);
        vm.expectRevert(ICzarVault.NoChange.selector);
        vault.recordManualReturn(pocket, 1);
    }

    // ───────────── Fuzz: INV-7 over fund / request / mint / confirm ─────────────

    function testFuzz_pocketFlow_invariants(uint256 fund, uint256 pull) public {
        fund = bound(fund, FEE + 1, POCKET_CAP);
        pull = bound(pull, 1, fund - FEE); // the Gateway fee comes out of the pocket balance
        _registerAndFund(fund);
        uint64 id = _request(agent, pull);
        _assertInvariants();
        _gatewayMint(id);
        vault.confirmPullback(id);
        _assertInvariants();
        ICzarVault.Pocket memory k = vault.getPocket(pocket);
        assertEq(k.outstanding, fund - pull);
        assertEq(usdc.balanceOf(address(vault)), vault.committedTotal() + vault.freeBalance());
    }
}
```

## 10. Build steps (tests first)
1. Create `test/PocketTest.t.sol` (§9).
2. Run `FOUNDRY_PROFILE=arc arc-forge test --match-path test/PocketTest.t.sol`. Expected: `0 passed; 43 failed`, every failure mentioning `NotBuilt()`. Paste the summary line into your report.
3. Write `src/vault/logic/PocketLogic.sol` from §7, then edit `SignatureLogic.sol` (§8).
4. Do §5 (delete the 8 stubs) and §6 (replace `CzarVault.sol`).
5. Run the test file again: 43 passed. Then `FOUNDRY_PROFILE=arc arc-forge test --match-path test/SignatureTest.t.sol`: still 38 passed.
6. `arc-forge fmt src/vault/logic/PocketLogic.sol src/vault/logic/SignatureLogic.sol src/vault/VaultStubs.sol`, then `arc-forge fmt --check` on those files plus `src/CzarVault.sol` and `test/PocketTest.t.sol`: nothing printed apart from the flag notice.
7. Run the clean gate build and the full suite (00-conventions §2.2). The clean build matters here: it is the only way the lint sees `grantPocketGas` (§7.3).

## 11. Definition of done
- `FOUNDRY_PROFILE=arc arc-forge test --match-contract PocketTest` → 43 passed, 0 failed (T-017 acceptance command).
- `FOUNDRY_PROFILE=arc arc-forge test` → 285 passed, 0 failed.
- `rm -rf out cache && FOUNDRY_PROFILE=arc arc-forge build --deny-warnings --sizes` → no warnings; `CzarVault` runtime about 12,989 B, `PocketLogic` about 9,353 B and `SignatureLogic` about 6,300 B (more than 300 B off means your code differs from §6–§8).
- `grep -c "revert NotBuilt" src/vault/VaultStubs.sol` → 8.
- `diff -r src/interfaces ../docs/specs/03-smart-contracts/interfaces` → nothing.
- G0-09 recorded and passed (§1).

## 12. Stop conditions
- A test fails after you have compared the function with its numbered steps: stop and report the test name and failure line. Never change a test.
- The clean build reports `missing-zero-check` anywhere other than `grantPocketGas`, or the comment in §7.3 does not silence it: stop and report the lint line.
- G0-09 fails (§1).

## Change log
| Date | Change |
|---|---|
| 2026-10-20 | First version (D89 library layout), verified on Arc Foundry v0.8.0-2 against a reference implementation. |
