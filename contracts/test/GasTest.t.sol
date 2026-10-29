// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICzarVault} from "../src/interfaces/ICzarVault.sol";
import {USDC_ADDRESS, FINALIZE_CHUNK} from "../src/libraries/CzarConstants.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";
import {PayeeTree} from "./helpers/PayeeTree.sol";

/// @notice 07 PRD 12 §8 (T-024): the measured gas inputs of the routing rule (czar-vault.md §13,
///         server-planning-and-payment.md CZ-14 §5) and the P-256 precompile cost (security-and-testing.md §3.1, RV-034).
///         Each routing value is a whole transaction: 21,000 base + calldata + the call's execution gas (measured
///         with gasleft around the call, so it includes the CALL opcode: a slight overestimate).
///         `vm.snapshotValue` writes them to `snapshots/routing.json`, which T-024 copies to
///         `packages/config/gas-table.json`.
contract GasTest is VaultTestBase, PayeeTree {
    uint256 internal constant TX_BASE_GAS = 21_000;
    /// @dev The vault DELEGATECALLs one logic library per function; its address is cold in a real transaction
    ///      (2,600) but cannot be cooled here (forge does not expose linked library addresses): add the difference.
    uint256 internal constant LIBRARY_COLD_ACCESS = 2_500;
    uint256 internal constant CALLDATA_ZERO_BYTE_GAS = 4;
    uint256 internal constant CALLDATA_NONZERO_BYTE_GAS = 16;
    /// @dev Not measurable here (Circle's relayer calls the real GatewayMinter): the czar-vault.md §13 estimate.
    uint256 internal constant GATEWAY_MINT_GAS_ESTIMATE = 100_000;
    /// @dev The pocket's native send back to the vault (K4 sweep, RV-004): a plain transfer from an EOA.
    uint256 internal constant POCKET_SWEEP_GAS = 21_000;
    uint256 internal constant GAS_PRICE_FLOOR_WEI = 20 gwei; // p1-A6
    uint256 internal constant WEI_PER_ATOMIC = 1e12; // one 6-decimal USDC unit in native wei (A1-05)
    uint256 internal constant MAX_FEE_RATIO_BPS = 1_000; // routing.maxFeeRatioBps (D38)
    uint256 internal constant BPS = 10_000;
    uint256 internal constant P256_PRECOMPILE_GAS = 6_900; // A6-02
    uint256 internal constant P256_CALL_OVERHEAD_MAX = 1_000; // STATICCALL to a warm precompile, memory, gasleft
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    uint256 internal constant P256_PK = 0x1234;
    address internal constant P256_VERIFY = address(0x100);

    uint256 internal constant UNIT = 1_000;
    uint64 internal constant LIFETIME = 1 days;
    uint64 internal constant TTL = 300;
    uint256 internal constant CAP = 4 * ONE_USDC;
    uint256 internal constant POCKET_FUND = 500_000;
    uint256 internal constant GAS_GRANT_UNITS = 20_000; // payer.pocketGasUnits
    uint256 internal constant FEE = 3_500;
    string internal constant GROUP = "routing";

    uint256 internal constant PULLBACK_WINDOW = 100; // blocks
    uint64 internal env;
    uint256 internal gReserve;
    uint256 internal gSettleBase;
    uint256 internal gSettleIdx;
    uint256 internal gFinalize;
    uint256 internal gPocketSetup;
    uint256 internal gPocketDrain;

    function setUp() public override {
        super.setUp();
        usdc.mint(address(vault), CAP);
        ICzarVault.OpenEnvelopeParams memory p;
        p.cap = CAP;
        p.maxStepAmount = ONE_USDC;
        p.pocketCapBps = 2_500;
        p.expiresAt = uint64(block.timestamp + LIFETIME);
        p.categoryId = keccak256("category");
        p.payeeRoot = PAYEE_ROOT;
        vm.prank(owner);
        env = vault.openEnvelope(p);
    }

    // ───────────── Helpers ─────────────

    function _calldataGas(bytes memory data) internal pure returns (uint256 g) {
        for (uint256 i = 0; i < data.length; i++) {
            g += data[i] == 0 ? CALLDATA_ZERO_BYTE_GAS : CALLDATA_NONZERO_BYTE_GAS;
        }
    }

    /// @dev A forge test is one transaction, so storage touched earlier stays warm. Each routing value is a separate
    ///      transaction on chain, where every account and slot starts cold (EIP-2929): cool them first.
    function _coolAll() internal {
        vm.cool(address(vault));
        vm.cool(USDC_ADDRESS);
        vm.cool(address(gatewayWallet));
        vm.cool(address(gatewayMinter));
        vm.cool(address(vaultFactory));
        vm.cool(address(jobEscrow));
    }

    /// @dev Runs `data` against the vault as `caller` and returns the whole-transaction gas.
    function _tx(address caller, bytes memory data) internal returns (uint256) {
        _coolAll();
        vm.prank(caller);
        uint256 before = gasleft();
        (bool ok, bytes memory ret) = address(vault).call(data);
        uint256 used = before - gasleft(); // includes the CALL opcode's few hundred gas: a slight overestimate
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return TX_BASE_GAS + _calldataGas(data) + used + LIBRARY_COLD_ACCESS;
    }

    function _reserve(uint32 count) internal returns (uint64 rid, uint256 gas) {
        bytes memory data = abi.encodeCall(
            ICzarVault.reserve,
            (env, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, _proofBeef(), UNIT, count, uint64(block.timestamp + TTL))
        );
        rid = vault.reservationCount() + 1;
        gas = _tx(agent, data);
    }

    /// @dev USDC consumes indices 0 … used − 1, as a relayer's transfers would.
    function _consume(uint64 rid, uint32 used) internal {
        for (uint32 i = 0; i < used; i++) {
            usdc.consumeAuthorizationForTest(address(vault), PAYEE_BEEF, UNIT, vault.derivedNonce(rid, i));
        }
    }

    function _settleGas(uint64 rid, uint32 k) internal returns (uint256) {
        uint32[] memory idx = new uint32[](k);
        for (uint32 i = 0; i < k; i++) {
            idx[i] = i;
        }
        return _tx(stranger, abi.encodeCall(ICzarVault.settle, (rid, idx)));
    }

    /// @dev cVd(n) × BPS / maxFeeRatioBps at the 20 Gwei floor, rounded up (czar-vault.md §13).
    function _pocketThreshold(uint256 n) internal view returns (uint256) {
        uint256 chunks = (n + FINALIZE_CHUNK - 1) / FINALIZE_CHUNK;
        uint256 gas = gReserve + chunks * gSettleBase + n * gSettleIdx + gFinalize;
        uint256 numerator = gas * GAS_PRICE_FLOOR_WEI * BPS;
        uint256 denominator = WEI_PER_ATOMIC * MAX_FEE_RATIO_BPS * n;
        return (numerator + denominator - 1) / denominator;
    }

    // ───────────── Routing table (T-024) ─────────────

    function test_gas_routingTable() public {
        _measureReservationPath();
        _measurePocketSetup();
        _measurePocketDrain();
        vm.snapshotValue(GROUP, "routing.gas.reserve", gReserve);
        vm.snapshotValue(GROUP, "routing.gas.settleBase", gSettleBase);
        vm.snapshotValue(GROUP, "routing.gas.settleIdx", gSettleIdx);
        vm.snapshotValue(GROUP, "routing.gas.finalize", gFinalize);
        vm.snapshotValue(GROUP, "routing.gas.pocketSetup", gPocketSetup);
        vm.snapshotValue(GROUP, "routing.gas.pocketDrain", gPocketDrain);
        vm.snapshotValue(GROUP, "routing.gas.pocketSweep", POCKET_SWEEP_GAS);
        emit log_named_uint("pocketThreshold(1)", _pocketThreshold(1));
        emit log_named_uint("pocketThreshold(10)", _pocketThreshold(10));
        emit log_named_uint("pocketThreshold(100)", _pocketThreshold(100));
        assertGt(gSettleIdx, 0, "per-index slope");
        assertGt(gSettleBase, gSettleIdx, "base above slope");
        assertGt(gFinalize, TX_BASE_GAS, "finalize");
    }

    /// @dev reserve (one transaction whatever the count; the first reservation on a step, which writes `stepUsed` from
    ///      zero), settle base and per-index slope (a 1-index and a 32-index
    ///      call), finalize (one call releasing the unused index of a 1-index reservation after validBefore).
    function _measureReservationPath() internal {
        (uint64 rid, uint256 gas) = _reserve(uint32(FINALIZE_CHUNK)); // the first on its step: the costlier case
        gReserve = gas;
        (uint64 rid1,) = _reserve(1);
        _consume(rid, uint32(FINALIZE_CHUNK));
        _consume(rid1, 1);
        uint256 gSettle1 = _settleGas(rid1, 1);
        uint256 gSettle32 = _settleGas(rid, uint32(FINALIZE_CHUNK));
        gSettleIdx = (gSettle32 - gSettle1) / (FINALIZE_CHUNK - 1);
        gSettleBase = gSettle1 - gSettleIdx;
        (uint64 rid2,) = _reserve(1);
        vm.warp(block.timestamp + TTL + 1);
        gFinalize = _tx(stranger, abi.encodeCall(ICzarVault.finalize, (rid2, 0, 1)));
    }

    /// @dev registerPocket + grantPocketGas + the pocket's addDelegate + fundPocket.
    function _measurePocketSetup() internal {
        uint256 g = _tx(agent, abi.encodeCall(ICzarVault.registerPocket, (env, POCKET_B0C0, _proofB0c0())));
        g += _tx(agent, abi.encodeCall(ICzarVault.grantPocketGas, (POCKET_B0C0, GAS_GRANT_UNITS)));
        bytes memory delegateCall = abi.encodeCall(gatewayWallet.addDelegate, (USDC_ADDRESS, address(vault)));
        _coolAll();
        vm.prank(POCKET_B0C0);
        uint256 before = gasleft();
        gatewayWallet.addDelegate(USDC_ADDRESS, address(vault));
        g += TX_BASE_GAS + _calldataGas(delegateCall) + (before - gasleft());
        g += _tx(agent, abi.encodeCall(ICzarVault.fundPocket, (POCKET_B0C0, POCKET_FUND)));
        gPocketSetup = g;
    }

    /// @dev requestPullback + Circle's mint (the §13 estimate) + confirmPullback + writeOffPocket.
    function _measurePocketDrain() internal {
        uint256 maxBlock = block.number + PULLBACK_WINDOW;
        uint256 g =
            _tx(agent, abi.encodeCall(ICzarVault.requestPullback, (POCKET_B0C0, POCKET_FUND - FEE, FEE, maxBlock)));
        uint64 pid = vault.pullbackCount();
        ICzarVault.Pullback memory pb = vault.getPullback(pid);
        gatewayWallet.testBurn(USDC_ADDRESS, POCKET_B0C0, pb.value, address(vault));
        gatewayWallet.testBurn(USDC_ADDRESS, POCKET_B0C0, FEE, treasury);
        gatewayMinter.testMarkTransferSpecHashUsed(pb.transferSpecHash);
        g += GATEWAY_MINT_GAS_ESTIMATE;
        g += _tx(stranger, abi.encodeCall(ICzarVault.confirmPullback, (pid)));
        g += _tx(agent, abi.encodeCall(ICzarVault.writeOffPocket, (POCKET_B0C0)));
        gPocketDrain = g;
    }

    // ───────────── P-256 precompile (RV-034) ─────────────

    /// @dev The precompile at 0x100 verifies a valid signature for 6,900 gas (A6-02). Without it, OpenZeppelin's
    ///      P256 falls back to Solidity at over 100,000 gas, so this test also proves the arc profile is active.
    function test_gas_p256PrecompileCall() public view {
        bytes32 h = keccak256("czar p256 gas");
        (bytes32 r, bytes32 s) = vm.signP256(P256_PK, h);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
        (uint256 qx, uint256 qy) = vm.publicKeyP256(P256_PK);
        bytes memory input = abi.encode(h, r, s, qx, qy);
        uint256 before = gasleft();
        (bool ok, bytes memory out) = P256_VERIFY.staticcall(input);
        uint256 used = before - gasleft();
        assertTrue(ok, "precompile call");
        assertEq(out.length, 32, "no P-256 precompile at 0x100: run the suite with FOUNDRY_PROFILE=arc");
        assertEq(abi.decode(out, (uint256)), 1, "valid signature");
        assertGe(used, P256_PRECOMPILE_GAS, "at least the precompile price");
        assertLe(used, P256_PRECOMPILE_GAS + P256_CALL_OVERHEAD_MAX, "precompile, not the Solidity fallback");
    }
}
