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
