// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VaultStorage} from "./vault/VaultStorage.sol";
import {VaultStubs} from "./vault/VaultStubs.sol";

/// @title CzarVault
/// @notice The per-user vault (czar-vault.md). Immutable; no proxy (D33). The only concrete vault contract: it
///         inherits every vault module. Each later PRD adds its module to this list and removes its stubs.
contract CzarVault is VaultStubs {
    /// @dev czar-vault.md §15.8. Called by CzarVaultFactory.createVault through CREATE2.
    constructor(address ownerAccount) VaultStorage(ownerAccount) {}
}
