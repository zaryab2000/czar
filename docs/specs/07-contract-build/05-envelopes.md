# 05 — Envelopes

## 1. Scope
- **Task:** T-014 (envelopes: `openEnvelope` with the owner path and the agent allowance, `closeEnvelope`, `forceCloseEnvelope`).
- **You build:** `contracts/src/vault/VaultEnvelopes.sol` (3 interface functions), test-only setters in `CzarVaultHarness`, and `contracts/test/EnvelopeTest.t.sol`. You delete 3 stubs and point `CzarVault` at the new module.
- **You do not build:** reservations, pockets or jobs. Tests that need an open reservation, a funded pocket or an opened job create that state with the harness setters in §6 (PRDs 06, 08 and 09 later repeat the important cases with the real functions).
- **Dependencies:** PRD 04 done (141 tests, `VaultCoreTest` 36 passed).

## 2. This PRD is already verified
- A reference `VaultEnvelopes` written from §7 passed on **Arc Foundry v0.8.0-2** with `FOUNDRY_PROFILE=arc`: `--deny-warnings` build clean (compiler and lint), `fmt --check` clean, 169 tests passed (141 earlier plus 28 here).
- Sizes after this PRD: `CzarVault` runtime 12,919 B, initcode 14,601 B; `CzarVaultFactory` runtime 19,115 B.
- The test file (§8) and the harness (§6) are printed in full: copy them exactly.

## 3. Sources (read these, nothing else)
- `07-contract-build/00-conventions.md` (§3 module chain and stubs, §4 style, §5 tests, §5.6 traps).
- `07-contract-build/04-vault-core.md` §5 (the external/internal pair rule; it applies here unchanged).
- `docs/specs/03-smart-contracts/czar-vault.md`: §5.2 (the three functions), §5.6 (allowance and period), §8.1 (state machine), §11 INV-1, INV-2, INV-9, INV-14, §15.1–§15.3, §15.5, §15.7.
- `docs/specs/03-smart-contracts/interfaces/ICzarVault.sol` (`OpenEnvelopeParams`, `Envelope`, events, errors).
- `docs/specs/03-smart-contracts/security-and-testing.md` §3.7 rows RV-003, RV-005, RV-008.

## 4. Files
| File | Action | Section |
|---|---|---|
| `contracts/test/helpers/CzarVaultHarness.sol` | replace | §6 |
| `contracts/test/EnvelopeTest.t.sol` | create | §8 |
| `contracts/src/vault/VaultEnvelopes.sol` | create | §7 |
| `contracts/src/vault/VaultStubs.sol` | delete 3 stubs | §5 |
| `contracts/src/CzarVault.sol` | replace | §5 |

## 5. Wire the module in
1. In `VaultStubs.sol`, delete the whole stub of `closeEnvelope`, `forceCloseEnvelope` and `openEnvelope` (any method). Afterwards `grep -c "revert NotBuilt" src/vault/VaultStubs.sol` prints `22`.
2. Replace `src/CzarVault.sol` with (the module chain, 00-conventions §3: `CzarVault` names only the newest module):
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VaultStorage} from "./vault/VaultStorage.sol";
import {VaultEnvelopes} from "./vault/VaultEnvelopes.sol";
import {VaultStubs} from "./vault/VaultStubs.sol";

/// @title CzarVault
/// @notice The per-user vault (czar-vault.md). Immutable; no proxy (D33). The only concrete vault contract: it
///         inherits every vault module. Each later PRD adds its module to this list and removes its stubs.
contract CzarVault is VaultEnvelopes, VaultStubs {
    /// @dev czar-vault.md §15.8. Called by CzarVaultFactory.createVault through CREATE2.
    constructor(address ownerAccount) VaultStorage(ownerAccount) {}
}
```

## 6. `test/helpers/CzarVaultHarness.sol` (replace the whole file)
- Adds three **test-only** setters. Each writes exactly the fields that a later function will write, so envelope tests can cover busy envelopes and force-close with a pocket or a job now:
  - `exposed_setOpenReservations`: stands in for open reservations (PRD 06).
  - `exposed_simulateFundedPocket`: the accounting of `registerPocket` + `fundPocket` (`czar-vault.md` §5.4).
  - `exposed_simulateOpenedJob`: the accounting of `openJob` (§5.5).
- The harness is never deployed outside tests; these setters change no vault code.
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
        envelopes[envelopeId].openReservations = count;
    }

    /// @dev Mirrors registerPocket + fundPocket accounting (czar-vault.md §5.4) for one pocket.
    function exposed_simulateFundedPocket(uint64 envelopeId, address pocket, uint256 amount) external {
        Envelope storage e = envelopes[envelopeId];
        pockets[pocket] = Pocket({
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
        committedTotal -= amount;
    }

    /// @dev Mirrors openJob accounting (czar-vault.md §5.5) for one unfunded job.
    function exposed_simulateOpenedJob(uint64 envelopeId, uint32 stepIndex, bytes32 jobKey, uint256 reservedCap)
        external
    {
        Envelope storage e = envelopes[envelopeId];
        e.reserved += reservedCap;
        _stepUsed[envelopeId][stepIndex] += reservedCap;
        e.openJobs += 1;
        jobs[jobKey].envelopeId = envelopeId;
        jobs[jobKey].stepIndex = stepIndex;
        jobs[jobKey].state = JobState.Opened;
        jobs[jobKey].reservedCap = reservedCap;
    }
}
```

