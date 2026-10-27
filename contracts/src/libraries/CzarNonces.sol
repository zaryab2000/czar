// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {NONCE_TAG} from "./CzarConstants.sol";

library CzarNonces {
    /// @dev EIP-3009 nonce for index `index` of reservation `reservationId` (02 §7.2).
    function derivedNonce(address vault, uint64 reservationId, uint32 index) internal pure returns (bytes32) {
        return keccak256(abi.encode(NONCE_TAG, vault, reservationId, index));
    }

    /// @dev Burn-intent salt for pullback `pullbackId` (02 §7.3; czar-vault.md §5.4 requestPullback).
    function pullbackSalt(address vault, uint64 pullbackId) internal pure returns (bytes32) {
        return keccak256(abi.encode(NONCE_TAG, vault, pullbackId));
    }
}
