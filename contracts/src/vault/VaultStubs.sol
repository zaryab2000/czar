// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VaultBase} from "./VaultBase.sol";

/// @title VaultStubs
/// @notice TEMPORARY. One placeholder per ICzarVault function that is not built, so CzarVault compiles and can be
///         deployed from PRD 03 on. Stubs are `pure` (stricter than the interface allows) so the compiler raises no
///         warning for an unused body. Each later PRD deletes the stubs of the functions it builds; PRD 10 deletes this
///         file. `NotBuilt` exists only here and must not appear anywhere once M1 is done.
abstract contract VaultStubs is VaultBase {
    /// @dev Placeholder error; removed with this file.
    error NotBuilt();

    function executeOwnerAction(uint8, bytes calldata, uint256, WebAuthnAuth calldata) external pure {
        revert NotBuilt();
    }

    function lowerAutoLimit(bytes32, uint256) external pure {
        revert NotBuilt();
    }

    function raiseAutoLimit(bytes32, uint256, uint64, uint256, bytes calldata) external pure {
        revert NotBuilt();
    }
}
