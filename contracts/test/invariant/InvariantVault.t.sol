// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {ICzarVault} from "../../src/interfaces/ICzarVault.sol";
import {ICzarVaultFactory} from "../../src/interfaces/ICzarVaultFactory.sol";
import {CzarHashing, TransferSpecFields} from "../../src/libraries/CzarHashing.sol";
import {PayeeLeaf} from "../../src/libraries/PayeeLeaf.sol";
import {
    USDC_ADDRESS,
    KIND_USDC_3009,
    KIND_GATEWAY_BURN,
    GATEWAY_DOMAIN_SEPARATOR,
    EIP1271_MAGIC,
    EIP1271_INVALID,
    VAULT_NAME_HASH,
    VERSION_1_HASH,
    PAYEE_KIND_X402,
    PAYEE_KIND_JOB,
    PAYEE_KIND_POCKET,
    POCKET_STEP_INDEX,
    PERIOD_LENGTH,
    PULLBACK_CANCEL_DELAY_BLOCKS,
    FORCE_CLOSE_DELAY,
    BPS
} from "../../src/libraries/CzarConstants.sol";
import {MockArcUSDC} from "../mocks/MockArcUSDC.sol";
import {MockGatewayWallet} from "../mocks/MockGatewayWallet.sol";
import {MockGatewayMinter} from "../mocks/MockGatewayMinter.sol";
import {MockCircleAgenticCommerce} from "../mocks/MockCircleAgenticCommerce.sol";
import {MockCzarJobEscrow} from "../mocks/MockCzarJobEscrow.sol";
import {MockVaultFactory} from "../mocks/MockVaultFactory.sol";
import {VaultTestBase} from "../helpers/VaultTestBase.sol";

/// @notice The world the handler acts in: the vault, its mocks, the actors and the mocks' controller.
struct VaultWorld {
    ICzarVault vault;
    MockArcUSDC usdc;
    MockGatewayWallet gatewayWallet;
    MockGatewayMinter gatewayMinter;
    MockVaultFactory factory;
    address escrow;
    bool czarKind;
    address owner;
    address agent;
    address evaluator;
    address controller;
}