## 7. `src/vault/VaultEnvelopes.sol`

### 7.1 Header
- `// SPDX-License-Identifier: MIT`, `pragma solidity 0.8.30;`
- Imports, exactly:
  - `{SafeCast}` from `@openzeppelin/contracts/utils/math/SafeCast.sol`
  - `{ICzarVault}` from `../interfaces/ICzarVault.sol`
  - `{VaultCore}` from `./VaultCore.sol`
  - `{SatMath}` from `../libraries/SatMath.sol`
  - `{MAX_ENVELOPE_DURATION, MAX_POCKET_CAP_BPS, PERIOD_LENGTH, FORCE_CLOSE_DELAY}` from `../libraries/CzarConstants.sol`
- `/// @title VaultEnvelopes`, a `/// @notice` citing `czar-vault.md` §5.2 and T-014.
- `abstract contract VaultEnvelopes is VaultCore { … }` (it calls `freeBalance()` from `VaultCore`).
- `MAX_AGENT_POCKET_CAP_BPS` is already a constant of `VaultStorage`; use it directly, do not import it.
- The external/internal pair rule of PRD 04 §5 applies: each external function calls `_name(msg.sender, …)`; wrapper parameter names are exactly those in `ICzarVault.sol`.

### 7.2 `openEnvelope(OpenEnvelopeParams calldata p) external nonReentrant returns (uint64 envelopeId)`
- Wrapper: `return _openEnvelope(msg.sender, p);` — `nonReentrant` because it reads USDC (`czar-vault.md` §15.5).
- **`_openEnvelope(address caller, OpenEnvelopeParams memory p) internal returns (uint64 envelopeId)`** (`memory`, so PRD 10's passkey path can pass a decoded struct). Steps in this order:
  1. `_requireOwnerOrAgent(caller);` and `bool byOwner = caller == owner;`
  2. `_requireNotPausedOrFrozen();` (`FrozenVault`, then `Paused`)
  3. `if (p.expiresAt <= block.timestamp || p.expiresAt > block.timestamp + MAX_ENVELOPE_DURATION) revert BadParams();`
  4. `if (p.cap == 0 || p.maxStepAmount > p.cap || p.payeeRoot == bytes32(0)) revert BadParams();`
  5. `if (p.pocketCapBps > (byOwner ? MAX_POCKET_CAP_BPS : MAX_AGENT_POCKET_CAP_BPS)) revert BadParams();` (D71, RV-003)
  6. `uint64 periodId = SafeCast.toUint64(block.timestamp / PERIOD_LENGTH);` and `CategoryLimits storage l = limits[p.categoryId];`
  7. **Agent only — the allowance check, before the balance check:**
     - `uint256 used = l.periodId == periodId ? l.usedInPeriod : 0;` (a new period starts at 0)
     - `uint256 remaining = SatMath.sat(l.autoLimit, used);` (saturating: never a panic, RV-008)
     - `if (p.cap > remaining) revert AllowanceExceeded(p.categoryId, remaining, p.cap);`
  8. `uint256 free = freeBalance(); if (p.cap > free) revert InsufficientFree(free, p.cap);`
  9. **Effects, agent only:** if `l.periodId != periodId`: `l.periodId = periodId; l.usedInPeriod = 0;` then `l.usedInPeriod += p.cap;` (no write happens before every check has passed)
  10. `envelopeId = ++envelopeCount;` (ids start at 1, §15.6)
  11. `Envelope storage e = envelopes[envelopeId];` then set, in this order: `cap`, `maxStepAmount`, `categoryId`, `objectiveHash`, `planHash`, `payeeRoot`, `expiresAt`, `pocketCapBps` from `p`; `e.state = EnvelopeState.Open;` `e.approverIsOwner = byOwner;` Every other field stays 0.
  12. `committedTotal += p.cap;` ("fund on approval" is accounting only; no transfer)
  13. `emit EnvelopeOpened(envelopeId, p.categoryId, p.objectiveHash, p.cap, p.planHash, p.payeeRoot, p.maxStepAmount, p.pocketCapBps, p.expiresAt, byOwner);`
- The owner path never reads or writes `usedInPeriod`; `userMax` does not bound the owner (§15.10).

### 7.3 `closeEnvelope(uint64 envelopeId) external`
- Wrapper: `_closeEnvelope(msg.sender, envelopeId);` (no guard: no external call).
- **`_closeEnvelope(address caller, uint64 envelopeId) internal`**:
  1. `Envelope storage e = envelopes[envelopeId];`
  2. `if (caller != owner && caller != agentSigner && block.timestamp < e.expiresAt) revert NotAuthorized();` (anyone at or after `expiresAt`; §15.1, §15.7)
  3. `if (e.state != EnvelopeState.Open) revert EnvelopeNotOpen();` (also an unknown id)
  4. `if (e.openReservations != 0 || e.openPockets != 0 || e.openJobs != 0) revert EnvelopeBusy(e.openReservations, e.openPockets, e.openJobs);`
  5. `uint256 released = e.cap - e.spent - e.pocketOutstanding - e.jobEscrowed - e.shortfall;` (plain `-`: INV-1 guarantees no underflow)
  6. `e.state = EnvelopeState.Closed; committedTotal -= released;`
  7. `emit EnvelopeClosed(envelopeId, e.spent, released);`

### 7.4 `forceCloseEnvelope(uint64 envelopeId) external`
- Wrapper: `_forceCloseEnvelope(msg.sender, envelopeId);` (no guard).
- **`_forceCloseEnvelope(address caller, uint64 envelopeId) internal`** (`czar-vault.md` §5.2, RV-005):
  1. `_requireOwner(caller);`
  2. `Envelope storage e = envelopes[envelopeId]; if (e.state != EnvelopeState.Open) revert EnvelopeNotOpen();`
  3. `if (block.timestamp < uint256(e.expiresAt) + FORCE_CLOSE_DELAY) revert NotExpired();`
  4. `if (e.openReservations != 0) revert EnvelopeBusy(e.openReservations, e.openPockets, e.openJobs);`
  5. **Pocket:** `uint256 writtenOff = 0; address pocket = e.pocket;` If `pocket != address(0) && pockets[pocket].state != PocketState.Closed`:
     - `Pocket storage k = pockets[pocket]; writtenOff = k.outstanding;`
     - `e.spent += writtenOff; e.pocketOutstanding -= writtenOff;`
     - `k.outstanding = 0; k.state = PocketState.Closed; e.openPockets = 0;`
     - `emit PocketClosed(pocket, writtenOff);` (the pocket's `pendingPullback` stays: INV-7 as restated by D88)
  6. **Jobs:** `e.openJobs = 0;` (jobs in `Opened` keep their state; their `reservedCap` is released by the next line; `stepUsed` is not touched, INV-12 holds for open envelopes only)
  7. `e.reserved = 0;`
  8. `uint256 released = e.cap - e.spent - e.pocketOutstanding - e.jobEscrowed - e.shortfall;`
  9. `e.state = EnvelopeState.Closed; committedTotal -= released;`
  10. `emit EnvelopeForceClosed(envelopeId, e.spent, released, writtenOff);`

### 7.5 Order in the file
`openEnvelope`, `_openEnvelope`, `closeEnvelope`, `_closeEnvelope`, `forceCloseEnvelope`, `_forceCloseEnvelope`. External functions: `/// @inheritdoc ICzarVault`; internal: one `/// @dev` line citing the spec section.

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
3. Write `src/vault/VaultEnvelopes.sol` from §7.
4. Do §5 (delete the 3 stubs, replace `CzarVault.sol`).
5. Run the test file again: 28 passed.
6. `arc-forge fmt src/vault/VaultEnvelopes.sol src/vault/VaultStubs.sol`, then `arc-forge fmt --check` on those two files plus `src/CzarVault.sol`, `test/helpers/CzarVaultHarness.sol` and `test/EnvelopeTest.t.sol`: nothing printed apart from the flag notice.
7. Run the full build with sizes and the full suite (00-conventions §2.2).

## 10. Definition of done
- `FOUNDRY_PROFILE=arc arc-forge test --match-contract EnvelopeTest` → 28 passed, 0 failed (T-014 acceptance command; it includes `AllowanceExceeded`, `InsufficientFree`, `EnvelopeBusy`, `FrozenVault`, `Paused` and the RV-003, RV-005 and RV-008 named tests).
- `FOUNDRY_PROFILE=arc arc-forge test` → 169 passed, 0 failed.
- `FOUNDRY_PROFILE=arc arc-forge build --deny-warnings --sizes` → no warnings; `CzarVault` runtime about 12,919 B (more than 300 B off means your code differs from §7).
- `grep -c "revert NotBuilt" src/vault/VaultStubs.sol` → 22.
- `diff -r src/interfaces ../docs/specs/03-smart-contracts/interfaces` → nothing.

## 11. Stop conditions
- A test fails after you have compared the function with its numbered steps in §7: stop and report the test name and failure line. Never change a test or the harness.
- The order of checks in §7 seems to contradict `czar-vault.md` §15.3: stop and file an SCR quoting both.

## Change log
| Date | Change |
|---|---|
| 2026-10-20 | First version, verified on Arc Foundry v0.8.0-2 against a reference implementation. |
