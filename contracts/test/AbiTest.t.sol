// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {ICzarVault} from "../src/interfaces/ICzarVault.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";
import {PayeeTree} from "./helpers/PayeeTree.sol";

/// @dev 07 PRD 12 (T-014, T-031; RV-060). The canonical ABI is `ICzarVault.sol`: every event topic and error selector
///      equals the hash of its signature as the interface writes it (the strings the indexer's decoders are generated
///      from), and the vault emits no event that is not in the interface.
contract AbiTest is VaultTestBase, PayeeTree {
    function _events() internal pure returns (string[] memory sigs, bytes32[] memory topics) {
        sigs = new string[](34);
        topics = new bytes32[](34);
        (sigs[0], topics[0]) =
        (
            "EnvelopeOpened(uint64,bytes32,bytes32,uint256,bytes32,bytes32,uint256,uint16,uint64,bool)",
            ICzarVault.EnvelopeOpened.selector
        );
        (sigs[1], topics[1]) = ("EnvelopeClosed(uint64,uint256,uint256)", ICzarVault.EnvelopeClosed.selector);
        (sigs[2], topics[2]) =
        ("EnvelopeForceClosed(uint64,uint256,uint256,uint256)", ICzarVault.EnvelopeForceClosed.selector);
        (sigs[3], topics[3]) =
        ("Reserved(uint64,uint64,address,uint32,uint256,uint32,uint64,uint8)", ICzarVault.Reserved.selector);
        (sigs[4], topics[4]) = ("StepUsed(uint64,uint32,uint256)", ICzarVault.StepUsed.selector);
        (sigs[5], topics[5]) = ("Settled(uint64,uint32,uint256)", ICzarVault.Settled.selector);
        (sigs[6], topics[6]) = ("Released(uint64,uint32,uint256)", ICzarVault.Released.selector);
        (sigs[7], topics[7]) = ("ReservationFinal(uint64,uint32,uint32)", ICzarVault.ReservationFinal.selector);
        (sigs[8], topics[8]) = ("PocketRegistered(uint64,address)", ICzarVault.PocketRegistered.selector);
        (sigs[9], topics[9]) = ("PocketGasGranted(address,uint256)", ICzarVault.PocketGasGranted.selector);
        (sigs[10], topics[10]) = ("PocketFunded(address,uint64,uint256,uint256)", ICzarVault.PocketFunded.selector);
        (sigs[11], topics[11]) =
        (
            "PullbackRequested(uint64,address,uint256,uint256,uint256,bytes32,bytes32)",
            ICzarVault.PullbackRequested.selector
        );
        (sigs[12], topics[12]) =
        ("PullbackConfirmed(uint64,address,uint256,bool)", ICzarVault.PullbackConfirmed.selector);
        (sigs[13], topics[13]) = ("PullbackCancelled(uint64)", ICzarVault.PullbackCancelled.selector);
        (sigs[14], topics[14]) = ("PocketClosed(address,uint256)", ICzarVault.PocketClosed.selector);
        (sigs[15], topics[15]) = ("ManualReturnRecorded(address,uint256)", ICzarVault.ManualReturnRecorded.selector);
        (sigs[16], topics[16]) = ("ShortfallRecorded(uint64,uint256,uint256)", ICzarVault.ShortfallRecorded.selector);
        (sigs[17], topics[17]) = ("MaxPullbackFeeSet(uint256,uint256)", ICzarVault.MaxPullbackFeeSet.selector);
        (sigs[18], topics[18]) =
        (
            "JobOpened(bytes32,uint64,address,uint32,address,uint256,address,uint256,bytes32)",
            ICzarVault.JobOpened.selector
        );
        (sigs[19], topics[19]) = ("JobFunded(bytes32,uint256)", ICzarVault.JobFunded.selector);
        (sigs[20], topics[20]) = ("JobSynced(bytes32,uint8,bool)", ICzarVault.JobSynced.selector);
        (sigs[21], topics[21]) = ("JobRefunded(bytes32,uint256,bool)", ICzarVault.JobRefunded.selector);
        (sigs[22], topics[22]) = ("JobCancelled(bytes32)", ICzarVault.JobCancelled.selector);
        (sigs[23], topics[23]) = ("LimitsSet(bytes32,uint256,uint256)", ICzarVault.LimitsSet.selector);
        (sigs[24], topics[24]) =
        ("AutoLimitRaised(bytes32,uint256,uint256,uint64)", ICzarVault.AutoLimitRaised.selector);
        (sigs[25], topics[25]) =
        ("AutoLimitLowered(bytes32,uint256,uint256,address)", ICzarVault.AutoLimitLowered.selector);
        (sigs[26], topics[26]) = ("Frozen(address)", ICzarVault.Frozen.selector);
        (sigs[27], topics[27]) = ("Unfrozen()", ICzarVault.Unfrozen.selector);
        (sigs[28], topics[28]) = ("SignersRotated(address,address,address)", ICzarVault.SignersRotated.selector);
        (sigs[29], topics[29]) = ("PasskeySet(bytes32)", ICzarVault.PasskeySet.selector);
        (sigs[30], topics[30]) = ("OwnerActionExecuted(uint8,uint256)", ICzarVault.OwnerActionExecuted.selector);
        (sigs[31], topics[31]) = ("Withdrawn(address,uint256)", ICzarVault.Withdrawn.selector);
        (sigs[32], topics[32]) = ("BalanceSynced(uint256,uint256)", ICzarVault.BalanceSynced.selector);
        (sigs[33], topics[33]) = ("NativeReceived(address,uint256)", ICzarVault.NativeReceived.selector);
    }

    function _errors() internal pure returns (string[] memory sigs, bytes4[] memory selectors) {
        sigs = new string[](55);
        selectors = new bytes4[](55);
        (sigs[0], selectors[0]) = ("NotOwner()", ICzarVault.NotOwner.selector);
        (sigs[1], selectors[1]) = ("NotAgent()", ICzarVault.NotAgent.selector);
        (sigs[2], selectors[2]) = ("NotAuthorized()", ICzarVault.NotAuthorized.selector);
        (sigs[3], selectors[3]) = ("Paused()", ICzarVault.Paused.selector);
        (sigs[4], selectors[4]) = ("FrozenVault()", ICzarVault.FrozenVault.selector);
        (sigs[5], selectors[5]) = ("ZeroAddress()", ICzarVault.ZeroAddress.selector);
        (sigs[6], selectors[6]) = ("BadParams()", ICzarVault.BadParams.selector);
        (sigs[7], selectors[7]) = ("InsufficientFree(uint256,uint256)", ICzarVault.InsufficientFree.selector);
        (sigs[8], selectors[8]) = ("AllowanceExceeded(bytes32,uint256,uint256)", ICzarVault.AllowanceExceeded.selector);
        (sigs[9], selectors[9]) = ("EnvelopeNotOpen()", ICzarVault.EnvelopeNotOpen.selector);
        (sigs[10], selectors[10]) = ("EnvelopeExpired()", ICzarVault.EnvelopeExpired.selector);
        (sigs[11], selectors[11]) = ("EnvelopeBusy(uint32,uint32,uint32)", ICzarVault.EnvelopeBusy.selector);
        (sigs[12], selectors[12]) = ("PayeeNotInPlan()", ICzarVault.PayeeNotInPlan.selector);
        (sigs[13], selectors[13]) =
        ("StepCapExceeded(uint32,uint256,uint256,uint256)", ICzarVault.StepCapExceeded.selector);
        (sigs[14], selectors[14]) = ("PocketNotInPlan()", ICzarVault.PocketNotInPlan.selector);
        (sigs[15], selectors[15]) = ("PocketCapZero()", ICzarVault.PocketCapZero.selector);
        (sigs[16], selectors[16]) = ("PocketWrongState()", ICzarVault.PocketWrongState.selector);
        (sigs[17], selectors[17]) = ("PullbackWrongState()", ICzarVault.PullbackWrongState.selector);
        (sigs[18], selectors[18]) = ("RaiseNotAbove()", ICzarVault.RaiseNotAbove.selector);
        (sigs[19], selectors[19]) = ("FeeCeilingExceeded(uint256,uint256)", ICzarVault.FeeCeilingExceeded.selector);
        (sigs[20], selectors[20]) = ("CapExceeded()", ICzarVault.CapExceeded.selector);
        (sigs[21], selectors[21]) = ("BadTtl()", ICzarVault.BadTtl.selector);
        (sigs[22], selectors[22]) = ("BadCount()", ICzarVault.BadCount.selector);
        (sigs[23], selectors[23]) = ("ReservationNotActive()", ICzarVault.ReservationNotActive.selector);
        (sigs[24], selectors[24]) = ("NotUsed(uint32)", ICzarVault.NotUsed.selector);
        (sigs[25], selectors[25]) = ("AlreadyDone(uint32)", ICzarVault.AlreadyDone.selector);
        (sigs[26], selectors[26]) = ("NotExpired()", ICzarVault.NotExpired.selector);
        (sigs[27], selectors[27]) = ("PocketExists()", ICzarVault.PocketExists.selector);
        (sigs[28], selectors[28]) = ("NotEoa()", ICzarVault.NotEoa.selector);
        (sigs[29], selectors[29]) = ("DelegateNotSet()", ICzarVault.DelegateNotSet.selector);
        (sigs[30], selectors[30]) =
        ("PocketCapExceeded(uint256,uint256,uint256)", ICzarVault.PocketCapExceeded.selector);
        (sigs[31], selectors[31]) = ("GasGrantExceeded()", ICzarVault.GasGrantExceeded.selector);
        (sigs[32], selectors[32]) = ("NativeSendFailed()", ICzarVault.NativeSendFailed.selector);
        (sigs[33], selectors[33]) = ("PullbackTooLarge()", ICzarVault.PullbackTooLarge.selector);
        (sigs[34], selectors[34]) = ("FeeTooHigh()", ICzarVault.FeeTooHigh.selector);
        (sigs[35], selectors[35]) = ("NotMinted()", ICzarVault.NotMinted.selector);
        (sigs[36], selectors[36]) = ("AlreadyMinted()", ICzarVault.AlreadyMinted.selector);
        (sigs[37], selectors[37]) = ("TooEarly()", ICzarVault.TooEarly.selector);
        (sigs[38], selectors[38]) = ("PullbackPending()", ICzarVault.PullbackPending.selector);
        (sigs[39], selectors[39]) = ("BudgetExceedsReserved()", ICzarVault.BudgetExceedsReserved.selector);
        (sigs[40], selectors[40]) = ("UnexpectedFees(uint256,uint256)", ICzarVault.UnexpectedFees.selector);
        (sigs[41], selectors[41]) = ("WrongToken()", ICzarVault.WrongToken.selector);
        (sigs[42], selectors[42]) = ("JobNotOpen()", ICzarVault.JobNotOpen.selector);
        (sigs[43], selectors[43]) = ("JobNotCancellable(uint8)", ICzarVault.JobNotCancellable.selector);
        (sigs[44], selectors[44]) = ("BudgetChanged(uint256,uint256)", ICzarVault.BudgetChanged.selector);
        (sigs[45], selectors[45]) = ("JobWrongState()", ICzarVault.JobWrongState.selector);
        (sigs[46], selectors[46]) = ("NoChange()", ICzarVault.NoChange.selector);
        (sigs[47], selectors[47]) = ("AutoLimitAboveUserMax()", ICzarVault.AutoLimitAboveUserMax.selector);
        (sigs[48], selectors[48]) = ("RaiseTooLarge()", ICzarVault.RaiseTooLarge.selector);
        (sigs[49], selectors[49]) = ("RaiseAlreadyThisPeriod()", ICzarVault.RaiseAlreadyThisPeriod.selector);
        (sigs[50], selectors[50]) = ("BadSigner()", ICzarVault.BadSigner.selector);
        (sigs[51], selectors[51]) = ("Expired()", ICzarVault.Expired.selector);
        (sigs[52], selectors[52]) = ("PasskeyNotSet()", ICzarVault.PasskeyNotSet.selector);
        (sigs[53], selectors[53]) = ("InvalidPasskeyAssertion()", ICzarVault.InvalidPasskeyAssertion.selector);
        (sigs[54], selectors[54]) = ("UnknownAction()", ICzarVault.UnknownAction.selector);
    }

    /// @dev RV-060 named test.
    function test_abi_matchesICzarVaultSol() public {
        (string[] memory eventSigs, bytes32[] memory topics) = _events();
        for (uint256 i = 0; i < eventSigs.length; i++) {
            assertEq(topics[i], keccak256(bytes(eventSigs[i])), eventSigs[i]);
        }
        (string[] memory errorSigs, bytes4[] memory selectors) = _errors();
        for (uint256 i = 0; i < errorSigs.length; i++) {
            assertEq(selectors[i], bytes4(keccak256(bytes(errorSigs[i]))), errorSigs[i]);
        }
        _assertVaultEmitsOnlyInterfaceEvents(topics);
    }

    /// @dev A short lifecycle through several libraries; every log the vault writes must be an interface event.
    function _assertVaultEmitsOnlyInterfaceEvents(bytes32[] memory topics) internal {
        vm.recordLogs();
        _fundVault(5 * ONE_USDC);
        ICzarVault.OpenEnvelopeParams memory p;
        p.cap = 2 * ONE_USDC;
        p.maxStepAmount = ONE_USDC;
        p.expiresAt = uint64(block.timestamp + 1 days);
        p.categoryId = keccak256("category");
        p.payeeRoot = PAYEE_ROOT;
        vm.prank(owner);
        uint64 env = vault.openEnvelope(p);
        bytes32[] memory proof = _proofBeef();
        uint64 vb = uint64(block.timestamp + 300);
        vm.prank(agent);
        uint64 rid = vault.reserve(env, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, proof, 100_000, 2, vb);
        vm.warp(vb + 1);
        vault.finalize(rid, 0, 2);
        vm.prank(owner);
        vault.setCategoryLimits(p.categoryId, ONE_USDC, 0);
        vm.prank(agent);
        vault.freeze();
        vm.prank(owner);
        vault.unfreeze();
        vm.prank(owner);
        vault.closeEnvelope(env);
        vm.prank(owner);
        vault.withdraw(owner, ONE_USDC);
        vault.sync();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(vault)) continue;
            seen++;
            bool known;
            for (uint256 j = 0; j < topics.length; j++) {
                if (logs[i].topics[0] == topics[j]) known = true;
            }
            assertTrue(known, "vault emitted an event that is not in ICzarVault.sol");
        }
        assertGt(seen, 10);
    }
}
