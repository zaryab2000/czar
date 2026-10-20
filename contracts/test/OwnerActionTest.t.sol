// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {ICzarVault} from "../src/interfaces/ICzarVault.sol";
import {CzarHashing} from "../src/libraries/CzarHashing.sol";
import {USDC_ADDRESS, PULLBACK_CANCEL_DELAY_BLOCKS, FORCE_CLOSE_DELAY} from "../src/libraries/CzarConstants.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";
import {PayeeTree} from "./helpers/PayeeTree.sol";

/// @dev 07 PRD 10 part B (T-019). czar-vault.md §7, §15.9; 02 §6.2 OwnerAction; RV-033, RV-034, H2.
contract OwnerActionTest is VaultTestBase, PayeeTree {
    uint256 internal constant PASSKEY_PK = 0xA11CE; // test-only P-256 private key
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    bytes32 internal constant RP_ID_HASH = 0x49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d9763; // sha256("localhost")
    bytes1 internal constant FLAGS_UP_UV = 0x05;
    bytes32 internal constant CATEGORY = keccak256("category");
    uint256 internal constant FEE = 3_500;

    bytes32 internal qx;
    bytes32 internal qy;

    function setUp() public override {
        super.setUp();
        _fundVault(10 * ONE_USDC);
        (uint256 x, uint256 y) = vm.publicKeyP256(PASSKEY_PK);
        (qx, qy) = (bytes32(x), bytes32(y));
        vm.prank(owner);
        vault.setPasskey(qx, qy, RP_ID_HASH);
    }

    // ───────────── Helpers ─────────────

    function _digest(uint8 action, bytes memory payload, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("CzarVault"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        return CzarHashing.typedDataHash(
            domain, CzarHashing.ownerActionStructHash(action, keccak256(payload), nonce, deadline)
        );
    }

    /// @dev A browser-shaped WebAuthn assertion over `digest` (czar-vault.md §7), low-s unless `highS`.
    function _assertion(bytes32 digest, bytes32 rpIdHash, bool highS)
        internal
        pure
        returns (ICzarVault.WebAuthnAuth memory a)
    {
        bytes memory authenticatorData = abi.encodePacked(rpIdHash, FLAGS_UP_UV, uint32(0));
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(digest)),
            '","origin":"http://localhost"}'
        );
        bytes32 messageHash = sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(PASSKEY_PK, messageHash);
        bool isHigh = uint256(s) > P256_N / 2;
        if (isHigh != highS) s = bytes32(P256_N - uint256(s));
        a.challengeIndex = 23;
        a.typeIndex = 1;
        a.r = r;
        a.s = s;
        a.authenticatorData = authenticatorData;
        a.clientDataJSON = clientDataJSON;
    }

    /// @dev Signs the current nonce and relays through a stranger, as Czar's relayer would.
    function _exec(ICzarVault.OwnerActionKind kind, bytes memory payload) internal {
        uint8 action = uint8(kind);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = vault.ownerActionNonce();
        ICzarVault.WebAuthnAuth memory a = _assertion(_digest(action, payload, nonce, deadline), RP_ID_HASH, false);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.OwnerActionExecuted(action, nonce);
        vm.prank(stranger);
        vault.executeOwnerAction(action, payload, deadline, a);
        assertEq(vault.ownerActionNonce(), nonce + 1);
    }

    // ───────────── Checks (§15.9 order) ─────────────

    function test_ownerAction_freeze_viaPasskey() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Frozen(owner); // Frozen.by is the owner on the passkey path (§15.4)
        _exec(ICzarVault.OwnerActionKind.Freeze, "");
        assertTrue(vault.frozen());
    }

    function test_ownerAction_passkeyNotSet_reverts() public {
        vault = vaultFactory.deploy(makeAddr("owner2"));
        ICzarVault.WebAuthnAuth memory a;
        uint256 deadline = block.timestamp + 1 hours;
        vm.expectRevert(ICzarVault.PasskeyNotSet.selector);
        vault.executeOwnerAction(3, "", deadline, a);
    }

    function test_ownerAction_expiredOrUnknown_reverts() public {
        uint256 past = block.timestamp - 1;
        uint256 deadline = block.timestamp + 1 hours;
        ICzarVault.WebAuthnAuth memory a = _assertion(_digest(3, "", 0, past), RP_ID_HASH, false);
        vm.expectRevert(ICzarVault.Expired.selector);
        vault.executeOwnerAction(3, "", past, a);
        vm.expectRevert(ICzarVault.UnknownAction.selector);
        vault.executeOwnerAction(0, "", deadline, a);
        vm.expectRevert(ICzarVault.UnknownAction.selector);
        vault.executeOwnerAction(18, "", deadline, a);
    }

    function test_ownerAction_replay_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        ICzarVault.WebAuthnAuth memory a = _assertion(_digest(3, "", 0, deadline), RP_ID_HASH, false);
        vault.executeOwnerAction(3, "", deadline, a);
        vm.expectRevert(ICzarVault.InvalidPasskeyAssertion.selector);
        vault.executeOwnerAction(3, "", deadline, a); // nonce is now 1
    }

    function test_ownerAction_otherPayloadOrAction_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory payload = abi.encode(owner, ONE_USDC);
        ICzarVault.WebAuthnAuth memory a = _assertion(_digest(5, payload, 0, deadline), RP_ID_HASH, false);
        bytes memory other = abi.encode(stranger, ONE_USDC);
        vm.expectRevert(ICzarVault.InvalidPasskeyAssertion.selector);
        vault.executeOwnerAction(5, other, deadline, a);
        vm.expectRevert(ICzarVault.InvalidPasskeyAssertion.selector);
        vault.executeOwnerAction(3, payload, deadline, a);
        vm.expectRevert(ICzarVault.InvalidPasskeyAssertion.selector);
        vault.executeOwnerAction(5, payload, deadline + 1, a);
    }

    /// @dev §7 / D88 G-59: the RP ID hash is checked by the vault.
    function test_ownerAction_wrongRpIdHash_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        ICzarVault.WebAuthnAuth memory a = _assertion(_digest(3, "", 0, deadline), sha256("evil.example"), false);
        vm.expectRevert(ICzarVault.InvalidPasskeyAssertion.selector);
        vault.executeOwnerAction(3, "", deadline, a);
    }

    /// @dev RV-034: high-s is refused; the normalised signature over the same message is accepted.
    function test_passkey_highS_refusedThenNormalisedAccepted() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _digest(3, "", 0, deadline);
        ICzarVault.WebAuthnAuth memory high = _assertion(digest, RP_ID_HASH, true);
        vm.expectRevert(ICzarVault.InvalidPasskeyAssertion.selector);
        vault.executeOwnerAction(3, "", deadline, high);
        high.s = bytes32(P256_N - uint256(high.s));
        vault.executeOwnerAction(3, "", deadline, high);
        assertTrue(vault.frozen());
    }

    function test_ownerAction_badPayload_revertsRaw() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory payload = hex"01";
        ICzarVault.WebAuthnAuth memory a = _assertion(_digest(5, payload, 0, deadline), RP_ID_HASH, false);
        vm.expectRevert();
        vault.executeOwnerAction(5, payload, deadline, a);
        assertEq(vault.ownerActionNonce(), 0); // the whole call reverted
    }

    /// @dev §15.9: action 1 sets approverIsOwner.
    function test_ownerAction_openEnvelope_approverIsOwner() public {
        ICzarVault.OpenEnvelopeParams memory p = _envelopeParams(0);
        _exec(ICzarVault.OwnerActionKind.OpenEnvelope, abi.encode(p));
        assertTrue(vault.getEnvelope(1).approverIsOwner);
    }

    // ───────────── Every action dispatches (§7 table) ─────────────

    function _envelopeParams(uint16 pocketBps) internal view returns (ICzarVault.OpenEnvelopeParams memory p) {
        p.cap = 4 * ONE_USDC;
        p.maxStepAmount = ONE_USDC;
        p.pocketCapBps = pocketBps;
        p.expiresAt = uint64(block.timestamp + 1 days);
        p.categoryId = CATEGORY;
        p.payeeRoot = PAYEE_ROOT;
    }

    function test_ownerAction_everyKindDispatches() public {
        // 7 SET_PASSKEY (same key, so later assertions still verify)
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.PasskeySet(keccak256(abi.encode(qx, qy)));
        _exec(ICzarVault.OwnerActionKind.SetPasskey, abi.encode(qx, qy, RP_ID_HASH));
        // 2 SET_LIMITS, 11 RAISE_AUTO_LIMIT (empty sig, current period), 12 LOWER_AUTO_LIMIT
        _exec(ICzarVault.OwnerActionKind.SetLimits, abi.encode(CATEGORY, 10 * ONE_USDC, ONE_USDC));
        _exec(ICzarVault.OwnerActionKind.RaiseAutoLimit, abi.encode(CATEGORY, 2 * ONE_USDC));
        assertEq(vault.getLimits(CATEGORY).autoLimit, 2 * ONE_USDC);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.AutoLimitLowered(CATEGORY, 2 * ONE_USDC, ONE_USDC, owner);
        _exec(ICzarVault.OwnerActionKind.LowerAutoLimit, abi.encode(CATEGORY, ONE_USDC));
        // 1 OPEN_ENVELOPE with a pocket share
        _exec(ICzarVault.OwnerActionKind.OpenEnvelope, abi.encode(_envelopeParams(2500)));
        uint64 env = 1;
        bytes32[] memory pocketProof = _proofB0c0();
        vm.prank(agent);
        vault.registerPocket(env, POCKET_B0C0, pocketProof);
        vm.prank(POCKET_B0C0);
        gatewayWallet.addDelegate(USDC_ADDRESS, address(vault));
        vm.prank(agent);
        vault.fundPocket(POCKET_B0C0, 500_000);
        // 13 REQUEST_PULLBACK, 14 CANCEL_PULLBACK
        uint256 maxBlock = block.number + 100;
        _exec(ICzarVault.OwnerActionKind.RequestPullback, abi.encode(POCKET_B0C0, 100_000, FEE, maxBlock));
        assertEq(vault.pullbackCount(), 1);
        vm.roll(maxBlock + PULLBACK_CANCEL_DELAY_BLOCKS);
        _exec(ICzarVault.OwnerActionKind.CancelPullback, abi.encode(uint64(1)));
        assertEq(uint8(vault.getPullback(1).state), uint8(ICzarVault.PullbackState.Cancelled));
        // 10 RECORD_MANUAL_RETURN, 15 WRITE_OFF_POCKET
        _exec(ICzarVault.OwnerActionKind.RecordManualReturn, abi.encode(POCKET_B0C0, 100_000));
        assertEq(vault.getPocket(POCKET_B0C0).outstanding, 400_000);
        _exec(ICzarVault.OwnerActionKind.WriteOffPocket, abi.encode(POCKET_B0C0));
        assertEq(uint8(vault.getPocket(POCKET_B0C0).state), uint8(ICzarVault.PocketState.Closed));
        // 17 CANCEL_JOB
        bytes32[] memory jobProof = _proofD00d();
        uint64 jobExpiry = uint64(block.timestamp + 1 hours);
        vm.prank(agent);
        bytes32 jobKey =
            vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, jobProof, jobExpiry, keccak256("job"));
        _exec(ICzarVault.OwnerActionKind.CancelJob, abi.encode(jobKey));
        assertEq(uint8(vault.getJob(jobKey).state), uint8(ICzarVault.JobState.Released));
        // 8 CLOSE_ENVELOPE
        _exec(ICzarVault.OwnerActionKind.CloseEnvelope, abi.encode(env));
        assertEq(uint8(vault.getEnvelope(env).state), uint8(ICzarVault.EnvelopeState.Closed));
        // 9 FORCE_CLOSE_ENVELOPE
        vm.prank(owner);
        uint64 env2 = vault.openEnvelope(_envelopeParams(0));
        vm.warp(vault.getEnvelope(env2).expiresAt + FORCE_CLOSE_DELAY);
        _exec(ICzarVault.OwnerActionKind.ForceCloseEnvelope, abi.encode(env2));
        assertEq(uint8(vault.getEnvelope(env2).state), uint8(ICzarVault.EnvelopeState.Closed));
        // 16 SET_MAX_PULLBACK_FEE, 6 ROTATE_SIGNERS
        _exec(ICzarVault.OwnerActionKind.SetMaxPullbackFee, abi.encode(uint256(5_000)));
        assertEq(vault.maxPullbackFee(), 5_000);
        address newEvaluator = makeAddr("newEvaluator");
        _exec(ICzarVault.OwnerActionKind.RotateSigners, abi.encode(agent, autonomy, newEvaluator));
        assertEq(vault.evaluator(), newEvaluator);
        // 5 WITHDRAW
        uint256 before = usdc.balanceOf(owner);
        _exec(ICzarVault.OwnerActionKind.Withdraw, abi.encode(owner, ONE_USDC));
        assertEq(usdc.balanceOf(owner), before + ONE_USDC);
        // 3 FREEZE, 4 UNFREEZE
        _exec(ICzarVault.OwnerActionKind.Freeze, "");
        _exec(ICzarVault.OwnerActionKind.Unfreeze, "");
        assertFalse(vault.frozen());
        assertEq(vault.ownerActionNonce(), 17); // every action ran exactly once
        uint256 deadline = block.timestamp + 1 hours;
        ICzarVault.WebAuthnAuth memory a = _assertion(_digest(18, "", 17, deadline), RP_ID_HASH, false);
        vm.expectRevert(ICzarVault.UnknownAction.selector);
        vault.executeOwnerAction(18, "", deadline, a);
    }

    /// @dev H2 named test: CANCEL_JOB through the passkey path.
    function test_ownerAction_cancelJob() public {
        vm.prank(owner);
        uint64 env = vault.openEnvelope(_envelopeParams(0));
        bytes32[] memory proof = _proofD00d();
        uint64 jobExpiry = uint64(block.timestamp + 1 hours);
        vm.prank(agent);
        bytes32 jobKey = vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, jobExpiry, keccak256("job"));
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobCancelled(jobKey);
        _exec(ICzarVault.OwnerActionKind.CancelJob, abi.encode(jobKey));
        assertEq(uint8(vault.getJob(jobKey).state), uint8(ICzarVault.JobState.Released));
    }

    /// @dev T-019 acceptance: an assertion without user verification (UV bit) is refused (REQUIRE_UV).
    function test_ownerAction_missingUv_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _digest(3, "", 0, deadline);
        ICzarVault.WebAuthnAuth memory a = _assertion(digest, RP_ID_HASH, false);
        bytes memory upOnly = abi.encodePacked(RP_ID_HASH, bytes1(0x01), uint32(0)); // UP set, UV clear
        bytes32 messageHash = sha256(abi.encodePacked(upOnly, sha256(bytes(a.clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(PASSKEY_PK, messageHash);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
        (a.r, a.s, a.authenticatorData) = (r, s, upOnly);
        vm.expectRevert(ICzarVault.InvalidPasskeyAssertion.selector);
        vault.executeOwnerAction(3, "", deadline, a);
    }
}
