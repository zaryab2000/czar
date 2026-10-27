// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICzarVault} from "../src/interfaces/ICzarVault.sol";
import {CzarHashing} from "../src/libraries/CzarHashing.sol";
import {KIND_USDC_3009, KIND_SL_RECEIPT, SECP256K1_HALF_N} from "../src/libraries/CzarConstants.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";
import {CzarVaultHarness} from "./helpers/CzarVaultHarness.sol";
import {PayeeTree} from "./helpers/PayeeTree.sol";

/// @dev 07 PRD 07 (T-016). czar-vault.md §6.1, §6.3, §6.4, §6.5, §15; INV-4, INV-5, INV-11.
contract SignatureTest is VaultTestBase, PayeeTree {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant INVALID = 0xffffffff;
    bytes32 internal constant SL_V1_TAG = 0x6caa53e9addf8fd5f6ef2283c076da956fffddb63f2677a5beeed71428d8601f;
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint64 internal constant LIFETIME = 1 days;
    uint64 internal constant TTL = 300;
    uint256 internal constant UNIT = 100_000;

    uint256 internal agentPk = uint256(keccak256(abi.encodePacked("agent"))); // forge-std makeAddr("agent") key
    address internal relayer = makeAddr("relayer");
    uint64 internal env;
    uint64 internal rid;
    uint64 internal vb;

    function setUp() public override {
        super.setUp();
        env = _openEnvelope(vault);
        vb = uint64(block.timestamp + TTL);
        rid = _reserve(vault, env, 4, false);
    }

    // ───────────── Helpers ─────────────

    function _openEnvelope(ICzarVault v) internal returns (uint64 id) {
        usdc.mint(address(v), 2 * ONE_USDC);
        ICzarVault.OpenEnvelopeParams memory p;
        p.cap = 2 * ONE_USDC;
        p.maxStepAmount = ONE_USDC;
        p.expiresAt = uint64(block.timestamp + LIFETIME);
        p.categoryId = keccak256("category");
        p.payeeRoot = PAYEE_ROOT;
        vm.prank(owner);
        id = v.openEnvelope(p);
    }

    function _reserve(ICzarVault v, uint64 id, uint32 count, bool digestMode) internal returns (uint64) {
        bytes32[] memory proof = _proofBeef();
        uint64 validBefore = uint64(block.timestamp + TTL);
        vm.prank(agent);
        return digestMode
            ? v.reserveWithDigests(id, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, proof, UNIT, count, validBefore)
            : v.reserve(id, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, proof, UNIT, count, validBefore);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _usdcDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes32) {
        return CzarHashing.typedDataHash(
            usdc.DOMAIN_SEPARATOR(),
            CzarHashing.transferWithAuthorizationHash(from, to, value, validAfter, validBefore, nonce)
        );
    }

    /// @dev Full USDC_3009 envelope (02 §6.3.1) for index `i` of `rid` on `vault`, with explicit fields.
    function _envelope(
        uint64 r,
        uint32 i,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint256 pk
    ) internal view returns (bytes memory sig, bytes32 digest) {
        digest = _usdcDigest(address(vault), to, value, validAfter, validBefore, nonce);
        sig = abi.encode(KIND_USDC_3009, r, i, to, value, validAfter, validBefore, nonce, _sign(pk, digest));
    }

    function _validEnvelope(uint32 i) internal view returns (bytes memory sig, bytes32 digest) {
        return _envelope(rid, i, PAYEE_BEEF, UNIT, 0, vb, vault.derivedNonce(rid, i), agentPk);
    }

    function _check(bytes32 digest, bytes memory sig) internal view returns (bytes4) {
        return vault.isValidSignature(digest, sig);
    }

    // ───────────── USDC_3009: the real path through USDC ─────────────

    function test_usdc3009_endToEnd_transferThenSettle() public {
        (bytes memory sig,) = _validEnvelope(2);
        bytes32 nonce = vault.derivedNonce(rid, 2);
        vm.prank(relayer); // Circle's relayer calls the bytes overload 0xcf092995 (A1-18)
        usdc.transferWithAuthorization(address(vault), PAYEE_BEEF, UNIT, 0, vb, nonce, sig);
        assertEq(usdc.balanceOf(PAYEE_BEEF), UNIT);
        assertTrue(usdc.authorizationState(address(vault), nonce));
        uint32[] memory idx = new uint32[](1);
        idx[0] = 2;
        vault.settle(rid, idx);
        assertEq(vault.getEnvelope(env).spent, UNIT);
    }

    function test_usdc3009_valid_returnsMagic() public view {
        (bytes memory sig, bytes32 digest) = _validEnvelope(0);
        assertEq(sig.length, 416);
        assertEq(_check(digest, sig), MAGIC);
    }

    /// @dev §6.5: the agent can sign many authorizations for one index; USDC accepts only the first (one nonce).
    function test_exposureBound_secondUseOfIndexFails() public {
        (bytes memory sig,) = _validEnvelope(1);
        bytes32 nonce = vault.derivedNonce(rid, 1);
        vm.prank(relayer);
        usdc.transferWithAuthorization(address(vault), PAYEE_BEEF, UNIT, 0, vb, nonce, sig);
        vm.prank(relayer);
        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        usdc.transferWithAuthorization(address(vault), PAYEE_BEEF, UNIT, 0, vb, nonce, sig);
    }

    // ───────────── USDC_3009: each check of §6.1 failing alone ─────────────

    function test_usdc3009_frozen_invalid() public {
        (bytes memory sig, bytes32 digest) = _validEnvelope(0);
        vm.prank(owner);
        vault.freeze();
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_paused_invalid() public {
        (bytes memory sig, bytes32 digest) = _validEnvelope(0);
        vaultFactory.setGuardianPaused(true);
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_reservationNotActive_invalid() public {
        (bytes memory sig, bytes32 digest) =
            _envelope(99, 0, PAYEE_BEEF, UNIT, 0, vb, vault.derivedNonce(99, 0), agentPk);
        assertEq(_check(digest, sig), INVALID); // unknown reservation
        (sig, digest) = _validEnvelope(0);
        vm.warp(vb + 1);
        vault.finalize(rid, 0, 1); // now Finalizing
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_indexOutOfRange_invalid() public view {
        (bytes memory sig, bytes32 digest) =
            _envelope(rid, 4, PAYEE_BEEF, UNIT, 0, vb, vault.derivedNonce(rid, 4), agentPk);
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_doneIndex_invalid() public {
        (bytes memory sig, bytes32 digest) = _validEnvelope(0);
        usdc.consumeAuthorizationForTest(address(vault), PAYEE_BEEF, UNIT, vault.derivedNonce(rid, 0));
        uint32[] memory idx = new uint32[](1);
        vault.settle(rid, idx); // index 0 is done
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_wrongNonce_invalid() public view {
        (bytes memory sig, bytes32 digest) =
            _envelope(rid, 0, PAYEE_BEEF, UNIT, 0, vb, vault.derivedNonce(rid, 1), agentPk);
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_wrongPayee_invalid() public view {
        (bytes memory sig, bytes32 digest) =
            _envelope(rid, 0, PAYEE_CAFE, UNIT, 0, vb, vault.derivedNonce(rid, 0), agentPk);
        assertEq(_check(digest, sig), INVALID);
    }

    /// @dev RV-035 named test.
    function test_usdc3009_valueBelowUnitAmount_invalid() public view {
        (bytes memory sig, bytes32 digest) =
            _envelope(rid, 0, PAYEE_BEEF, UNIT - 1, 0, vb, vault.derivedNonce(rid, 0), agentPk);
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_valueAboveUnitAmount_invalid() public view {
        (bytes memory sig, bytes32 digest) =
            _envelope(rid, 0, PAYEE_BEEF, UNIT + 1, 0, vb, vault.derivedNonce(rid, 0), agentPk);
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_validAfterNonZero_invalid() public view {
        (bytes memory sig, bytes32 digest) =
            _envelope(rid, 0, PAYEE_BEEF, UNIT, 1, vb, vault.derivedNonce(rid, 0), agentPk);
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_wrongValidBefore_invalid() public view {
        (bytes memory sig, bytes32 digest) =
            _envelope(rid, 0, PAYEE_BEEF, UNIT, 0, vb - 1, vault.derivedNonce(rid, 0), agentPk);
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_expired_invalid() public {
        (bytes memory sig, bytes32 digest) = _validEnvelope(0);
        vm.warp(vb);
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_digestMismatch_invalid() public view {
        (bytes memory sig,) = _validEnvelope(0);
        assertEq(_check(keccak256("other"), sig), INVALID);
    }

    function test_usdc3009_wrongSigner_invalid() public view {
        (bytes memory sig, bytes32 digest) =
            _envelope(rid, 0, PAYEE_BEEF, UNIT, 0, vb, vault.derivedNonce(rid, 0), 0xBAD);
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_highS_invalid() public view {
        bytes32 nonce = vault.derivedNonce(rid, 0);
        bytes32 digest = _usdcDigest(address(vault), PAYEE_BEEF, UNIT, 0, vb, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);
        bytes32 highS = bytes32(SECP256K1_N - uint256(s)); // same signature, malleable form
        uint8 flippedV = v == 27 ? 28 : 27;
        assertGt(uint256(highS), SECP256K1_HALF_N);
        bytes memory sig = abi.encode(
            KIND_USDC_3009,
            rid,
            uint32(0),
            PAYEE_BEEF,
            UNIT,
            uint256(0),
            uint256(vb),
            nonce,
            abi.encodePacked(r, highS, flippedV)
        );
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_badV_invalid() public view {
        bytes32 nonce = vault.derivedNonce(rid, 0);
        bytes32 digest = _usdcDigest(address(vault), PAYEE_BEEF, UNIT, 0, vb, nonce);
        (, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);
        bytes memory sig = abi.encode(
            KIND_USDC_3009,
            rid,
            uint32(0),
            PAYEE_BEEF,
            UNIT,
            uint256(0),
            uint256(vb),
            nonce,
            abi.encodePacked(r, s, uint8(1))
        );
        assertEq(_check(digest, sig), INVALID);
    }

    // ───────────── USDC_3009: malformed bytes never revert ─────────────

    function test_usdc3009_wrongLength_invalid() public view {
        (bytes memory sig, bytes32 digest) = _validEnvelope(0);
        assertEq(_check(digest, abi.encodePacked(sig, bytes1(0))), INVALID);
        bytes memory shorter = new bytes(415);
        for (uint256 i = 0; i < 415; i++) {
            shorter[i] = sig[i];
        }
        assertEq(_check(digest, shorter), INVALID);
    }

    function test_usdc3009_badOffsetOrSigLength_invalid() public view {
        (bytes memory sig, bytes32 digest) = _validEnvelope(0);
        bytes memory a = sig;
        a[32 * 8 + 31] = 0x00; // offset word no longer 0x120
        assertEq(_check(digest, a), INVALID);
        (bytes memory b,) = _validEnvelope(0);
        b[32 * 9 + 31] = 0x40; // agentSig length word no longer 65
        assertEq(_check(digest, b), INVALID);
    }

    function test_usdc3009_outOfRangeHeadWords_invalidNotRevert() public view {
        uint256[3] memory words = [uint256(1), 2, 3]; // reservationId (uint64), index (uint32), to (address)
        for (uint256 k = 0; k < 3; k++) {
            (bytes memory sig, bytes32 digest) = _validEnvelope(0);
            sig[32 * words[k]] = 0x01; // set a high byte: out of range for the narrow type
            assertEq(_check(digest, sig), INVALID);
        }
    }

    // ───────────── 65-byte fallback (§6.4) ─────────────

    function test_fallback_digestMode_validThroughUsdc() public {
        uint64 r2 = _reserve(vault, env, 2, true);
        bytes32 nonce = vault.derivedNonce(r2, 1);
        bytes32 digest = _usdcDigest(address(vault), PAYEE_BEEF, UNIT, 0, vb, nonce);
        bytes memory sig65 = _sign(agentPk, digest);
        assertEq(_check(digest, sig65), MAGIC);
        vm.prank(relayer);
        usdc.transferWithAuthorization(address(vault), PAYEE_BEEF, UNIT, 0, vb, nonce, sig65);
        assertEq(usdc.balanceOf(PAYEE_BEEF), UNIT);
    }

    function test_fallback_unregisteredDigest_invalid() public view {
        bytes32 digest = keccak256("not registered");
        assertEq(_check(digest, _sign(agentPk, digest)), INVALID);
    }

    function test_fallback_envelopeModeDigest_invalid() public view {
        (, bytes32 digest) = _validEnvelope(0); // envelope-mode reservation: no digest slot
        assertEq(_check(digest, _sign(agentPk, digest)), INVALID);
    }

    function test_fallback_frozenOrExpired_invalid() public {
        uint64 r2 = _reserve(vault, env, 1, true);
        bytes32 digest = _usdcDigest(address(vault), PAYEE_BEEF, UNIT, 0, vb, vault.derivedNonce(r2, 0));
        bytes memory sig65 = _sign(agentPk, digest);
        vm.prank(owner);
        vault.freeze();
        assertEq(_check(digest, sig65), INVALID);
        vm.prank(owner);
        vault.unfreeze();
        assertEq(_check(digest, sig65), MAGIC);
        vm.warp(vb);
        assertEq(_check(digest, sig65), INVALID); // validBefore reached (D88, G-39)
    }

    function test_fallback_wrongSigner_invalid() public {
        uint64 r2 = _reserve(vault, env, 1, true);
        bytes32 digest = _usdcDigest(address(vault), PAYEE_BEEF, UNIT, 0, vb, vault.derivedNonce(r2, 0));
        assertEq(_check(digest, _sign(0xBAD, digest)), INVALID);
    }

    // ───────────── SL_RECEIPT (§6.3, RV-013) ─────────────

    function _receipt() internal pure returns (ICzarVault.SlReceipt memory r) {
        r.paymentRefHash = bytes32(uint256(0x3333333333333333333333333333333333333333333333333333333333333333));
        r.requestCommit = bytes32(uint256(0x4444444444444444444444444444444444444444444444444444444444444444));
        r.responseCommit = bytes32(uint256(0x5555555555555555555555555555555555555555555555555555555555555555));
        r.statusCode = 200;
        r.originAsserted = "https://merchant.example";
        r.requirementsHashSeen = bytes32(uint256(0x6666666666666666666666666666666666666666666666666666666666666666));
        r.tRequest = 1760790000;
        r.tPaymentSigned = 1760790001;
        r.tComplete = 1760790003;
        r.disclosure = 2;
        r.createdAt = 1760790004;
    }

    /// @dev The SL digest (vector 0x8bef0825…d561 on 5042002) and an agent signature bound to vault `v`.
    function _slSig(ICzarVault v, ICzarVault.SlReceipt memory r)
        internal
        view
        returns (bytes memory sig, bytes32 digest)
    {
        bytes32 structHash = CzarHashing.receiptStructHash(r);
        digest = CzarHashing.typedDataHash(
            CzarHashing.domainSeparatorNoContract(keccak256("SelectionLayer"), keccak256("1"), block.chainid),
            structHash
        );
        bytes32 vaultDomain =
            CzarHashing.domainSeparatorFull(keccak256("CzarVault"), keccak256("1"), block.chainid, address(v));
        bytes32 bound = CzarHashing.typedDataHash(vaultDomain, CzarHashing.receiptAttestationStructHash(structHash));
        sig = abi.encode(KIND_SL_RECEIPT, r, _sign(agentPk, bound));
    }

    function test_slReceipt_valid_returnsMagic() public view {
        (bytes memory sig, bytes32 digest) = _slSig(vault, _receipt());
        assertEq(digest, 0x8bef0825cbab5aff373a3651d22ee4169a09d1504ad6eb30c02277d37725d561); // the vector
        assertEq(sig.length, 704);
        assertEq(_check(digest, sig), MAGIC);
    }

    function test_slReceipt_notGatedByFreezeOrPause() public {
        (bytes memory sig, bytes32 digest) = _slSig(vault, _receipt());
        vm.prank(owner);
        vault.freeze();
        vaultFactory.setGuardianPaused(true);
        assertEq(_check(digest, sig), MAGIC);
    }

    /// @dev RV-013 named test.
    function test_slReceipt_otherSlType_invalid() public view {
        (bytes memory sig,) = _slSig(vault, _receipt());
        bytes32 correctionDigest = keccak256("a Correction or any other SL type");
        assertEq(_check(correctionDigest, sig), INVALID);
    }

    /// @dev RV-013 named test.
    function test_slReceipt_signatureForVaultA_invalidOnVaultB() public {
        ICzarVault vaultB = vaultFactory.deploy(makeAddr("ownerB")); // same agentSigner (factory defaults)
        (bytes memory sigForA, bytes32 digest) = _slSig(vault, _receipt());
        assertEq(vault.isValidSignature(digest, sigForA), MAGIC);
        assertEq(vaultB.isValidSignature(digest, sigForA), INVALID);
    }

    /// @dev RV-013 named test.
    function test_slReceipt_v1Tag_invalid() public view {
        (bytes memory sig, bytes32 digest) = _slSig(vault, _receipt());
        for (uint256 i = 0; i < 32; i++) {
            sig[i] = SL_V1_TAG[i];
        }
        assertEq(_check(digest, sig), INVALID);
    }

    function test_slReceipt_originLengths_valid() public view {
        string[4] memory origins = ["", "a", "https://exactly-thirty-two-chars", "https://thirty-three-characters.io"];
        for (uint256 i = 0; i < origins.length; i++) {
            ICzarVault.SlReceipt memory r = _receipt();
            r.originAsserted = origins[i];
            (bytes memory sig, bytes32 digest) = _slSig(vault, r);
            assertEq(_check(digest, sig), MAGIC);
        }
    }

    function test_slReceipt_malformed_invalidNotRevert() public view {
        (bytes memory sig, bytes32 digest) = _slSig(vault, _receipt());
        bytes memory shortSig = new bytes(100);
        for (uint256 i = 0; i < 32; i++) {
            shortSig[i] = sig[i];
        }
        assertEq(_check(digest, shortSig), INVALID); // shorter than 672: no read past the end
        bytes memory a = sig;
        a[0x60 + 32 * 3] = 0x01; // statusCode word out of uint16 range
        assertEq(_check(digest, a), INVALID);
        (bytes memory b,) = _slSig(vault, _receipt());
        b[0x200 + 31] = 0x40; // string length word no longer matches the total length
        assertEq(_check(digest, b), INVALID);
        (bytes memory c,) = _slSig(vault, _receipt());
        c[0x60 + 32 * 9] = 0x01; // outcome word out of uint8 range
        assertEq(_check(digest, c), INVALID);
    }

    // ───────────── Dispatcher ─────────────

    function test_unknownKindOrShort_invalid() public view {
        bytes32 digest = keccak256("d");
        assertEq(_check(digest, ""), INVALID);
        assertEq(_check(digest, hex"01"), INVALID);
        assertEq(_check(digest, abi.encode(keccak256("unknown kind"), uint256(1))), INVALID);
    }

    function testFuzz_isValidSignature_neverReverts(bytes32 digest, uint8 kindSel, bytes calldata blob) public view {
        bytes32[4] memory kinds = [
            KIND_USDC_3009, KIND_SL_RECEIPT, 0xf453aa3365355a8cf99e674b4443d5009b132245c53a3eb3b5a14953d97265f2, digest
        ];
        bytes4 result = vault.isValidSignature(digest, abi.encodePacked(kinds[kindSel % 4], blob));
        assertTrue(result == INVALID || result == MAGIC);
    }

    function testFuzz_usdc3009_corruptedByte_neverReverts(uint256 pos, uint8 value) public view {
        (bytes memory sig, bytes32 digest) = _validEnvelope(0);
        pos = bound(pos, 32, sig.length - 1);
        sig[pos] = bytes1(value);
        bytes4 result = vault.isValidSignature(digest, sig);
        assertTrue(result == INVALID || result == MAGIC);
    }

    function testFuzz_slReceipt_corruptedByte_neverReverts(uint256 pos, uint8 value) public view {
        (bytes memory sig, bytes32 digest) = _slSig(vault, _receipt());
        pos = bound(pos, 32, sig.length - 1);
        sig[pos] = bytes1(value);
        bytes4 result = vault.isValidSignature(digest, sig);
        assertTrue(result == INVALID || result == MAGIC);
    }
}
