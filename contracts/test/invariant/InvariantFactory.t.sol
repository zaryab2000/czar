// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ICzarVault} from "../../src/interfaces/ICzarVault.sol";
import {CzarVaultFactory} from "../../src/CzarVaultFactory.sol";
import {MockArcUSDC} from "../mocks/MockArcUSDC.sol";
import {VaultTestBase} from "../helpers/VaultTestBase.sol";

/// @notice T-021 (07 PRD 12 §7): drives the factory through random calls by the admin, the guardian and anyone
///         (czar-vault-factory.md §5–§9). A call that succeeds against FAC-2 or FAC-3 is counted as a violation.
contract FactoryHandler is Test {
    uint256 internal constant ADMIN_TIMELOCK = 48 hours; // czar-vault-factory.md §3
    uint256 public constant OWNER_COUNT = 6;
    uint256 internal constant MAX_WARP = 30 hours; // two warps can cross the timelock, one cannot
    uint256 internal constant MAX_CHANGES = 12;
    uint8 internal constant KIND_GUARDIAN = 1;
    uint8 internal constant KIND_DEFAULTS = 2;

    CzarVaultFactory public immutable factory;
    MockArcUSDC public immutable usdc;
    address public immutable admin;
    address public immutable stranger;

    address[OWNER_COUNT] public owners;
    address public guardian;
    bool public ghostPaused;

    /// @dev A queued change and what the handler knows about it.
    struct Change {
        bytes32 id;
        uint8 kind;
        uint64 eta;
        address a; // guardian, or agentSigner
        address b; // autonomySigner
        address c; // evaluator
        bool done; // applied or cancelled
    }

    Change[] public changes;

    /// @dev FAC-1, FAC-4, FAC-5 ghosts, set by the first successful createVault for each owner.
    mapping(address owner => address) public predictedAtStart;
    mapping(address owner => address) public created;
    mapping(address vault => bytes32) public codeHashAtCreate;
    mapping(address vault => bytes32) public signersAtCreate;

    uint256 public violations;
    string public lastViolation;

    constructor(CzarVaultFactory factory_, MockArcUSDC usdc_, address admin_, address guardian_, address stranger_) {
        factory = factory_;
        usdc = usdc_;
        admin = admin_;
        guardian = guardian_;
        stranger = stranger_;
        for (uint256 i = 0; i < OWNER_COUNT; i++) {
            owners[i] = address(uint160(0x0a11ce + i));
            predictedAtStart[owners[i]] = factory.predictVault(owners[i]); // before any defaults change (FAC-5)
        }
    }

    function changeCount() external view returns (uint256) {
        return changes.length;
    }

    function _violation(string memory what) internal {
        violations++;
        lastViolation = what;
    }

    function _signersHash(address vault) internal view returns (bytes32) {
        ICzarVault v = ICzarVault(vault);
        return keccak256(abi.encode(v.owner(), v.agentSigner(), v.autonomySigner(), v.evaluator(), v.factory()));
    }

    // ───────────── Anyone ─────────────

    /// @dev Any caller may create a vault for any owner (FAC-5: the address does not depend on the caller).
    function createVault(uint256 ownerSeed, address caller) external {
        address o = owners[ownerSeed % OWNER_COUNT];
        bool existed = created[o] != address(0);
        vm.prank(caller);
        try factory.createVault(o) returns (address vault) {
            if (existed) _violation("FAC-1 second vault for one owner");
            created[o] = vault;
            codeHashAtCreate[vault] = vault.codehash;
            signersAtCreate[vault] = _signersHash(vault);
        } catch {
            if (!existed) _violation("createVault refused for a new owner");
        }
    }

    // ───────────── Guardian or anyone (FAC-2) ─────────────

    function setPause(bool pause, bool asGuardian) external {
        address caller = asGuardian ? guardian : stranger;
        vm.prank(caller);
        if (pause) {
            try factory.pause() {
                if (!asGuardian) _violation("FAC-2 pause by a non-guardian");
                ghostPaused = true;
            } catch {
                if (asGuardian) _violation("pause refused for the guardian");
            }
        } else {
            try factory.unpause() {
                if (!asGuardian) _violation("FAC-2 unpause by a non-guardian");
                ghostPaused = false;
            } catch {
                if (asGuardian) _violation("unpause refused for the guardian");
            }
        }
    }

    // ───────────── Admin or anyone (FAC-3) ─────────────

    function queueGuardian(uint256 seed, bool asAdmin) external {
        if (changes.length >= MAX_CHANGES) return;
        address g = address(uint160(0x6a0000 + seed % 1_000 + 1));
        vm.prank(asAdmin ? admin : stranger);
        try factory.queueGuardian(g) returns (bytes32 id) {
            if (!asAdmin) _violation("queueGuardian by a non-admin");
            changes.push(
                Change(id, KIND_GUARDIAN, uint64(block.timestamp + ADMIN_TIMELOCK), g, address(0), address(0), false)
            );
        } catch {}
    }

    function queueDefaults(uint256 seed, bool asAdmin) external {
        if (changes.length >= MAX_CHANGES) return;
        address a = address(uint160(0xa90000 + seed % 1_000 + 1));
        address b = address(uint160(0xa70000 + seed % 1_000 + 1));
        address c = address(uint160(0xe70000 + seed % 1_000 + 1));
        vm.prank(asAdmin ? admin : stranger);
        try factory.queueDefaults(a, b, c) returns (bytes32 id) {
            if (!asAdmin) _violation("queueDefaults by a non-admin");
            changes.push(Change(id, KIND_DEFAULTS, uint64(block.timestamp + ADMIN_TIMELOCK), a, b, c, false));
        } catch {}
    }

    /// @dev Anyone may apply a queued change; FAC-3: never before its eta.
    function applyChange(uint256 seed, address caller) external {
        if (changes.length == 0) return;
        Change storage ch = changes[seed % changes.length];
        bool early = block.timestamp < ch.eta;
        vm.prank(caller);
        if (ch.kind == KIND_GUARDIAN) {
            try factory.applyGuardian(ch.id, ch.a) {
                if (early) _violation("FAC-3 guardian applied before eta");
                if (ch.done) _violation("FAC-3 change applied twice");
                ch.done = true;
                guardian = ch.a;
            } catch {}
        } else {
            try factory.applyDefaults(ch.id, ch.a, ch.b, ch.c) {
                if (early) _violation("FAC-3 defaults applied before eta");
                if (ch.done) _violation("FAC-3 change applied twice");
                ch.done = true;
            } catch {}
        }
    }

    function cancelChange(uint256 seed, bool asAdmin) external {
        if (changes.length == 0) return;
        Change storage ch = changes[seed % changes.length];
        vm.prank(asAdmin ? admin : stranger);
        try factory.cancelChange(ch.id) {
            if (!asAdmin) _violation("cancelChange by a non-admin");
            ch.done = true;
        } catch {}
    }

    function warp(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, MAX_WARP));
    }
}

