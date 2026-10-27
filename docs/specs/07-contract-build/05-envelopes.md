# 05 — Envelopes

## 1. Scope
- **Task:** T-014 (envelopes: `openEnvelope` with the owner path and the agent allowance, `closeEnvelope`, `forceCloseEnvelope`).
- **You build:** `contracts/src/vault/logic/EnvelopeLogic.sol` (3 external functions), test-only setters in `CzarVaultHarness`, and `contracts/test/EnvelopeTest.t.sol`. You delete 3 stubs and replace `CzarVault.sol`.
- **You do not build:** reservations, pockets or jobs. Tests that need an open reservation, a funded pocket or an opened job create that state with the harness setters in §6 (PRDs 06, 08 and 09 later repeat the important cases with the real functions).
- **Dependencies:** PRD 04 done (143 tests, `VaultCoreTest` 36 passed, 24 stubs).

## 2. This PRD is already verified
- A reference `EnvelopeLogic` written from §7 passed on **Arc Foundry v0.8.0-2** with `FOUNDRY_PROFILE=arc`: clean `--deny-warnings` build (compiler and lint), `fmt --check` clean, 171 tests passed (143 earlier plus 28 here).
- Sizes after this PRD: `CzarVault` runtime 10,584 B, initcode 12,277 B; `CzarVaultFactory` runtime 16,791 B; `EnvelopeLogic` runtime 3,985 B.
- The test file (§8) and the harness (§6) are printed in full: copy them exactly.

## 3. Sources (read these, nothing else)
- `07-contract-build/00-conventions.md` (§3, §3.1 stubs, §3.2 library rules, §4 style, §5 tests, §5.6 traps).
- `07-contract-build/04-vault-core.md` §5 (the wrapper-and-library rule; it applies here unchanged).
- `docs/specs/03-smart-contracts/czar-vault.md`: §5.2 (the three functions), §5.6 (allowance and period), §8.1 (state machine), §11 INV-1, INV-2, INV-9, INV-14, §15.1–§15.3, §15.5, §15.7.
- `docs/specs/03-smart-contracts/interfaces/ICzarVault.sol` (`OpenEnvelopeParams`, `Envelope`, events, errors).
- `docs/specs/03-smart-contracts/security-and-testing.md` §3.7 rows RV-003, RV-005, RV-008.

## 4. Files
| File | Action | Section |
|---|---|---|
| `contracts/test/helpers/CzarVaultHarness.sol` | replace | §6 |
| `contracts/test/EnvelopeTest.t.sol` | create | §8 |
| `contracts/src/vault/logic/EnvelopeLogic.sol` | create | §7 |
| `contracts/src/vault/VaultStubs.sol` | delete 3 stubs | §5 |
| `contracts/src/CzarVault.sol` | replace | §5 |

