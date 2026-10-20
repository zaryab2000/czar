// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICzarVault} from "../src/interfaces/ICzarVault.sol";
import {CzarHashing} from "../src/libraries/CzarHashing.sol";
import {KIND_USDC_3009} from "../src/libraries/CzarConstants.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";
import {PayeeTree} from "./helpers/PayeeTree.sol";

/// @notice 07 PRD 12 §5 (T-016 acceptance, deferred from PRD 07): czar-vault.md §6.5 exposure bound and INV-5.
///         1,000 signed authorizations against one `count = 10` reservation move at most `10 × unitAmount`.
contract ExposureTest is VaultTestBase, PayeeTree {
    uint256 internal constant AUTHORIZATIONS = 1_000;
    uint32 internal constant COUNT = 10;
    uint32 internal constant INDEX_SPREAD = 16; // indices 0 … 15: six of them are past the end
    uint256 internal constant UNIT = 50_000;
    uint64 internal constant LIFETIME = 1 days;
    uint64 internal constant TTL = 300;

    uint256 internal agentPk = uint256(keccak256(abi.encodePacked("agent"))); // forge-std makeAddr("agent") key
    address internal relayer = makeAddr("relayer");

    function test_exposure_thousandAuthorizations_moveAtMostCountTimesUnit() public {
        usdc.mint(address(vault), 2 * ONE_USDC);
        ICzarVault.OpenEnvelopeParams memory p;
        p.cap = 2 * ONE_USDC;
        p.maxStepAmount = ONE_USDC;
        p.expiresAt = uint64(block.timestamp + LIFETIME);
        p.categoryId = keccak256("category");
        p.payeeRoot = PAYEE_ROOT;
        vm.prank(owner);
        uint64 env = vault.openEnvelope(p);
        uint64 vb = uint64(block.timestamp + TTL);
        bytes32[] memory proof = _proofBeef();
        vm.prank(agent);
        uint64 rid = vault.reserve(env, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, proof, UNIT, COUNT, vb);

        uint256 before = usdc.balanceOf(PAYEE_BEEF);
        uint256 accepted;
        for (uint256 i = 0; i < AUTHORIZATIONS; i++) {
            if (_tryPay(rid, uint32(i % INDEX_SPREAD), vb)) accepted++;
        }
        uint256 moved = usdc.balanceOf(PAYEE_BEEF) - before;
        assertEq(accepted, COUNT, "one success per index below count");
        assertEq(moved, uint256(COUNT) * UNIT, "total moved = count x unitAmount");
        assertLe(moved, uint256(COUNT) * UNIT, "T-016 exposure bound");
    }

    /// @dev The relayer submits the agent's authorization for `index` through USDC; true if USDC accepted it.
    function _tryPay(uint64 rid, uint32 index, uint64 vb) internal returns (bool) {
        bytes32 nonce = vault.derivedNonce(rid, index);
        bytes32 digest = CzarHashing.typedDataHash(
            usdc.DOMAIN_SEPARATOR(),
            CzarHashing.transferWithAuthorizationHash(address(vault), PAYEE_BEEF, UNIT, 0, vb, nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);
        bytes memory sig = abi.encode(
            KIND_USDC_3009, rid, index, PAYEE_BEEF, UNIT, uint256(0), uint256(vb), nonce, abi.encodePacked(r, s, v)
        );
        vm.prank(relayer);
        try usdc.transferWithAuthorization(address(vault), PAYEE_BEEF, UNIT, 0, vb, nonce, sig) {
            return true;
        } catch {
            return false;
        }
    }
}