/// @notice T-021 (07 PRD 12 §7): FAC-1 … FAC-5 (czar-vault-factory.md §9) as Foundry invariants over the handler.
contract InvariantFactory is VaultTestBase {
    FactoryHandler internal handler;
    CzarVaultFactory internal factory;
    address internal guardianKey = makeAddr("guardian");
    address internal admin = makeAddr("admin");

    function setUp() public override {
        super.setUp();
        factory = new CzarVaultFactory(_networkConfig(), _defaults(), guardianKey, admin);
        handler = new FactoryHandler(factory, usdc, admin, guardianKey, stranger);
        targetContract(address(handler));
    }

    /// @notice FAC-1 … FAC-5 after each handler call (one campaign; each message names its id).
    function invariant_factoryInvariants() public view {
        assertEq(handler.violations(), 0, handler.lastViolation());
        for (uint256 i = 0; i < handler.OWNER_COUNT(); i++) {
            address o = handler.owners(i);
            address vault = factory.vaultOf(o);
            assertEq(vault, handler.created(o), "FAC-1 vaultOf set once, by createVault");
            assertEq(factory.predictVault(o), handler.predictedAtStart(o), "FAC-5 prediction unchanged");
            if (vault == address(0)) continue;
            assertEq(ICzarVault(vault).owner(), o, "FAC-1 owner");
            assertTrue(factory.isVault(vault), "FAC-1 isVault");
            assertEq(vault, handler.predictedAtStart(o), "FAC-5 vault at the predicted address");
            assertEq(vault.codehash, handler.codeHashAtCreate(vault), "FAC-4 code unchanged");
            ICzarVault v = ICzarVault(vault);
            assertEq(
                keccak256(abi.encode(v.owner(), v.agentSigner(), v.autonomySigner(), v.evaluator(), v.factory())),
                handler.signersAtCreate(vault),
                "FAC-4 signers unchanged"
            );
        }
        assertEq(factory.guardianPaused(), handler.ghostPaused(), "FAC-2 pause flag moved only by the guardian");
        assertEq(factory.guardian(), handler.guardian(), "FAC-3 guardian changes only through applyGuardian");
        assertEq(usdc.balanceOf(address(factory)), 0, "FAC-2 the factory holds no USDC");
    }
}