## 5. Wire the library in
1. In `VaultStubs.sol`, delete the whole stub of `closeEnvelope`, `forceCloseEnvelope` and `openEnvelope` (any method). Afterwards `grep -c "revert NotBuilt" src/vault/VaultStubs.sol` prints `21`.
2. Replace `src/CzarVault.sol` with:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICzarVault} from "./interfaces/ICzarVault.sol";
import {VaultBase} from "./vault/VaultBase.sol";
import {VaultStubs} from "./vault/VaultStubs.sol";
import {CoreLogic} from "./vault/logic/CoreLogic.sol";
import {EnvelopeLogic} from "./vault/logic/EnvelopeLogic.sol";

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
}
```
- `openEnvelope` takes `calldata` in the wrapper and `memory` in the library, so PRD 10's passkey path can pass a decoded struct. `nonReentrant` on `openEnvelope` only: it reads USDC (`czar-vault.md` §15.5); the two close functions make no external call.

## 6. `test/helpers/CzarVaultHarness.sol` (replace the whole file)
- Adds three **test-only** setters. Each writes exactly the fields that a later function will write, so envelope tests can cover busy envelopes and force-close with a pocket or a job now:
  - `exposed_setOpenReservations`: stands in for open reservations (PRD 06).
  - `exposed_simulateFundedPocket`: the accounting of `registerPocket` + `fundPocket` (`czar-vault.md` §5.4).
  - `exposed_simulateOpenedJob`: the accounting of `openJob` (§5.5).
- The setters write through `_s` (the harness inherits `CzarVault`, so it sees `_s`). The harness is never deployed outside tests; these setters change no vault code.
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {CzarVault} from "../../src/CzarVault.sol";

/// @title CzarVaultHarness
/// @notice Test-only subclass that exposes internal values for vector and storage tests (security-and-testing.md
///         §3.3, D88 G-58). Later PRDs add `exposed_*` functions here; it never changes vault behaviour.
contract CzarVaultHarness is CzarVault {
    constructor(address ownerAccount) CzarVault(ownerAccount) {}

    function exposed_usdcDomainSeparator() external view returns (bytes32) {
        return USDC_DOMAIN_SEPARATOR;
    }

    function exposed_slDomainSeparator() external view returns (bytes32) {
        return SL_DOMAIN_SEPARATOR;
    }

    function exposed_vaultDomainSeparator() external view returns (bytes32) {
        return VAULT_DOMAIN_SEPARATOR;
    }

    function exposed_gatewayDomain() external view returns (uint32) {
        return GATEWAY_DOMAIN;
    }

    // ───────────── Test-only state setters (07 PRD 05). They write exactly the fields a later function would
    // write, so envelope tests can run before reservations, pockets and jobs exist. Never used outside tests.

    /// @dev Stands in for open reservations (PRD 06).
    function exposed_setOpenReservations(uint64 envelopeId, uint32 count) external {
        _s.envelopes[envelopeId].openReservations = count;
    }

    /// @dev Mirrors registerPocket + fundPocket accounting (czar-vault.md §5.4) for one pocket.
    function exposed_simulateFundedPocket(uint64 envelopeId, address pocket, uint256 amount) external {
        Envelope storage e = _s.envelopes[envelopeId];
        _s.pockets[pocket] = Pocket({
            envelopeId: envelopeId,
            state: PocketState.Funded,
            funded: amount,
            gasGranted: 0,
            outstanding: amount,
            pendingPullback: 0
        });
        e.pocket = pocket;
        e.openPockets = 1;
        e.pocketOutstanding += amount;
        _s.committedTotal -= amount;
    }

    /// @dev Mirrors openJob accounting (czar-vault.md §5.5) for one unfunded job.
    function exposed_simulateOpenedJob(uint64 envelopeId, uint32 stepIndex, bytes32 jobKey, uint256 reservedCap)
        external
    {
        Envelope storage e = _s.envelopes[envelopeId];
        e.reserved += reservedCap;
        _s.stepUsed[envelopeId][stepIndex] += reservedCap;
        e.openJobs += 1;
        _s.jobs[jobKey].envelopeId = envelopeId;
        _s.jobs[jobKey].stepIndex = stepIndex;
        _s.jobs[jobKey].state = JobState.Opened;
        _s.jobs[jobKey].reservedCap = reservedCap;
    }
}
```

## 7. `src/vault/logic/EnvelopeLogic.sol`

### 7.1 Header
- `// SPDX-License-Identifier: MIT`, `pragma solidity 0.8.30;`
- Imports, exactly:
  - `{SafeCast}` from `@openzeppelin/contracts/utils/math/SafeCast.sol`
  - `{ICzarVault}` from `../../interfaces/ICzarVault.sol`
  - `{VaultState, VaultConfig}` from `../VaultState.sol`
  - `{VaultGuards}` from `../VaultGuards.sol`
  - `{SatMath}` from `../../libraries/SatMath.sol`
  - `{MAX_ENVELOPE_DURATION, MAX_POCKET_CAP_BPS, MAX_AGENT_POCKET_CAP_BPS, PERIOD_LENGTH, FORCE_CLOSE_DELAY}` from `../../libraries/CzarConstants.sol`
- `/// @title EnvelopeLogic`, a `/// @notice` citing `czar-vault.md` §5.2 and T-014.
- `library EnvelopeLogic { … }`; each function has one `/// @notice` line citing its spec section. Rules: 00-conventions §3.2.

### 7.2 `openEnvelope(VaultState storage s, VaultConfig memory c, address caller, ICzarVault.OpenEnvelopeParams memory p) external returns (uint64 envelopeId)`
Steps in this order:
1. `VaultGuards.requireOwnerOrAgent(s, c, caller);` and `bool byOwner = caller == c.owner;`
2. `VaultGuards.requireNotPausedOrFrozen(s, c);` (`FrozenVault`, then `Paused`)
3. `if (p.expiresAt <= block.timestamp || p.expiresAt > block.timestamp + MAX_ENVELOPE_DURATION) revert ICzarVault.BadParams();`
4. `if (p.cap == 0 || p.maxStepAmount > p.cap || p.payeeRoot == bytes32(0)) revert ICzarVault.BadParams();`
5. `if (p.pocketCapBps > (byOwner ? MAX_POCKET_CAP_BPS : MAX_AGENT_POCKET_CAP_BPS)) revert ICzarVault.BadParams();` (D71, RV-003)
6. `uint64 periodId = SafeCast.toUint64(block.timestamp / PERIOD_LENGTH);` and `ICzarVault.CategoryLimits storage l = s.limits[p.categoryId];`
7. **Agent only — the allowance check, before the balance check:**
   - `uint256 used = l.periodId == periodId ? l.usedInPeriod : 0;` (a new period starts at 0)
   - `uint256 remaining = SatMath.sat(l.autoLimit, used);` (saturating: never a panic, RV-008)
   - `if (p.cap > remaining) revert ICzarVault.AllowanceExceeded(p.categoryId, remaining, p.cap);`