/// @notice T-021 (07 PRD 12 §6): drives one vault through random calls by every role (owner, agent, Circle's relayer
///         and Gateway, providers, evaluator, guardian, anyone) and keeps the ghosts the invariants compare against
///         (security-and-testing.md §3.3). Every call is wrapped in try/catch: a revert is a legal outcome, while a
///         call that succeeds against the rules (or fails although every rule allows it) is counted as a violation.
contract VaultHandler is Test {
    // ───────────── Fixed world ─────────────

    uint256 internal constant ONE_USDC = 1_000_000;
    uint256 internal constant FEE = 3_500; // Gateway fee per pullback (A2-17)
    uint256 internal constant TREE_DEPTH = 4;
    uint256 internal constant LEAF_COUNT = 16; // 2 ** TREE_DEPTH
    uint256 internal constant X402_AND_JOB_LEAVES = 5;
    uint256 public constant POCKET_COUNT = LEAF_COUNT - X402_AND_JOB_LEAVES; // 11: a closed pocket is never reused
    uint256 internal constant FIRST_POCKET = 0xb0c0;
    uint256 internal constant MAX_ENVELOPES = 40;
    uint256 internal constant MAX_RESERVATIONS = 24;
    uint256 internal constant MAX_PULLBACKS = 16;
    uint256 internal constant MAX_JOBS = 12;
    uint64 internal constant ENVELOPE_LIFETIME = 1 days;
    uint64 internal constant RESERVATION_TTL = 300;
    uint64 internal constant JOB_LIFETIME = 1 hours;
    uint256 internal constant SMALL_WARP = 120; // seconds: most steps stay inside a reservation's TTL
    uint256 internal constant SMALL_ROLL = 20; // blocks
    uint256 internal constant BIG_WARP = 2 days; // past expiries and the force-close delay
    uint256 internal constant BIG_ROLL = 5_000; // past the pullback cancel delay
    uint256 internal constant BIG_STEP_ODDS = 8;
    uint256 internal constant CLOSE_ODDS = 3;
    uint256 internal constant MAX_FEE_PROBE = 600_000; // above MAX_PULLBACK_FEE_CEILING
    uint256 internal constant RECENT = 3; // most actions pick one of the newest records
    uint256 internal constant PULLBACK_WINDOW = 100; // blocks
    uint256 internal constant GAS_UNITS_MAX = 20_000;
    uint256 internal constant LIMIT_MAX = 20 * ONE_USDC;
    uint256 internal constant DONATION_MAX = ONE_USDC;
    uint16 internal constant POCKET_BPS = 2_500;
    uint256 internal constant KEEP_ODDS = 4;
    /// @dev forge-std makeAddr keys: keccak256(name).
    uint256 internal constant AGENT_PK = uint256(keccak256(abi.encodePacked("agent")));
    uint256 internal constant AUTONOMY_PK = uint256(keccak256(abi.encodePacked("autonomy")));
    address public constant RELAYER = address(0x7e1a7);
    address public constant FEE_SINK = address(0xfee5);
    address public constant ROGUE_PAYEE = address(0xbad1); // not in the plan
    address public constant ROGUE_POCKET = address(0xbad2); // not in the plan
    bytes32 public constant CATEGORY = keccak256("category");

    ICzarVault public immutable vault;
    MockArcUSDC public immutable usdc;
    MockGatewayWallet public immutable gatewayWallet;
    MockGatewayMinter public immutable gatewayMinter;
    MockVaultFactory public immutable factory;
    address public immutable escrow;
    bool public immutable czarKind;
    address public immutable owner;
    address public immutable agent;
    address public immutable evaluator;
    address public immutable controller;

    /// @dev The payee tree (czar-merkle-v1, 8 leaves): three x402 payees (two share step 0), two job providers,
    ///      three pockets.
    address[LEAF_COUNT] public leafPayee;
    uint8[LEAF_COUNT] public leafKind;
    uint32[LEAF_COUNT] public leafStep;
    uint256[LEAF_COUNT] public leafCap;
    bytes32[LEAF_COUNT][TREE_DEPTH + 1] internal levels; // levels[0] = leaves, levels[TREE_DEPTH][0] = root
    bytes32 public root;

    // ───────────── Records the handler created ─────────────

    uint64[] public envelopes;
    uint64[] public reservations;
    uint64[] public pullbacks;
    bytes32[] public jobs;

    // ───────────── Ghosts ─────────────

    mapping(uint64 reservationId => uint256) public ghostPaid; // USDC the payee received for that reservation
    mapping(address provider => uint256) public ghostProviderPaid; // what the escrow paid each provider
    mapping(address pocket => uint256) public ghostGas; // native gas the pocket received
    uint256 public ghostWithdrawn; // what the owner received
    uint256 public violations;
    uint256 internal nextPocket; // pockets handed out by openEnvelope, in leaf order
    mapping(bytes32 action => uint256) public hits; // successful calls per action (coverage report)
    string public lastViolation;
    uint256 public lastEnvelopeCount;
    uint256 public lastReservationCount;
    uint256 public lastPullbackCount;
    uint256 public lastAutonomyNonce;
    uint256 public lastOwnerActionNonce;

    constructor(VaultWorld memory w) {
        vault = w.vault;
        usdc = w.usdc;
        gatewayWallet = w.gatewayWallet;
        gatewayMinter = w.gatewayMinter;
        factory = w.factory;
        escrow = w.escrow;
        czarKind = w.czarKind;
        owner = w.owner;
        agent = w.agent;
        evaluator = w.evaluator;
        controller = w.controller;
        _buildTree();
    }

    /// @dev Leaves 0–2: x402 payees (0 and 1 share step 0); 3–4: job providers; 5–15: pockets.
    function _buildTree() internal {
        address[X402_AND_JOB_LEAVES] memory head =
            [address(0xbeef), address(0xcafe), address(0xfeed), address(0xd00d), address(0xd00e)];
        uint8[X402_AND_JOB_LEAVES] memory headKind =
            [PAYEE_KIND_X402, PAYEE_KIND_X402, PAYEE_KIND_X402, PAYEE_KIND_JOB, PAYEE_KIND_JOB];
        uint32[X402_AND_JOB_LEAVES] memory headStep = [uint32(0), 0, 2, 1, 3];
        uint256[X402_AND_JOB_LEAVES] memory headCap =
            [ONE_USDC, ONE_USDC, ONE_USDC / 2, ONE_USDC / 2, (6 * ONE_USDC) / 10];
        for (uint256 i = 0; i < LEAF_COUNT; i++) {
            if (i < X402_AND_JOB_LEAVES) {
                (leafPayee[i], leafKind[i], leafStep[i], leafCap[i]) = (head[i], headKind[i], headStep[i], headCap[i]);
            } else {
                leafPayee[i] = address(uint160(FIRST_POCKET + i - X402_AND_JOB_LEAVES));
                (leafKind[i], leafStep[i], leafCap[i]) = (PAYEE_KIND_POCKET, POCKET_STEP_INDEX, 0);
            }
            levels[0][i] = PayeeLeaf.hash(leafPayee[i], leafKind[i], leafStep[i], leafCap[i]);
        }
        uint256 width = LEAF_COUNT;
        for (uint256 d = 1; d <= TREE_DEPTH; d++) {
            width /= 2;
            for (uint256 i = 0; i < width; i++) {
                levels[d][i] = Hashes.commutativeKeccak256(levels[d - 1][2 * i], levels[d - 1][2 * i + 1]);
            }
        }
        root = levels[TREE_DEPTH][0];
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory p) {
        p = new bytes32[](TREE_DEPTH);
        for (uint256 d = 0; d < TREE_DEPTH; d++) {
            p[d] = levels[d][(i >> d) ^ 1];
        }
    }

    // ───────────── Views for the invariants ─────────────

    function envelopeCount() external view returns (uint256) {
        return envelopes.length;
    }

    function reservationCount() external view returns (uint256) {
        return reservations.length;
    }

    function pullbackCount() external view returns (uint256) {
        return pullbacks.length;
    }

    function jobCount() external view returns (uint256) {
        return jobs.length;
    }

    function pocketAt(uint256 i) external view returns (address) {
        return leafPayee[X402_AND_JOB_LEAVES + i];
    }

    // ───────────── Helpers ─────────────

    function _hit(string memory action) internal {
        hits[keccak256(bytes(action))]++;
    }

    function _violation(string memory what) internal {
        violations++;
        lastViolation = what;
    }

    function _spendingBlocked() internal view returns (bool) {
        return vault.frozen() || factory.guardianPaused();
    }

    /// @dev An open envelope when there is one (closed ones only receive probes that must fail).
    function _pickEnvelope(uint256 seed) internal view returns (uint64 id, bool ok) {
        uint256 n = envelopes.length;
        if (n == 0) return (0, false);
        for (uint256 i = 0; i < n; i++) {
            uint64 candidate = envelopes[(seed % n + i) % n];
            if (vault.getEnvelope(candidate).state == ICzarVault.EnvelopeState.Open) return (candidate, true);
        }
        return (envelopes[seed % n], true);
    }

    /// @dev Index of one of the newest RECENT entries of an array of length n (n > 0).
    function _recent(uint256 n, uint256 seed) internal pure returns (uint256) {
        uint256 window = n < RECENT ? n : RECENT;
        return n - 1 - seed % window;
    }

    /// @dev A pocket the vault knows and has not closed, when there is one; else any pocket (probes).
    function _pickPocket(uint256 seed) internal view returns (address) {
        for (uint256 i = 0; i < POCKET_COUNT; i++) {
            address pocket = leafPayee[X402_AND_JOB_LEAVES + (seed % POCKET_COUNT + i) % POCKET_COUNT];
            ICzarVault.PocketState st = vault.getPocket(pocket).state;
            if (st != ICzarVault.PocketState.None && st != ICzarVault.PocketState.Closed) return pocket;
        }
        return leafPayee[X402_AND_JOB_LEAVES + seed % POCKET_COUNT];
    }

    function _mintTo(address to, uint256 amount) internal {
        vm.prank(controller);
        usdc.mint(to, amount);
    }

    /// @dev INV-10: the counters never go down; checked after every action.
    function _checkCounters() internal {
        if (vault.envelopeCount() < lastEnvelopeCount) _violation("INV-10 envelopeCount");
        if (vault.reservationCount() < lastReservationCount) _violation("INV-10 reservationCount");
        if (vault.pullbackCount() < lastPullbackCount) _violation("INV-10 pullbackCount");
        if (vault.autonomyNonce() < lastAutonomyNonce) _violation("INV-10 autonomyNonce");
        if (vault.ownerActionNonce() < lastOwnerActionNonce) _violation("INV-10 ownerActionNonce");
        lastEnvelopeCount = vault.envelopeCount();
        lastReservationCount = vault.reservationCount();
        lastPullbackCount = vault.pullbackCount();
        lastAutonomyNonce = vault.autonomyNonce();
        lastOwnerActionNonce = vault.ownerActionNonce();
    }

    modifier checked() {
        _;
        _checkCounters();
    }

    // ───────────── Owner ─────────────

    function openEnvelope(uint256 capSeed, bool withPocket) external checked {
        if (envelopes.length >= MAX_ENVELOPES) return;
        ICzarVault.OpenEnvelopeParams memory p;
        p.cap = bound(capSeed, ONE_USDC, 3 * ONE_USDC);
        p.maxStepAmount = ONE_USDC;
        p.pocketCapBps = withPocket ? POCKET_BPS : 0;
        p.expiresAt = uint64(block.timestamp + ENVELOPE_LIFETIME);
        p.categoryId = CATEGORY;
        p.payeeRoot = root;
        _mintTo(address(vault), p.cap); // the owner tops up first, so the cap fits the free balance
        bool blocked = _spendingBlocked();
        vm.prank(owner);
        try vault.openEnvelope(p) returns (uint64 id) {
            if (blocked) _violation("INV-4 openEnvelope while frozen or paused");
            envelopes.push(id);
            _hit("openEnvelope");
            if (withPocket && capSeed % 2 == 0 && nextPocket < POCKET_COUNT && !blocked) {
                // half the pocket envelopes get one at once; the rest stay open for registerPocket and its probe
                // the agent registers a fresh pocket for the new envelope, as the planner does
                uint256 leaf = X402_AND_JOB_LEAVES + nextPocket++;
                bytes32[] memory proof = _proof(leaf);
                vm.prank(agent);
                vault.registerPocket(id, leafPayee[leaf], proof);
                _hit("registerPocket");
                _delegate(leafPayee[leaf]);
            }
        } catch {}
    }

    function closeEnvelope(uint256 envSeed) external checked {
        if (envSeed % CLOSE_ODDS != 0) return; // closes are rarer than the calls that fill an envelope
        (uint64 id, bool ok) = _pickEnvelope(envSeed);
        if (!ok) return;
        vm.prank(owner);
        try vault.closeEnvelope(id) {
            _hit("closeEnvelope");
        } catch {}
    }

    function forceCloseEnvelope(uint256 envSeed) external checked {
        (uint64 id, bool ok) = _pickEnvelope(envSeed);
        if (!ok) return;
        uint256 opensAt = uint256(vault.getEnvelope(id).expiresAt) + FORCE_CLOSE_DELAY;
        if (block.timestamp < opensAt) return;
        vm.prank(owner);
        try vault.forceCloseEnvelope(id) {
            _hit("forceCloseEnvelope");
        } catch {}
    }

    function withdraw(uint256 amount) external checked {
        uint256 free = vault.freeBalance();
        if (free == 0) return;
        amount = bound(amount, 1, free);
        vm.prank(owner);
        try vault.withdraw(owner, amount) {
            ghostWithdrawn += amount;
        } catch {
            _violation("withdraw within freeBalance reverted");
        }
    }

    function setMaxPullbackFee(uint256 newMax) external checked {
        // Mostly a maximum that admits the Gateway fee; sometimes below it, or above the ceiling (INV-15).
        newMax = newMax % CLOSE_ODDS == 0 ? bound(newMax, 0, MAX_FEE_PROBE) : bound(newMax, FEE, MAX_FEE_PROBE);
        vm.prank(owner);
        try vault.setMaxPullbackFee(newMax) {} catch {}
    }

    /// @dev A freeze stays on in one call out of KEEP_ODDS; otherwise the owner lifts it in the same call, so the
    ///      campaign spends most of its calls on an unfrozen vault (a frozen vault refuses almost everything).
    function freeze(bool byAgent, uint256 keepSeed) external checked {
        vm.prank(byAgent ? agent : owner);
        try vault.freeze() {
            _hit("freeze");
        } catch {}
        if (keepSeed % KEEP_ODDS != 0) _unfreeze();
    }

    function unfreeze() external checked {
        _unfreeze();
    }

    function _unfreeze() internal {
        vm.prank(owner);
        try vault.unfreeze() {} catch {}
    }

    function setCategoryLimits(uint256 userMax, uint256 autoLimit) external checked {
        userMax = bound(userMax, 0, LIMIT_MAX);
        autoLimit = bound(autoLimit, 0, LIMIT_MAX); // above userMax too
        vm.prank(owner);
        try vault.setCategoryLimits(CATEGORY, userMax, autoLimit) {} catch {}
    }

    // ───────────── Earned autonomy (autonomy signer, relayed by anyone; agent lowers) ─────────────

    function raiseAutoLimit(uint256 newLimit) external checked {
        newLimit = bound(newLimit, 0, LIMIT_MAX);
        uint64 period = uint64(block.timestamp / PERIOD_LENGTH);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 domain = CzarHashing.domainSeparatorFull(VAULT_NAME_HASH, VERSION_1_HASH, block.chainid, address(vault));
        bytes32 digest = CzarHashing.typedDataHash(
            domain, CzarHashing.autonomyRaiseStructHash(CATEGORY, newLimit, period, vault.autonomyNonce(), deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AUTONOMY_PK, digest);
        bool blocked = _spendingBlocked();
        try vault.raiseAutoLimit(CATEGORY, newLimit, period, deadline, abi.encodePacked(r, s, v)) {
            if (blocked) _violation("INV-4 raiseAutoLimit while frozen or paused");
            _hit("raiseAutoLimit");
        } catch {}
    }

    function lowerAutoLimit(uint256 newLimit) external checked {
        newLimit = bound(newLimit, 0, LIMIT_MAX);
        vm.prank(agent);
        try vault.lowerAutoLimit(CATEGORY, newLimit) {
            _hit("lowerAutoLimit");
        } catch {}
    }

    // ───────────── Guardian, time and value ─────────────

    /// @dev The guardian's pause stays on in one call out of KEEP_ODDS (see freeze).
    function guardianPause(uint256 keepSeed) external checked {
        factory.setGuardianPaused(keepSeed % KEEP_ODDS == 0);
    }

    /// @dev Time passes; a freeze or pause left on is lifted with it.
    function warp(uint256 seconds_, uint256 blocks) external checked {
        bool big = seconds_ % BIG_STEP_ODDS == 0;
        vm.warp(block.timestamp + bound(seconds_, 1, big ? BIG_WARP : SMALL_WARP));
        vm.roll(block.number + bound(blocks, 1, big ? BIG_ROLL : SMALL_ROLL));
        factory.setGuardianPaused(false);
        _unfreeze();
    }

    /// @dev USDC sent to the vault from outside is free balance.
    function donate(uint256 amount) external checked {
        _mintTo(address(vault), bound(amount, 1, DONATION_MAX));
    }

    // ───────────── Reservations (agent, Circle's relayer, anyone) ─────────────

    function reserve(uint256 envSeed, uint256 leafSeed, uint256 countSeed, uint256 unitSeed, bool digestMode)
        external
        checked
    {
        if (reservations.length >= MAX_RESERVATIONS) return;
        (uint64 id, bool ok) = _pickEnvelope(envSeed);
        if (!ok) return;
        uint256 leaf = leafSeed % 3;
        uint32 count = uint32(bound(countSeed, 1, digestMode ? 8 : 16));
        uint256 unit = bound(unitSeed, 1, leafCap[leaf] / count);
        uint64 vb = uint64(block.timestamp + RESERVATION_TTL);
        if (vb > vault.getEnvelope(id).expiresAt) return;
        bytes32[] memory proof = _proof(leaf);
        uint32 step = leafStep[leaf];
        address payee = leafPayee[leaf];
        uint256 cap = leafCap[leaf];
        bool blocked = _spendingBlocked();
        vm.prank(agent);
        if (digestMode) {
            try vault.reserveWithDigests(id, step, payee, cap, proof, unit, count, vb) returns (uint64 rid) {
                _recordReservation(rid, blocked);
            } catch {}
        } else {
            try vault.reserve(id, step, payee, cap, proof, unit, count, vb) returns (uint64 rid) {
                _recordReservation(rid, blocked);
            } catch {}
        }
    }

    /// @dev Probe for INV-3: a payee outside the plan, presented with a real leaf's proof, must never be reserved
    ///      (and so never paid). Pays it at once if the vault accepts, so the conservation check sees the leak.
    function reserveRogue(uint256 envSeed, uint256 leafSeed) external checked {
        (uint64 id, bool ok) = _pickEnvelope(envSeed);
        if (!ok) return;
        uint256 leaf = leafSeed % 3;
        uint64 vb = uint64(block.timestamp + RESERVATION_TTL);
        bytes32[] memory proof = _proof(leaf);
        uint32 step = leafStep[leaf];
        uint256 cap = leafCap[leaf];
        vm.prank(agent);
        try vault.reserve(id, step, ROGUE_PAYEE, cap, proof, 1, 1, vb) returns (uint64 rid) {
            _violation("INV-3 payee outside the plan reserved");
            _payRogue(rid, vb);
        } catch {}
    }

    /// @dev Relays the agent's authorization for index 0 of a reservation to ROGUE_PAYEE.
    function _payRogue(uint64 rid, uint64 vb) internal {
        bytes32 nonce = vault.derivedNonce(rid, 0);
        bytes32 digest = CzarHashing.typedDataHash(
            usdc.DOMAIN_SEPARATOR(),
            CzarHashing.transferWithAuthorizationHash(address(vault), ROGUE_PAYEE, 1, 0, vb, nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, digest);
        bytes memory sig = abi.encode(
            KIND_USDC_3009,
            rid,
            uint32(0),
            ROGUE_PAYEE,
            uint256(1),
            uint256(0),
            uint256(vb),
            nonce,
            abi.encodePacked(r, s, v)
        );
        vm.prank(RELAYER);
        try usdc.transferWithAuthorization(address(vault), ROGUE_PAYEE, 1, 0, vb, nonce, sig) {} catch {}
    }

    function _recordReservation(uint64 rid, bool blocked) internal {
        if (blocked) _violation("INV-4 reserve while frozen or paused");
        reservations.push(rid);
        _hit("reserve");
    }

    /// @dev Circle's relayer submits the agent's authorization through USDC (A1-18); USDC asks the vault (ERC-1271).
    ///      INV-4, INV-5, INV-11: the payment succeeds exactly when the vault's rules allow it.
    function payUsdc(uint256 ridSeed, uint256 indexSeed) external checked {
        if (reservations.length == 0) return;
        uint64 rid = reservations[_recent(reservations.length, ridSeed)];
        ICzarVault.Reservation memory r = vault.getReservation(rid);
        uint32 index = uint32(indexSeed % (uint256(r.count) + 1)); // one past the end is tried too
        bytes32 nonce = vault.derivedNonce(rid, index);
        bytes32 digest = CzarHashing.typedDataHash(
            usdc.DOMAIN_SEPARATOR(),
            CzarHashing.transferWithAuthorizationHash(address(vault), r.payee, r.unitAmount, 0, r.validBefore, nonce)
        );
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(AGENT_PK, digest);
        bytes memory agentSig = abi.encodePacked(rr, ss, v);
        bytes memory sig = r.mode == ICzarVault.ReservationMode.Digest
            ? agentSig
            : abi.encode(
                KIND_USDC_3009, rid, index, r.payee, r.unitAmount, uint256(0), uint256(r.validBefore), nonce, agentSig
            );
        bool expected = r.state == ICzarVault.ReservationState.Active && index < r.count
            && r.doneMask & (uint128(1) << index) == 0 && !usdc.authorizationState(address(vault), nonce)
            && block.timestamp < r.validBefore && !_spendingBlocked() && usdc.balanceOf(address(vault)) >= r.unitAmount;
        vm.prank(RELAYER);
        try usdc.transferWithAuthorization(address(vault), r.payee, r.unitAmount, 0, r.validBefore, nonce, sig) {
            if (!expected) _violation("INV-4/INV-11 payment accepted against the rules");
            ghostPaid[rid] += r.unitAmount;
            _hit("payUsdc");
        } catch {
            if (expected) _violation("payment refused although every rule allowed it");
        }
    }

    function settle(uint256 ridSeed, uint256 indexSeed) external checked {
        if (reservations.length == 0) return;
        uint64 rid = reservations[_recent(reservations.length, ridSeed)];
        ICzarVault.Reservation memory r = vault.getReservation(rid);
        uint32[] memory idx = new uint32[](1);
        idx[0] = uint32(indexSeed % r.count);
        for (uint32 x = 0; x < r.count; x++) {
            // prefer an index USDC has consumed and the vault has not settled
            bool done = r.doneMask & (uint128(1) << x) != 0;
            if (!done && usdc.authorizationState(address(vault), vault.derivedNonce(rid, x))) idx[0] = x;
        }
        try vault.settle(rid, idx) {
            _hit("settle");
        } catch {}
    }

    function finalize(uint256 ridSeed) external checked {
        if (reservations.length == 0) return;
        uint64 rid = reservations[ridSeed % reservations.length];
        uint32 count = vault.getReservation(rid).count;
        try vault.finalize(rid, 0, count) {
            _hit("finalize");
        } catch {}
    }

    // ───────────── Pockets (agent, owner, Circle's Gateway) ─────────────

    function registerPocket(uint256 envSeed, uint256 pocketSeed) external checked {
        (uint64 id, bool ok) = _pickEnvelope(envSeed);
        if (!ok) return;
        uint256 leaf = X402_AND_JOB_LEAVES + pocketSeed % POCKET_COUNT;
        address pocket = leafPayee[leaf];
        bytes32[] memory proof = _proof(leaf);
        bool blocked = _spendingBlocked();
        vm.prank(agent);
        try vault.registerPocket(id, pocket, proof) {
            if (blocked) _violation("INV-4 registerPocket while frozen or paused");
            _hit("registerPocket");
            _delegate(pocket);
        } catch {}
    }

    /// @dev The pocket delegates its Gateway balance to the vault (A2-05), once.
    function _delegate(address pocket) internal {
        if (gatewayWallet.isAuthorizedForBalance(USDC_ADDRESS, pocket, address(vault))) return;
        vm.prank(pocket);
        gatewayWallet.addDelegate(USDC_ADDRESS, address(vault));
    }

    /// @dev Probe for INV-14: a pocket that is not a leaf of the plan must never register.
    function registerRoguePocket(uint256 envSeed) external checked {
        (uint64 id, bool ok) = _pickEnvelope(envSeed);
        if (!ok) return;
        bytes32[] memory proof = _proof(X402_AND_JOB_LEAVES + envSeed % POCKET_COUNT); // a real pocket's proof
        vm.prank(agent);
        try vault.registerPocket(id, ROGUE_POCKET, proof) {
            _violation("INV-14 pocket outside the plan registered");
        } catch {}
    }

    function grantPocketGas(uint256 pocketSeed, uint256 units) external checked {
        address pocket = _pickPocket(pocketSeed);
        units = bound(units, 1, GAS_UNITS_MAX);
        bool blocked = _spendingBlocked();
        vm.prank(agent);
        try vault.grantPocketGas(pocket, units) {
            if (blocked) _violation("INV-4 grantPocketGas while frozen or paused");
            ghostGas[pocket] += units;
            _hit("grantPocketGas");
        } catch {}
    }

    function fundPocket(uint256 pocketSeed, uint256 amount) external checked {
        address pocket = _pickPocket(pocketSeed);
        ICzarVault.Pocket memory k = vault.getPocket(pocket);
        uint256 room;
        if (k.envelopeId != 0) {
            ICzarVault.Envelope memory e = vault.getEnvelope(k.envelopeId);
            uint256 capOfPocket = e.cap * e.pocketCapBps / BPS;
            room = capOfPocket > k.funded ? capOfPocket - k.funded : 0;
        }
        // Mostly an amount inside the pocket cap; sometimes any amount (the vault must refuse one above it).
        amount = room > 0 && amount % CLOSE_ODDS != 0 ? bound(amount, 1, room) : bound(amount, 1, ONE_USDC);
        bool blocked = _spendingBlocked();
        vm.prank(agent);
        try vault.fundPocket(pocket, amount) {
            if (blocked) _violation("INV-4 fundPocket while frozen or paused");
            _hit("fundPocket");
        } catch {}
    }

    function requestPullback(uint256 pocketSeed, uint256 value, bool byOwner) external checked {
        if (pullbacks.length >= MAX_PULLBACKS) return;
        address pocket = _pickPocket(pocketSeed);
        ICzarVault.Pocket memory k = vault.getPocket(pocket);
        uint256 room = k.outstanding > k.pendingPullback ? k.outstanding - k.pendingPullback : 0;
        // Mostly a request the Gateway balance can pay (value + fee), sometimes any value (the vault must refuse).
        value = room > FEE && value % CLOSE_ODDS != 0 ? bound(value, 1, room - FEE) : bound(value, 1, ONE_USDC);
        uint256 maxBlock = block.number + PULLBACK_WINDOW;
        vm.prank(byOwner ? owner : agent);
        try vault.requestPullback(pocket, value, FEE, maxBlock) returns (uint64 id) {
            pullbacks.push(id);
            _hit("requestPullback");
        } catch {}
    }

    /// @dev Circle's TEE asks the vault to check the burn intent (A2-08), then mints. INV-6 and INV-11: the vault
    ///      accepts the exact intent only while the record allows it, and never one with another recipient.
    function gatewayMint(uint256 pbSeed) external checked {
        if (pullbacks.length == 0) return;
        uint64 id = pullbacks[_recent(pullbacks.length, pbSeed)];
        ICzarVault.Pullback memory p = vault.getPullback(id);
        ICzarVault.Pocket memory k = vault.getPocket(p.pocket);
        bytes32 digest = _burnDigest(_spec(p, address(vault)), p);
        bool expected = p.state == ICzarVault.PullbackState.Pending && block.number <= p.maxBlockHeight
            && (k.state == ICzarVault.PocketState.Draining || (k.state == ICzarVault.PocketState.Closed && p.recovery));
        bool accepted = vault.isValidSignature(digest, _burnSig(id, digest)) == EIP1271_MAGIC;
        if (accepted != expected) _violation("INV-6 burn intent acceptance");
        bytes32 stolen = _burnDigest(_spec(p, RELAYER), p);
        if (vault.isValidSignature(stolen, _burnSig(id, stolen)) != EIP1271_INVALID) {
            _violation("INV-6 burn intent to another recipient accepted");
        }
        if (!accepted || gatewayMinter.isTransferSpecHashUsed(p.transferSpecHash)) return;
        if (gatewayWallet.availableBalance(USDC_ADDRESS, p.pocket) < p.value + FEE) return;
        vm.prank(controller);
        gatewayWallet.testBurn(USDC_ADDRESS, p.pocket, p.value, address(vault));
        vm.prank(controller);
        gatewayWallet.testBurn(USDC_ADDRESS, p.pocket, FEE, FEE_SINK);
        vm.prank(controller);
        gatewayMinter.testMarkTransferSpecHashUsed(p.transferSpecHash);
        _hit("gatewayMint");
    }

    function _spec(ICzarVault.Pullback memory p, address recipient)
        internal
        view
        returns (TransferSpecFields memory f)
    {
        f.version = 1;
        f.sourceDomain = 26;
        f.destinationDomain = 26;
        f.sourceContract = CzarHashing.toBytes32(address(gatewayWallet));
        f.destinationContract = CzarHashing.toBytes32(address(gatewayMinter));
        f.sourceToken = CzarHashing.toBytes32(USDC_ADDRESS);
        f.destinationToken = CzarHashing.toBytes32(USDC_ADDRESS);
        f.sourceDepositor = CzarHashing.toBytes32(p.pocket);
        f.destinationRecipient = CzarHashing.toBytes32(recipient);
        f.sourceSigner = CzarHashing.toBytes32(address(vault));
        f.destinationCaller = bytes32(0);
        f.value = p.value;
        f.salt = p.salt;
    }

    function _burnDigest(TransferSpecFields memory f, ICzarVault.Pullback memory p) internal pure returns (bytes32) {
        return CzarHashing.typedDataHash(
            GATEWAY_DOMAIN_SEPARATOR,
            CzarHashing.burnIntentStructHash(p.maxBlockHeight, p.maxFee, CzarHashing.transferSpecStructHash(f))
        );
    }

    function _burnSig(uint64 id, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, digest);
        return abi.encode(KIND_GATEWAY_BURN, id, abi.encodePacked(r, s, v));
    }

    function confirmPullback(uint256 pbSeed) external checked {
        if (pullbacks.length == 0) return;
        try vault.confirmPullback(pullbacks[_recent(pullbacks.length, pbSeed)]) {
            _hit("confirmPullback");
        } catch {}
    }

    function cancelPullback(uint256 pbSeed) external checked {
        if (pullbacks.length == 0) return;
        uint64 id = pullbacks[pbSeed % pullbacks.length];
        uint256 opensAt = vault.getPullback(id).maxBlockHeight + PULLBACK_CANCEL_DELAY_BLOCKS;
        if (block.number < opensAt) vm.roll(opensAt);
        vm.prank(owner);
        try vault.cancelPullback(id) {
            _hit("cancelPullback");
        } catch {}
    }

    function writeOffPocket(uint256 pocketSeed) external checked {
        if (pocketSeed % CLOSE_ODDS != 0) return; // write-offs are rarer than the calls that use a pocket
        address pocket = _pickPocket(pocketSeed);
        vm.prank(agent);
        try vault.writeOffPocket(pocket) {
            _hit("writeOffPocket");
        } catch {}
    }

    function recordManualReturn(uint256 pocketSeed, uint256 amount) external checked {
        address pocket = _pickPocket(pocketSeed);
        amount = bound(amount, 1, ONE_USDC);
        vm.prank(owner);
        try vault.recordManualReturn(pocket, amount) {
            _hit("recordManualReturn");
        } catch {}
    }

    // ───────────── Jobs (agent, owner, provider, evaluator, anyone) ─────────────

    function openJob(uint256 envSeed, bool secondProvider) external checked {
        if (jobs.length >= MAX_JOBS) return;
        (uint64 id, bool ok) = _pickEnvelope(envSeed);
        if (!ok) return;
        uint256 leaf = secondProvider ? 4 : 3;
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        if (expiredAt > vault.getEnvelope(id).expiresAt) return;
        bytes32[] memory proof = _proof(leaf);
        uint32 step = leafStep[leaf];
        address provider = leafPayee[leaf];
        uint256 cap = leafCap[leaf];
        bool blocked = _spendingBlocked();
        vm.prank(agent);
        try vault.openJob(id, step, provider, cap, proof, expiredAt, keccak256("job")) returns (bytes32 jobKey) {
            if (blocked) _violation("INV-4 openJob while frozen or paused");
            jobs.push(jobKey);
            _hit("openJob");
        } catch {}
    }

    function _job(uint256 seed) internal view returns (bytes32 key, ICzarVault.Job memory j, bool ok) {
        if (jobs.length == 0) return (bytes32(0), j, false);
        key = jobs[_recent(jobs.length, seed)];
        j = vault.getJob(key);
        ok = true;
    }

    function setBudget(uint256 jobSeed, uint256 amount) external checked {
        (, ICzarVault.Job memory j, bool ok) = _job(jobSeed);
        if (!ok) return;
        // Mostly a budget the vault can fund; sometimes 0 or one above the reserved cap (JOB-1, R2).
        amount = amount % CLOSE_ODDS == 0 ? bound(amount, 0, j.reservedCap + 1) : bound(amount, 1, j.reservedCap);
        vm.prank(j.provider);
        _setEscrowBudget(j.jobId, amount);
    }

    /// @dev Call after vm.prank(provider).
    function _setEscrowBudget(uint256 jobId, uint256 amount) internal {
        if (czarKind) {
            try MockCzarJobEscrow(escrow).setBudget(jobId, USDC_ADDRESS, amount, "") {
                _hit("setBudget");
            } catch {}
        } else {
            try MockCircleAgenticCommerce(escrow).setBudget(jobId, amount, "") {
                _hit("setBudget");
            } catch {}
        }
    }

    function fundJob(uint256 jobSeed) external checked {
        (bytes32 key, ICzarVault.Job memory j, bool ok) = _job(jobSeed);
        if (!ok) return;
        if (_escrowBudget(j.jobId) == 0 && jobSeed % 2 == 0) {
            vm.prank(j.provider); // the provider quotes right before the agent funds
            _setEscrowBudget(j.jobId, j.reservedCap / 2);
        }
        uint256 budget = _escrowBudget(j.jobId);
        bool blocked = _spendingBlocked();
        vm.prank(agent);
        try vault.fundJob(key, budget) {
            if (blocked) _violation("INV-4 fundJob while frozen or paused");
            if (budget > j.reservedCap) _violation("JOB-1 budget above reservedCap funded");
            _hit("fundJob");
        } catch {}
    }

    function _escrowBudget(uint256 jobId) internal view returns (uint256) {
        if (czarKind) return MockCzarJobEscrow(escrow).getJob(jobId).budget;
        return MockCircleAgenticCommerce(escrow).getJob(jobId).budget;
    }

    function cancelJob(uint256 jobSeed, bool byOwner) external checked {
        if (jobSeed % CLOSE_ODDS != 0) return; // cancels are rarer than the calls that move a job forward
        (bytes32 key,, bool ok) = _job(jobSeed);
        if (!ok) return;
        vm.prank(byOwner ? owner : agent);
        try vault.cancelJob(key) {
            _hit("cancelJob");
        } catch {}
    }

    function providerSubmit(uint256 jobSeed) external checked {
        (, ICzarVault.Job memory j, bool ok) = _job(jobSeed);
        if (!ok) return;
        vm.prank(j.provider);
        if (czarKind) {
            try MockCzarJobEscrow(escrow).submit(j.jobId, keccak256("deliverable"), "") {} catch {}
        } else {
            try MockCircleAgenticCommerce(escrow).submit(j.jobId, keccak256("deliverable"), "") {} catch {}
        }
    }

    /// @dev The evaluator completes or rejects.
    function evaluatorDecide(uint256 jobSeed, bool complete) external checked {
        (, ICzarVault.Job memory j, bool ok) = _job(jobSeed);
        if (!ok) return;
        uint256 before = usdc.balanceOf(j.provider);
        vm.prank(evaluator);
        if (czarKind) {
            MockCzarJobEscrow e = MockCzarJobEscrow(escrow);
            if (complete) {
                try e.complete(j.jobId, keccak256("report"), "") {} catch {}
            } else {
                try e.reject(j.jobId, keccak256("report"), "") {} catch {}
            }
        } else {
            MockCircleAgenticCommerce e = MockCircleAgenticCommerce(escrow);
            if (complete) {
                try e.complete(j.jobId, keccak256("report"), "") {} catch {}
            } else {
                try e.reject(j.jobId, keccak256("report"), "") {} catch {}
            }
        }
        ghostProviderPaid[j.provider] += usdc.balanceOf(j.provider) - before;
    }

    /// @dev Czar instance only: a partial claim the provider submits and the evaluator approves (RV-009).
    function partialClaim(uint256 jobSeed, uint256 amount) external checked {
        if (!czarKind) return;
        (, ICzarVault.Job memory j, bool ok) = _job(jobSeed);
        if (!ok) return;
        MockCzarJobEscrow e = MockCzarJobEscrow(escrow);
        MockCzarJobEscrow.Job memory ej = e.getJob(j.jobId);
        if (ej.budget <= ej.settledAmount) return;
        uint256 cumulative = bound(amount, ej.settledAmount + 1, ej.budget);
        bytes32 deliverable = keccak256(abi.encode("claim", cumulative));
        uint256 before = usdc.balanceOf(j.provider);
        vm.prank(j.provider);
        try e.submitClaim(j.jobId, cumulative, deliverable, "") {
            vm.prank(evaluator);
            try e.approveClaim(j.jobId, cumulative, deliverable, "") {
                _hit("partialClaim");
            } catch {}
        } catch {}
        ghostProviderPaid[j.provider] += usdc.balanceOf(j.provider) - before;
    }

    /// @dev Anyone may call claimRefund on the escrow directly.
    function escrowClaimRefund(uint256 jobSeed) external checked {
        (, ICzarVault.Job memory j, bool ok) = _job(jobSeed);
        if (!ok) return;
        if (czarKind) {
            try MockCzarJobEscrow(escrow).claimRefund(j.jobId) {} catch {}
        } else {
            try MockCircleAgenticCommerce(escrow).claimRefund(j.jobId) {} catch {}
        }
    }

    function syncJob(uint256 jobSeed) external checked {
        (bytes32 key,, bool ok) = _job(jobSeed);
        if (!ok) return;
        try vault.syncJob(key) {
            _hit("syncJob");
        } catch {}
    }

    function claimJobRefund(uint256 jobSeed) external checked {
        (bytes32 key,, bool ok) = _job(jobSeed);
        if (!ok) return;
        try vault.claimJobRefund(key) {
            _hit("claimJobRefund");
        } catch {}
    }
}

/// @notice T-021 (07 PRD 12 §6): INV-1 … INV-16 and JOB-1 … JOB-5 (czar-vault.md §11, job-escrow-adapter.md §8) as
///         Foundry invariants over the handler above. Two concrete suites run it against each escrow kind;
///         `arc-forge test --match-contract InvariantVault` runs both.
abstract contract InvariantVaultBase is VaultTestBase {
    VaultHandler internal handler;
    address internal escrowAddress;
    uint256 internal constant START_BALANCE = 10 * ONE_USDC;
    uint256 internal constant START_USER_MAX = 10 * ONE_USDC;
    uint32 internal constant STEP_COUNT = 4; // steps 0 … 3 of the handler's tree
    uint256 internal constant LEAVES = 16; // the handler's tree
    /// @dev The stepCap of steps 0 … 3 in the handler's tree (leaves 0/1, 3, 2, 4).
    uint256[4] internal STEP_CAPS = [ONE_USDC, ONE_USDC / 2, ONE_USDC / 2, (6 * ONE_USDC) / 10];

    function _escrowAndKind() internal virtual returns (address, uint8);

    function setUp() public override {
        super.setUp();
        (address e, uint8 kind) = _escrowAndKind();
        escrowAddress = e;
        if (kind == 1) {
            ICzarVaultFactory.NetworkConfig memory cfg = _networkConfig();
            cfg.jobEscrow = e;
            cfg.jobEscrowKind = 1;
            vaultFactory = new MockVaultFactory(cfg, _defaults());
            vault = vaultFactory.deploy(owner);
        }
        _fundVault(START_BALANCE);
        handler = new VaultHandler(
            VaultWorld({
                vault: ICzarVault(address(vault)),
                usdc: usdc,
                gatewayWallet: gatewayWallet,
                gatewayMinter: gatewayMinter,
                factory: vaultFactory,
                escrow: e,
                czarKind: kind == 1,
                owner: owner,
                agent: agent,
                evaluator: evaluatorKey,
                controller: address(this)
            })
        );
        bytes32 category = handler.CATEGORY(); // read before the prank: an external call would consume it
        vm.prank(owner);
        vault.setCategoryLimits(category, START_USER_MAX, ONE_USDC);
        targetContract(address(handler));
    }

    // ───────────── Recomputations ─────────────

    function _popcount(uint128 x, uint32 n) internal pure returns (uint32 c) {
        for (uint32 i = 0; i < n; i++) {
            if (x & (uint128(1) << i) != 0) c++;
        }
    }

    /// @dev For one envelope: Σ still-reserved indices × unit (INV-8), step use (INV-12), reservations not Final.
    function _reservationSums(uint64 env, uint32 step)
        internal
        view
        returns (uint256 reserved, uint256 stepUse, uint32 notFinal)
    {
        for (uint256 i = 0; i < handler.reservationCount(); i++) {
            ICzarVault.Reservation memory r = vault.getReservation(handler.reservations(i));
            if (r.envelopeId != env) continue;
            if (r.state != ICzarVault.ReservationState.Final) notFinal++;
            if (r.state == ICzarVault.ReservationState.Active || r.state == ICzarVault.ReservationState.Finalizing) {
                reserved += uint256(r.count - _popcount(r.doneMask, r.count)) * r.unitAmount;
            }
            if (r.stepIndex == step) stepUse += uint256(r.count - r.releasedCount) * r.unitAmount;
        }
    }

    /// @dev For one envelope: reservedCap of Opened jobs (INV-8), step use (INV-12), escrowed budgets (JOB-4).
    function _jobSums(uint64 env, uint32 step)
        internal
        view
        returns (uint256 reserved, uint256 stepUse, uint256 escrowed)
    {
        for (uint256 i = 0; i < handler.jobCount(); i++) {
            ICzarVault.Job memory j = vault.getJob(handler.jobs(i));
            if (j.envelopeId != env) continue;
            if (j.state == ICzarVault.JobState.Opened) reserved += j.reservedCap;
            if (j.state == ICzarVault.JobState.Funded || j.state == ICzarVault.JobState.Submitted) {
                escrowed += j.budget;
            }
            if (j.stepIndex != step) continue;
            if (j.state == ICzarVault.JobState.Opened) {
                stepUse += j.reservedCap;
            } else if (
                j.state == ICzarVault.JobState.Funded || j.state == ICzarVault.JobState.Submitted
                    || j.state == ICzarVault.JobState.Completed
            ) {
                stepUse += j.budget;
            } else if (j.state == ICzarVault.JobState.Refunded) {
                stepUse += _settledAmount(j.jobId); // budget − refund
            }
        }
    }

    function _settledAmount(uint256 jobId) internal view returns (uint256) {
        if (!handler.czarKind()) return 0; // Circle's instance refunds the whole budget
        return MockCzarJobEscrow(escrowAddress).getJob(jobId).settledAmount;
    }

    /// @dev Σ unitAmount over indices USDC has consumed but the vault has not settled (the INV-2 window).
    function _usedUnsettled() internal view returns (uint256 total) {
        for (uint256 i = 0; i < handler.reservationCount(); i++) {
            uint64 rid = handler.reservations(i);
            ICzarVault.Reservation memory r = vault.getReservation(rid);
            for (uint32 x = 0; x < r.count; x++) {
                if (r.doneMask & (uint128(1) << x) != 0) continue;
                if (usdc.authorizationState(address(vault), vault.derivedNonce(rid, x))) total += r.unitAmount;
            }
        }
    }

    /// @dev Coverage report, printed with -vv: how often each action succeeded across the campaign.
    function afterInvariant() external view {
        string[26] memory names = [
            "openEnvelope",
            "closeEnvelope",
            "forceCloseEnvelope",
            "reserve",
            "payUsdc",
            "settle",
            "finalize",
            "registerPocket",
            "grantPocketGas",
            "fundPocket",
            "requestPullback",
            "gatewayMint",
            "confirmPullback",
            "cancelPullback",
            "writeOffPocket",
            "recordManualReturn",
            "openJob",
            "setBudget",
            "fundJob",
            "cancelJob",
            "syncJob",
            "claimJobRefund",
            "partialClaim",
            "raiseAutoLimit",
            "lowerAutoLimit",
            "freeze"
        ];
        for (uint256 i = 0; i < names.length; i++) {
            console.log(names[i], handler.hits(keccak256(bytes(names[i]))));
        }
    }

    // ───────────── Invariants ─────────────

    /// INV-4, INV-6, INV-10, INV-11 and JOB-1 at call time (the handler's own checks).
    function _check_handlerSawNoViolation() internal view {
        assertEq(handler.violations(), 0, handler.lastViolation());
    }

    /// INV-1 and INV-2.
    function _check_INV1_INV2_capsAndCommittedTotal() internal view {
        uint256 committed;
        for (uint256 i = 0; i < handler.envelopeCount(); i++) {
            ICzarVault.Envelope memory e = vault.getEnvelope(handler.envelopes(i));
            assertLe(e.spent + e.reserved + e.pocketOutstanding + e.jobEscrowed + e.shortfall, e.cap, "INV-1");
            if (e.state == ICzarVault.EnvelopeState.Open) {
                committed += e.cap - e.spent - e.pocketOutstanding - e.jobEscrowed - e.shortfall;
            }
        }
        assertEq(vault.committedTotal(), committed, "INV-2 sum");
        assertLe(vault.committedTotal(), usdc.balanceOf(address(vault)) + _usedUnsettled(), "INV-2 balance");
    }

    /// INV-3 and INV-5: all USDC stays with the known holders, and each one got only what the rules allow.
    function _check_INV3_INV5_noUsdcLeak() internal view {
        uint256 held = usdc.balanceOf(address(vault)) + usdc.balanceOf(owner) + usdc.balanceOf(address(gatewayWallet))
            + usdc.balanceOf(escrowAddress) + usdc.balanceOf(handler.FEE_SINK()) + usdc.balanceOf(treasury)
            + usdc.balanceOf(evaluatorKey);
        for (uint256 i = 0; i < LEAVES; i++) {
            held += usdc.balanceOf(handler.leafPayee(i));
        }
        assertEq(held, usdc.totalSupply(), "INV-3 conservation");
        assertEq(usdc.balanceOf(handler.RELAYER()), 0, "INV-3 relayer");
        assertEq(usdc.balanceOf(stranger), 0, "INV-3 stranger");
        assertEq(usdc.balanceOf(owner), handler.ghostWithdrawn(), "INV-3 owner only by withdraw");
        uint256[3] memory paid;
        for (uint256 i = 0; i < handler.reservationCount(); i++) {
            uint64 rid = handler.reservations(i);
            ICzarVault.Reservation memory r = vault.getReservation(rid);
            uint256 used;
            for (uint32 x = 0; x < r.count; x++) {
                if (usdc.authorizationState(address(vault), vault.derivedNonce(rid, x))) used++;
            }
            assertFalse(usdc.authorizationState(address(vault), vault.derivedNonce(rid, r.count)), "INV-5 index");
            assertEq(handler.ghostPaid(rid), used * r.unitAmount, "INV-5 value per index");
            for (uint256 p = 0; p < 3; p++) {
                if (r.payee == handler.leafPayee(p)) paid[p] += used * r.unitAmount;
            }
        }
        for (uint256 p = 0; p < 3; p++) {
            assertEq(usdc.balanceOf(handler.leafPayee(p)), paid[p], "INV-3 payee paid only by authorizations");
        }
        for (uint256 p = 3; p < 5; p++) {
            address provider = handler.leafPayee(p);
            assertEq(usdc.balanceOf(provider), handler.ghostProviderPaid(provider), "INV-3 provider paid by escrow");
        }
        for (uint256 p = 0; p < handler.POCKET_COUNT(); p++) {
            address pocket = handler.pocketAt(p);
            assertEq(usdc.balanceOf(pocket), handler.ghostGas(pocket), "INV-3 pocket native = gas granted");
        }
    }

    /// INV-7 and INV-14.
    function _check_INV7_INV14_pockets() internal view {
        for (uint256 i = 0; i < handler.envelopeCount(); i++) {
            ICzarVault.Envelope memory e = vault.getEnvelope(handler.envelopes(i));
            if (e.pocketCapBps == 0) assertEq(e.pocket, address(0), "INV-14 no pocket without pocketCapBps");
            if (e.pocket != address(0)) assertTrue(_isPlanPocket(e.pocket), "INV-14 pocket is a kind-4 leaf");
        }
        for (uint256 p = 0; p < handler.POCKET_COUNT(); p++) {
            address pocket = handler.pocketAt(p);
            ICzarVault.Pocket memory k = vault.getPocket(pocket);
            if (k.envelopeId == 0) continue;
            ICzarVault.Envelope memory e = vault.getEnvelope(k.envelopeId);
            assertEq(e.pocket, pocket, "INV-14 envelope.pocket");
            if (k.state != ICzarVault.PocketState.Closed) {
                assertLe(k.pendingPullback, k.outstanding, "INV-7 pending");
                assertLe(k.outstanding, k.funded, "INV-7 outstanding");
                assertLe(k.funded, e.cap * e.pocketCapBps / BPS, "INV-7 funded");
                assertEq(uint8(e.state), uint8(ICzarVault.EnvelopeState.Open), "INV-14 live pocket, open envelope");
            } else {
                assertEq(k.outstanding, 0, "INV-7 closed outstanding");
                uint256 pending;
                for (uint256 i = 0; i < handler.pullbackCount(); i++) {
                    ICzarVault.Pullback memory pb = vault.getPullback(handler.pullbacks(i));
                    if (pb.pocket == pocket && pb.state == ICzarVault.PullbackState.Pending && !pb.recovery) {
                        pending += pb.value;
                    }
                }
                assertEq(k.pendingPullback, pending, "INV-7 closed pending");
            }
        }
    }

    function _isPlanPocket(address pocket) internal view returns (bool) {
        for (uint256 p = 0; p < handler.POCKET_COUNT(); p++) {
            if (handler.pocketAt(p) == pocket) return true;
        }
        return false;
    }

    /// INV-8, INV-12, INV-13 and JOB-4.
    function _check_INV8_INV12_INV13_JOB4_reservedAndSteps() internal view {
        uint32 noStep = type(uint32).max - 1;
        for (uint256 i = 0; i < handler.envelopeCount(); i++) {
            uint64 env = handler.envelopes(i);
            ICzarVault.Envelope memory e = vault.getEnvelope(env);
            (uint256 resReserved,, uint32 notFinal) = _reservationSums(env, noStep);
            (uint256 jobReserved,, uint256 escrowed) = _jobSums(env, noStep);
            assertEq(e.openReservations, notFinal, "INV-13 openReservations");
            assertEq(e.jobEscrowed, escrowed, "JOB-4");
            if (e.state != ICzarVault.EnvelopeState.Open) {
                assertEq(e.reserved, 0, "INV-8 closed");
                continue;
            }
            assertEq(e.reserved, resReserved + jobReserved, "INV-8");
            for (uint32 s = 0; s < STEP_COUNT; s++) {
                (, uint256 resStep,) = _reservationSums(env, s);
                (, uint256 jobStep,) = _jobSums(env, s);
                assertEq(vault.stepUsed(env, s), resStep + jobStep, "INV-12");
                assertLe(vault.stepUsed(env, s), STEP_CAPS[s], "INV-12 step cap");
            }
        }
        for (uint256 i = 0; i < handler.reservationCount(); i++) {
            ICzarVault.Reservation memory r = vault.getReservation(handler.reservations(i));
            bool isFinal = r.state == ICzarVault.ReservationState.Final;
            assertEq(isFinal, _popcount(r.doneMask, r.count) == r.count, "INV-13 Final iff all done");
        }
    }

    /// INV-9 and INV-15.
    function _check_INV9_INV15_limits() internal view {
        ICzarVault.CategoryLimits memory l = vault.getLimits(handler.CATEGORY());
        assertLe(l.autoLimit, l.userMax, "INV-9");
        assertLe(vault.maxPullbackFee(), vault.MAX_PULLBACK_FEE_CEILING(), "INV-15");
    }

    /// JOB-1, JOB-2, JOB-3.
    function _check_JOB1_JOB2_JOB3_jobs() internal view {
        for (uint256 i = 0; i < handler.jobCount(); i++) {
            ICzarVault.Job memory j = vault.getJob(handler.jobs(i));
            assertLe(j.budget, j.reservedCap, "JOB-1");
            (address client, address evaluator, string memory description) = _escrowJob(j.jobId);
            assertEq(client, address(vault), "JOB-2 client");
            assertEq(evaluator, evaluatorKey, "JOB-2 evaluator");
            assertTrue(j.provider == handler.leafPayee(3) || j.provider == handler.leafPayee(4), "JOB-2 provider");
            assertEq(bytes(description).length, 69, "JOB-3 description length");
        }
    }

    function _escrowJob(uint256 jobId) internal view returns (address, address, string memory) {
        if (handler.czarKind()) {
            MockCzarJobEscrow.Job memory c = MockCzarJobEscrow(escrowAddress).getJob(jobId);
            return (c.client, c.evaluator, c.description);
        }
        MockCircleAgenticCommerce.Job memory j = MockCircleAgenticCommerce(escrowAddress).getJob(jobId);
        return (j.client, j.evaluator, j.description);
    }

    /// @notice Every INV and JOB id after each handler call, in one campaign (one campaign per invariant function
    ///         would multiply the run time by seven; each assertion message names its id).
    function invariant_vaultAndJobInvariants() public view {
        _check_handlerSawNoViolation();
        _check_INV1_INV2_capsAndCommittedTotal();
        _check_INV3_INV5_noUsdcLeak();
        _check_INV7_INV14_pockets();
        _check_INV8_INV12_INV13_JOB4_reservedAndSteps();
        _check_INV9_INV15_limits();
        _check_JOB1_JOB2_JOB3_jobs();
    }

    /// INV-16 / JOB-5 (H1, H2): every Opened job reaches Released through syncJob once its expiry has passed,
    /// whatever the escrow did without funding. Checked on a state snapshot that is thrown away.
    function invariant_unfundedJobsAlwaysRelease() public {
        for (uint256 i = 0; i < handler.jobCount(); i++) {
            bytes32 key = handler.jobs(i);
            ICzarVault.Job memory j = vault.getJob(key);
            if (j.state != ICzarVault.JobState.Opened) continue;
            uint256 snap = vm.snapshotState();
            if (block.timestamp < j.expiredAt) vm.warp(j.expiredAt);
            vault.syncJob(key);
            assertEq(uint8(vault.getJob(key).state), uint8(ICzarVault.JobState.Released), "INV-16");
            vm.revertToState(snap);
        }
    }
}

/// @notice T-021: the invariants against Circle's testnet escrow ABI (kind 0).
contract InvariantVaultCircle is InvariantVaultBase {
    function _escrowAndKind() internal view override returns (address, uint8) {
        return (address(jobEscrow), 0);
    }
}

/// @notice T-021: the invariants against the CzarJobEscrow ABI (kind 1), with partial claims.
contract InvariantVaultCzar is InvariantVaultBase {
    function _escrowAndKind() internal override returns (address, uint8) {
        MockCzarJobEscrow e = new MockCzarJobEscrow(treasury, address(this));
        e.setPaymentTokenAllowed(USDC_ADDRESS, true);
        return (address(e), 1);
    }
}
