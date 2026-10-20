// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CzarVault} from "../src/CzarVault.sol";
import {CzarVaultFactory} from "../src/CzarVaultFactory.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";

/// @dev 07 PRD 11 (T-020). The EIP-170 and EIP-3860 limits as a test, so CI fails the moment a change pushes the
///      vault or the factory over (czar-vault.md §15.12, czar-vault-factory.md §11, D89). The logic libraries are
///      checked by `arc-forge build --sizes`.
contract SizeTest is VaultTestBase {
    uint256 internal constant MAX_RUNTIME_SIZE = 24_576; // EIP-170
    uint256 internal constant MAX_INITCODE_SIZE = 49_152; // EIP-3860

    function test_vault_runtimeAndInitcodeUnderLimits() public view {
        assertLe(address(vault).code.length, MAX_RUNTIME_SIZE);
        assertLe(type(CzarVault).creationCode.length, MAX_INITCODE_SIZE);
    }

    function test_factory_runtimeAndInitcodeUnderLimits() public {
        CzarVaultFactory f =
            new CzarVaultFactory(_networkConfig(), _defaults(), makeAddr("guardian"), makeAddr("admin"));
        assertLe(address(f).code.length, MAX_RUNTIME_SIZE);
        assertLe(type(CzarVaultFactory).creationCode.length, MAX_INITCODE_SIZE);
    }
}