8. `uint256 free = VaultGuards.freeBalance(s, c); if (p.cap > free) revert ICzarVault.InsufficientFree(free, p.cap);`
9. **Effects, agent only:** if `l.periodId != periodId`: `l.periodId = periodId; l.usedInPeriod = 0;` then `l.usedInPeriod += p.cap;` (no write happens before every check has passed)
10. `envelopeId = ++s.envelopeCount;` (ids start at 1, §15.6)
11. `ICzarVault.Envelope storage e = s.envelopes[envelopeId];` then set, in this order: `cap`, `maxStepAmount`, `categoryId`, `objectiveHash`, `planHash`, `payeeRoot`, `expiresAt`, `pocketCapBps` from `p`; `e.state = ICzarVault.EnvelopeState.Open;` `e.approverIsOwner = byOwner;` Every other field stays 0.
12. `s.committedTotal += p.cap;` ("fund on approval" is accounting only; no transfer)
13. `emit ICzarVault.EnvelopeOpened(envelopeId, p.categoryId, p.objectiveHash, p.cap, p.planHash, p.payeeRoot, p.maxStepAmount, p.pocketCapBps, p.expiresAt, byOwner);`
- The owner path never reads or writes `usedInPeriod`; `userMax` does not bound the owner (§15.10).

### 7.3 `closeEnvelope(VaultState storage s, VaultConfig memory c, address caller, uint64 envelopeId) external`
1. `ICzarVault.Envelope storage e = s.envelopes[envelopeId];`
2. `if (caller != c.owner && caller != s.agentSigner && block.timestamp < e.expiresAt) revert ICzarVault.NotAuthorized();` (anyone at or after `expiresAt`; §15.1, §15.7)
3. `if (e.state != ICzarVault.EnvelopeState.Open) revert ICzarVault.EnvelopeNotOpen();` (also an unknown id)
4. `if (e.openReservations != 0 || e.openPockets != 0 || e.openJobs != 0) revert ICzarVault.EnvelopeBusy(e.openReservations, e.openPockets, e.openJobs);`
5. `uint256 released = e.cap - e.spent - e.pocketOutstanding - e.jobEscrowed - e.shortfall;` (plain `-`: INV-1 guarantees no underflow)
6. `e.state = ICzarVault.EnvelopeState.Closed; s.committedTotal -= released;`
7. `emit ICzarVault.EnvelopeClosed(envelopeId, e.spent, released);`

### 7.4 `forceCloseEnvelope(VaultState storage s, VaultConfig memory c, address caller, uint64 envelopeId) external`
(`czar-vault.md` §5.2, RV-005)
1. `VaultGuards.requireOwner(c, caller);`
2. `ICzarVault.Envelope storage e = s.envelopes[envelopeId]; if (e.state != ICzarVault.EnvelopeState.Open) revert ICzarVault.EnvelopeNotOpen();`
3. `if (block.timestamp < uint256(e.expiresAt) + FORCE_CLOSE_DELAY) revert ICzarVault.NotExpired();`
4. `if (e.openReservations != 0) revert ICzarVault.EnvelopeBusy(e.openReservations, e.openPockets, e.openJobs);`
5. **Pocket:** `uint256 writtenOff = 0; address pocket = e.pocket;` If `pocket != address(0) && s.pockets[pocket].state != ICzarVault.PocketState.Closed`:
   - `ICzarVault.Pocket storage k = s.pockets[pocket]; writtenOff = k.outstanding;`
   - `e.spent += writtenOff; e.pocketOutstanding -= writtenOff;`
   - `k.outstanding = 0; k.state = ICzarVault.PocketState.Closed; e.openPockets = 0;`
   - `emit ICzarVault.PocketClosed(pocket, writtenOff);` (the pocket's `pendingPullback` stays: INV-7 as restated by D88)
6. **Jobs:** `e.openJobs = 0;` (jobs in `Opened` keep their state; their `reservedCap` is released by the next line; `stepUsed` is not touched, INV-12 holds for open envelopes only)
7. `e.reserved = 0;`
8. `uint256 released = e.cap - e.spent - e.pocketOutstanding - e.jobEscrowed - e.shortfall;`
9. `e.state = ICzarVault.EnvelopeState.Closed; s.committedTotal -= released;`
10. `emit ICzarVault.EnvelopeForceClosed(envelopeId, e.spent, released, writtenOff);`

### 7.5 Order in the file
`openEnvelope`, `closeEnvelope`, `forceCloseEnvelope`.

## 8. `test/EnvelopeTest.t.sol`
- 28 tests: the owner path, the agent allowance (within, above, checked before the balance, period roll), every `BadParams` case, freeze and pause, close by each caller class, `EnvelopeNotOpen`, `EnvelopeBusy`, force-close timing and roles, force-close with a funded pocket (RV-005 named test) and with an opened job, the RV-003 and RV-008 named tests, and a fuzz test of INV-2 over open and close.
- Tests that need a busy envelope, a pocket or a job use `hv`, a `CzarVaultHarness` deployed in `setUp()`.
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICzarVault} from "../src/interfaces/ICzarVault.sol";
import {MAX_ENVELOPE_DURATION, PERIOD_LENGTH, FORCE_CLOSE_DELAY} from "../src/libraries/CzarConstants.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";
import {CzarVaultHarness} from "./helpers/CzarVaultHarness.sol";

