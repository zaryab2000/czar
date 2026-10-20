// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VaultStorage} from "./VaultStorage.sol";

/// @title VaultStubs
/// @notice TEMPORARY. One placeholder per ICzarVault function that is not built, so CzarVault compiles and can be
///         deployed from PRD 03 on. Stubs are `pure` (stricter than the interface allows) so the compiler raises no
///         warning for an unused body. Each later PRD deletes the stubs of the functions it builds; PRD 10 deletes this
///         file. `NotBuilt` exists only here and must not appear anywhere once M1 is done.
abstract contract VaultStubs is VaultStorage {
    /// @dev Placeholder error; removed with this file.
    error NotBuilt();

    function cancelJob(bytes32) external pure {
        revert NotBuilt();
    }

    function cancelPullback(uint64) external pure {
        revert NotBuilt();
    }

    function claimJobRefund(bytes32) external pure {
        revert NotBuilt();
    }

    function closeEnvelope(uint64) external pure {
        revert NotBuilt();
    }

    function confirmPullback(uint64) external pure {
        revert NotBuilt();
    }

    function derivedNonce(uint64, uint32) external pure returns (bytes32) {
        revert NotBuilt();
    }

    function envelopePocket(uint64) external pure returns (address) {
        revert NotBuilt();
    }

    function envelopeShortfall(uint64) external pure returns (uint256) {
        revert NotBuilt();
    }

    function executeOwnerAction(uint8, bytes calldata, uint256, WebAuthnAuth calldata) external pure {
        revert NotBuilt();
    }

    function finalize(uint64, uint32, uint32) external pure {
        revert NotBuilt();
    }

    function forceCloseEnvelope(uint64) external pure {
        revert NotBuilt();
    }

    function freeBalance() external pure returns (uint256) {
        revert NotBuilt();
    }

    function freeze() external pure {
        revert NotBuilt();
    }

    function fundJob(bytes32, uint256) external pure {
        revert NotBuilt();
    }

    function fundPocket(address, uint256) external pure {
        revert NotBuilt();
    }

    function getEnvelope(uint64) external pure returns (Envelope memory) {
        revert NotBuilt();
    }

    function getJob(bytes32) external pure returns (Job memory) {
        revert NotBuilt();
    }

    function getLimits(bytes32) external pure returns (CategoryLimits memory) {
        revert NotBuilt();
    }

    function getPasskey() external pure returns (Passkey memory) {
        revert NotBuilt();
    }

    function getPocket(address) external pure returns (Pocket memory) {
        revert NotBuilt();
    }

    function getPullback(uint64) external pure returns (Pullback memory) {
        revert NotBuilt();
    }

    function getReservation(uint64) external pure returns (Reservation memory) {
        revert NotBuilt();
    }

    function grantPocketGas(address, uint256) external pure {
        revert NotBuilt();
    }

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        revert NotBuilt();
    }

    function lowerAutoLimit(bytes32, uint256) external pure {
        revert NotBuilt();
    }

    function openEnvelope(OpenEnvelopeParams calldata) external pure returns (uint64) {
        revert NotBuilt();
    }

    function openJob(uint64, uint32, address, uint256, bytes32[] calldata, uint64, bytes32)
        external
        pure
        returns (bytes32)
    {
        revert NotBuilt();
    }

    function raiseAutoLimit(bytes32, uint256, uint64, uint256, bytes calldata) external pure {
        revert NotBuilt();
    }

    function recordManualReturn(address, uint256) external pure {
        revert NotBuilt();
    }

    function registerPocket(uint64, address, bytes32[] calldata) external pure {
        revert NotBuilt();
    }

    function requestPullback(address, uint256, uint256, uint256) external pure returns (uint64) {
        revert NotBuilt();
    }

    function reserve(uint64, uint32, address, uint256, bytes32[] calldata, uint256, uint32, uint64)
        external
        pure
        returns (uint64)
    {
        revert NotBuilt();
    }

    function reserveWithDigests(uint64, uint32, address, uint256, bytes32[] calldata, uint256, uint32, uint64)
        external
        pure
        returns (uint64)
    {
        revert NotBuilt();
    }

    function rotateSigners(address, address, address) external pure {
        revert NotBuilt();
    }

    function setCategoryLimits(bytes32, uint256, uint256) external pure {
        revert NotBuilt();
    }

    function setMaxPullbackFee(uint256) external pure {
        revert NotBuilt();
    }

    function setPasskey(bytes32, bytes32, bytes32) external pure {
        revert NotBuilt();
    }

    function settle(uint64, uint32[] calldata) external pure {
        revert NotBuilt();
    }

    function stepUsed(uint64, uint32) external pure returns (uint256) {
        revert NotBuilt();
    }

    function sync() external pure {
        revert NotBuilt();
    }

    function syncJob(bytes32) external pure {
        revert NotBuilt();
    }

    function unfreeze() external pure {
        revert NotBuilt();
    }

    function withdraw(address, uint256) external pure {
        revert NotBuilt();
    }

    function writeOffPocket(address) external pure {
        revert NotBuilt();
    }
}