/// @dev 07 PRD 05 (T-014). czar-vault.md §5.2, §5.6 (allowance period), §8.1, §15; INV-1, INV-2, INV-9, INV-14.
contract EnvelopeTest is VaultTestBase {
    bytes32 internal constant CATEGORY = keccak256("category.research");
    bytes32 internal constant ROOT = keccak256("payeeRoot");
    uint64 internal constant LIFETIME = 1 days;

    CzarVaultHarness internal hv; // harness vault: same code plus test-only setters

    function setUp() public override {
        super.setUp();
        hv = CzarVaultHarness(
            payable(vaultFactory.deployCode(abi.encodePacked(type(CzarVaultHarness).creationCode, abi.encode(owner))))
        );
    }

    function _params(uint256 cap) internal view returns (ICzarVault.OpenEnvelopeParams memory p) {
        p.cap = cap;
        p.maxStepAmount = cap;
        p.pocketCapBps = 0;
        p.expiresAt = uint64(block.timestamp + LIFETIME);
        p.categoryId = CATEGORY;
        p.objectiveHash = keccak256("objective");
        p.planHash = keccak256("plan");
        p.payeeRoot = ROOT;
    }

    function _openAs(address caller, ICzarVault.OpenEnvelopeParams memory p) internal returns (uint64 id) {
        vm.prank(caller);
        id = vault.openEnvelope(p);
    }

    function _setLimits(uint256 userMax, uint256 autoLimit) internal {
        vm.prank(owner);
        vault.setCategoryLimits(CATEGORY, userMax, autoLimit);
    }

    /// @dev INV-2 for one open envelope.
    function _assertCommitted(ICzarVault v, uint64 id) internal view {
        ICzarVault.Envelope memory e = v.getEnvelope(id);
        uint256 expected = e.state == ICzarVault.EnvelopeState.Open
            ? e.cap - e.spent - e.pocketOutstanding - e.jobEscrowed - e.shortfall
            : 0;
        assertEq(v.committedTotal(), expected);
    }

    // ───────────── openEnvelope: owner ─────────────

    function test_openEnvelope_owner_storesAndCommits() public {
        _fundVault(10 * ONE_USDC);
        ICzarVault.OpenEnvelopeParams memory p = _params(4 * ONE_USDC);
        p.maxStepAmount = ONE_USDC;
        p.pocketCapBps = 5000; // owner may use up to MAX_POCKET_CAP_BPS
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.EnvelopeOpened(
            1, CATEGORY, p.objectiveHash, p.cap, p.planHash, ROOT, p.maxStepAmount, 5000, p.expiresAt, true
        );
        uint64 id = _openAs(owner, p);
        assertEq(id, 1);
        assertEq(vault.envelopeCount(), 1);
        ICzarVault.Envelope memory e = vault.getEnvelope(id);
        assertEq(e.cap, p.cap);
        assertEq(e.maxStepAmount, ONE_USDC);
        assertEq(e.pocketCapBps, 5000);
        assertEq(e.expiresAt, p.expiresAt);
        assertEq(e.categoryId, CATEGORY);
        assertEq(e.objectiveHash, p.objectiveHash);
        assertEq(e.planHash, p.planHash);
        assertEq(e.payeeRoot, ROOT);
        assertEq(uint8(e.state), uint8(ICzarVault.EnvelopeState.Open));
        assertTrue(e.approverIsOwner);
        assertEq(vault.committedTotal(), 4 * ONE_USDC);
        assertEq(vault.freeBalance(), 6 * ONE_USDC);
        assertEq(vault.getLimits(CATEGORY).usedInPeriod, 0); // the owner does not use the agent's allowance
    }

    function test_openEnvelope_idsIncreaseFromOne() public {
        _fundVault(10 * ONE_USDC);
        assertEq(_openAs(owner, _params(ONE_USDC)), 1);
        assertEq(_openAs(owner, _params(ONE_USDC)), 2);
    }

    function test_openEnvelope_capAboveFree_revertsInsufficientFree() public {
        _fundVault(ONE_USDC);
        ICzarVault.OpenEnvelopeParams memory p = _params(ONE_USDC + 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.InsufficientFree.selector, ONE_USDC, ONE_USDC + 1));
        vault.openEnvelope(p);
    }

    function test_openEnvelope_ownerPocketCapAbove5000_reverts() public {
        _fundVault(ONE_USDC);
        ICzarVault.OpenEnvelopeParams memory p = _params(ONE_USDC);
        p.pocketCapBps = 5001;
        vm.prank(owner);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.openEnvelope(p);
    }

    function test_openEnvelope_badParams_revert() public {
        _fundVault(10 * ONE_USDC);
        ICzarVault.OpenEnvelopeParams[5] memory bad;
        for (uint256 i = 0; i < 5; i++) {
            bad[i] = _params(ONE_USDC);
        }
        bad[0].cap = 0;
        bad[1].maxStepAmount = ONE_USDC + 1;
        bad[2].payeeRoot = bytes32(0);
        bad[3].expiresAt = uint64(block.timestamp);
        bad[4].expiresAt = uint64(block.timestamp + MAX_ENVELOPE_DURATION + 1);
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(owner);
            vm.expectRevert(ICzarVault.BadParams.selector);
            vault.openEnvelope(bad[i]);
        }
    }

    function test_openEnvelope_maxDurationAllowed() public {
        _fundVault(ONE_USDC);
        ICzarVault.OpenEnvelopeParams memory p = _params(ONE_USDC);
        p.expiresAt = uint64(block.timestamp + MAX_ENVELOPE_DURATION);
        assertEq(_openAs(owner, p), 1);
    }

    function test_openEnvelope_stranger_revertsNotAuthorized() public {
        _fundVault(ONE_USDC);
        ICzarVault.OpenEnvelopeParams memory p = _params(ONE_USDC);
        vm.prank(stranger);
        vm.expectRevert(ICzarVault.NotAuthorized.selector);
        vault.openEnvelope(p);
    }

    function test_openEnvelope_frozen_reverts() public {
        _fundVault(ONE_USDC);
        vm.prank(owner);
        vault.freeze();
        ICzarVault.OpenEnvelopeParams memory p = _params(ONE_USDC);
        vm.prank(owner);
        vm.expectRevert(ICzarVault.FrozenVault.selector);
        vault.openEnvelope(p);
    }

    function test_openEnvelope_paused_reverts() public {
        _fundVault(ONE_USDC);
        vaultFactory.setGuardianPaused(true);
        ICzarVault.OpenEnvelopeParams memory p = _params(ONE_USDC);
        vm.prank(owner);
        vm.expectRevert(ICzarVault.Paused.selector);
        vault.openEnvelope(p);
    }

    // ───────────── openEnvelope: agent allowance ─────────────

    function test_openEnvelope_agentWithinAllowance_usesAllowance() public {
        _fundVault(10 * ONE_USDC);
        _setLimits(10 * ONE_USDC, 3 * ONE_USDC);
        uint64 id = _openAs(agent, _params(2 * ONE_USDC));
        assertFalse(vault.getEnvelope(id).approverIsOwner);
        ICzarVault.CategoryLimits memory l = vault.getLimits(CATEGORY);
        assertEq(l.usedInPeriod, 2 * ONE_USDC);
        assertEq(l.periodId, block.timestamp / PERIOD_LENGTH);
    }

    function test_openEnvelope_agentAboveAllowance_revertsAllowanceExceeded() public {
        _fundVault(10 * ONE_USDC);
        _setLimits(10 * ONE_USDC, 3 * ONE_USDC);
        _openAs(agent, _params(2 * ONE_USDC));
        ICzarVault.OpenEnvelopeParams memory p = _params(2 * ONE_USDC);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.AllowanceExceeded.selector, CATEGORY, ONE_USDC, 2 * ONE_USDC));
        vault.openEnvelope(p);
    }

    function test_openEnvelope_agentAllowanceCheckedBeforeFreeBalance() public {
        _setLimits(10 * ONE_USDC, ONE_USDC); // vault is empty
        ICzarVault.OpenEnvelopeParams memory p = _params(2 * ONE_USDC);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.AllowanceExceeded.selector, CATEGORY, ONE_USDC, 2 * ONE_USDC));
        vault.openEnvelope(p);
    }

    function test_openEnvelope_agentPeriodRoll_resetsUsed() public {
        _fundVault(10 * ONE_USDC);
        _setLimits(10 * ONE_USDC, 3 * ONE_USDC);
        _openAs(agent, _params(3 * ONE_USDC));
        vm.warp((block.timestamp / PERIOD_LENGTH + 1) * PERIOD_LENGTH); // first second of the next period
        _openAs(agent, _params(3 * ONE_USDC));
        ICzarVault.CategoryLimits memory l = vault.getLimits(CATEGORY);
        assertEq(l.usedInPeriod, 3 * ONE_USDC);
        assertEq(l.periodId, block.timestamp / PERIOD_LENGTH);
    }

    /// @dev RV-003 named test.
    function test_openEnvelope_agentPocketCapAbove2500_reverts() public {
        _fundVault(10 * ONE_USDC);
        _setLimits(10 * ONE_USDC, 10 * ONE_USDC);
        ICzarVault.OpenEnvelopeParams memory p = _params(ONE_USDC);
        p.pocketCapBps = 2501;
        vm.prank(agent);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.openEnvelope(p);
        p.pocketCapBps = 2500;
        _openAs(agent, p);
        p.pocketCapBps = 5000;
        _openAs(owner, p); // owner may use up to 5000
    }

    /// @dev RV-008 named test: usedInPeriod = 8, autoLimit lowered to 0 → AllowanceExceeded(c, 0, cap), never a panic.
    function test_lowerBelowUsed_openEnvelopeRevertsAllowanceExceeded() public {
        _fundVault(20 * ONE_USDC);
        _setLimits(10 * ONE_USDC, 8 * ONE_USDC);
        _openAs(agent, _params(8 * ONE_USDC));
        _setLimits(10 * ONE_USDC, 0);
        ICzarVault.OpenEnvelopeParams memory p = _params(ONE_USDC);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.AllowanceExceeded.selector, CATEGORY, 0, ONE_USDC));
        vault.openEnvelope(p);
    }

    // ───────────── closeEnvelope ─────────────

    function test_closeEnvelope_ownerReleasesCap() public {
        _fundVault(5 * ONE_USDC);
        uint64 id = _openAs(owner, _params(3 * ONE_USDC));
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.EnvelopeClosed(id, 0, 3 * ONE_USDC);
        vm.prank(owner);
        vault.closeEnvelope(id);
        assertEq(uint8(vault.getEnvelope(id).state), uint8(ICzarVault.EnvelopeState.Closed));
        assertEq(vault.committedTotal(), 0);
        assertEq(vault.freeBalance(), 5 * ONE_USDC);
    }

    function test_closeEnvelope_agentBeforeExpiry() public {
        _fundVault(ONE_USDC);
        uint64 id = _openAs(owner, _params(ONE_USDC));
        vm.prank(agent);
        vault.closeEnvelope(id);
        assertEq(uint8(vault.getEnvelope(id).state), uint8(ICzarVault.EnvelopeState.Closed));
    }

    function test_closeEnvelope_strangerBeforeExpiry_reverts() public {
        _fundVault(ONE_USDC);
        uint64 id = _openAs(owner, _params(ONE_USDC));
        vm.prank(stranger);
        vm.expectRevert(ICzarVault.NotAuthorized.selector);
        vault.closeEnvelope(id);
    }

    function test_closeEnvelope_strangerAtExpiry_allowed() public {
        _fundVault(ONE_USDC);
        uint64 id = _openAs(owner, _params(ONE_USDC));
        vm.warp(vault.getEnvelope(id).expiresAt);
        vm.prank(stranger);
        vault.closeEnvelope(id);
        assertEq(vault.committedTotal(), 0);
    }

    function test_closeEnvelope_notOpen_reverts() public {
        _fundVault(ONE_USDC);
        uint64 id = _openAs(owner, _params(ONE_USDC));
        vm.prank(owner);
        vault.closeEnvelope(id);
        vm.prank(owner);
        vm.expectRevert(ICzarVault.EnvelopeNotOpen.selector);
        vault.closeEnvelope(id);
        vm.prank(owner);
        vm.expectRevert(ICzarVault.EnvelopeNotOpen.selector);
        vault.closeEnvelope(99); // unknown id
    }

    function test_closeEnvelope_busy_revertsEnvelopeBusy() public {
        usdc.mint(address(hv), 5 * ONE_USDC);
        vm.prank(owner);
        uint64 id = hv.openEnvelope(_params(3 * ONE_USDC));
        hv.exposed_setOpenReservations(id, 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.EnvelopeBusy.selector, 1, 0, 0));
        hv.closeEnvelope(id);
        hv.exposed_setOpenReservations(id, 0);
        hv.exposed_simulateOpenedJob(id, 0, keccak256("job"), ONE_USDC);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.EnvelopeBusy.selector, 0, 0, 1));
        hv.closeEnvelope(id);
    }

    // ───────────── forceCloseEnvelope ─────────────

    function test_forceClose_beforeDelay_revertsNotExpired() public {
        _fundVault(ONE_USDC);
        uint64 id = _openAs(owner, _params(ONE_USDC));
        vm.warp(uint256(vault.getEnvelope(id).expiresAt) + FORCE_CLOSE_DELAY - 1);
        vm.prank(owner);
        vm.expectRevert(ICzarVault.NotExpired.selector);
        vault.forceCloseEnvelope(id);
    }

    function test_forceClose_notOwner_reverts() public {
        _fundVault(ONE_USDC);
        uint64 id = _openAs(owner, _params(ONE_USDC));
        vm.warp(uint256(vault.getEnvelope(id).expiresAt) + FORCE_CLOSE_DELAY);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.NotOwner.selector);
        vault.forceCloseEnvelope(id);
    }

    function test_forceClose_openReservations_revertsEnvelopeBusy() public {
        usdc.mint(address(hv), ONE_USDC);
        vm.prank(owner);
        uint64 id = hv.openEnvelope(_params(ONE_USDC));
        hv.exposed_setOpenReservations(id, 2);
        vm.warp(uint256(hv.getEnvelope(id).expiresAt) + FORCE_CLOSE_DELAY);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.EnvelopeBusy.selector, 2, 0, 0));
        hv.forceCloseEnvelope(id);
    }

    function test_forceClose_emptyEnvelope_releasesCap() public {
        _fundVault(ONE_USDC);
        uint64 id = _openAs(owner, _params(ONE_USDC));
        vm.warp(uint256(vault.getEnvelope(id).expiresAt) + FORCE_CLOSE_DELAY);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.EnvelopeForceClosed(id, 0, ONE_USDC, 0);
        vm.prank(owner);
        vault.forceCloseEnvelope(id);
        assertEq(vault.committedTotal(), 0);
    }

    /// @dev RV-005 named test (envelope side; PRD 08 repeats it with a real fundPocket).
    function test_forceClose_fundedPocket_closesPocketAndReleasesAll() public {
        address pocket = makeAddr("pocket");
        usdc.mint(address(hv), 10 * ONE_USDC);
        ICzarVault.OpenEnvelopeParams memory p = _params(4 * ONE_USDC);
        p.pocketCapBps = 2500;
        vm.prank(owner);
        uint64 id = hv.openEnvelope(p);
        hv.exposed_simulateFundedPocket(id, pocket, ONE_USDC);
        vm.prank(address(hv));
        usdc.transfer(address(gatewayWallet), ONE_USDC); // the deposit left the vault
        _assertCommitted(hv, id);

        vm.warp(uint256(p.expiresAt) + FORCE_CLOSE_DELAY);
        vm.expectEmit(true, true, true, true, address(hv));
        emit ICzarVault.PocketClosed(pocket, ONE_USDC);
        vm.expectEmit(true, true, true, true, address(hv));
        emit ICzarVault.EnvelopeForceClosed(id, ONE_USDC, 3 * ONE_USDC, ONE_USDC);
        vm.prank(owner);
        hv.forceCloseEnvelope(id);

        ICzarVault.Envelope memory e = hv.getEnvelope(id);
        assertEq(uint8(e.state), uint8(ICzarVault.EnvelopeState.Closed));
        assertEq(e.pocketOutstanding, 0);
        assertEq(e.spent, ONE_USDC); // written off counts as spent
        assertEq(e.openPockets, 0);
        ICzarVault.Pocket memory k = hv.getPocket(pocket);
        assertEq(uint8(k.state), uint8(ICzarVault.PocketState.Closed));
        assertEq(k.outstanding, 0);
        assertEq(hv.committedTotal(), 0); // INV-2 after close
        assertEq(hv.freeBalance(), 9 * ONE_USDC);
    }

    function test_forceClose_openedJob_releasesReservedCap() public {
        usdc.mint(address(hv), 5 * ONE_USDC);
        vm.prank(owner);
        uint64 id = hv.openEnvelope(_params(4 * ONE_USDC));
        bytes32 jobKey = keccak256("job");
        hv.exposed_simulateOpenedJob(id, 2, jobKey, ONE_USDC);
        vm.warp(uint256(hv.getEnvelope(id).expiresAt) + FORCE_CLOSE_DELAY);
        vm.prank(owner);
        hv.forceCloseEnvelope(id);
        ICzarVault.Envelope memory e = hv.getEnvelope(id);
        assertEq(e.reserved, 0);
        assertEq(e.openJobs, 0);
        assertEq(uint8(hv.getJob(jobKey).state), uint8(ICzarVault.JobState.Opened)); // stays Opened (§5.2 step 2)
        assertEq(hv.committedTotal(), 0);
    }

    // ───────────── Fuzz: INV-1 and INV-2 for open and close ─────────────

    function testFuzz_openClose_committedMatches(uint256 a, uint256 b) public {
        a = bound(a, 1, 50 * ONE_USDC);
        b = bound(b, 1, 50 * ONE_USDC);
        _fundVault(a + b);
        uint64 x = _openAs(owner, _params(a));
        uint64 y = _openAs(owner, _params(b));
        assertEq(vault.committedTotal(), a + b);
        assertEq(vault.freeBalance(), 0);
        vm.prank(owner);
        vault.closeEnvelope(x);
        assertEq(vault.committedTotal(), b);
        vm.prank(owner);
        vault.closeEnvelope(y);
        assertEq(vault.committedTotal(), 0);
        assertEq(vault.freeBalance(), a + b);
    }
}
```

## 9. Build steps (tests first)
1. Replace `test/helpers/CzarVaultHarness.sol` (§6) and create `test/EnvelopeTest.t.sol` (§8).
2. Run `FOUNDRY_PROFILE=arc arc-forge test --match-path test/EnvelopeTest.t.sol`. Expected: `0 passed; 28 failed`, every failure mentioning `NotBuilt()`. Paste the summary line into your report.
3. Write `src/vault/logic/EnvelopeLogic.sol` from §7.
4. Do §5 (delete the 3 stubs, replace `CzarVault.sol`).
5. Run the test file again: 28 passed.
6. `arc-forge fmt src/vault/logic/EnvelopeLogic.sol src/vault/VaultStubs.sol`, then `arc-forge fmt --check` on those two files plus `src/CzarVault.sol`, `test/helpers/CzarVaultHarness.sol` and `test/EnvelopeTest.t.sol`: nothing printed apart from the flag notice.
7. Run the clean gate build and the full suite (00-conventions §2.2).

## 10. Definition of done
- `FOUNDRY_PROFILE=arc arc-forge test --match-contract EnvelopeTest` → 28 passed, 0 failed (T-014 acceptance command; it includes `AllowanceExceeded`, `InsufficientFree`, `EnvelopeBusy`, `FrozenVault`, `Paused` and the RV-003, RV-005 and RV-008 named tests).
- `FOUNDRY_PROFILE=arc arc-forge test` → 171 passed, 0 failed.
- `rm -rf out cache && FOUNDRY_PROFILE=arc arc-forge build --deny-warnings --sizes` → no warnings; `CzarVault` runtime about 10,584 B and `EnvelopeLogic` about 3,985 B (more than 300 B off means your code differs from §5 or §7).
- `grep -c "revert NotBuilt" src/vault/VaultStubs.sol` → 21.
- `diff -r src/interfaces ../docs/specs/03-smart-contracts/interfaces` → nothing.
- The T-014 row of `security-and-testing.md` §3.7 also names `test_abi_matchesICzarVaultSol`; it needs every function, so PRD 12 builds it.

## 11. Stop conditions
- A test fails after you have compared the function with its numbered steps in §7: stop and report the test name and failure line. Never change a test or the harness.
- The order of checks in §7 seems to contradict `czar-vault.md` §15.3: stop and file an SCR quoting both.

## Change log
| Date | Change |
|---|---|
| 2026-10-20 | First version, verified on Arc Foundry v0.8.0-2 against a reference implementation. |
| 2026-10-20 | D89: the logic moves from the `VaultEnvelopes` module into the linked library `EnvelopeLogic`; harness setters write through `_s`; new `CzarVault.sol`; 21 stubs after; sizes re-measured. The test file is unchanged. |
