// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {ICzarVaultFactory} from "../../src/interfaces/ICzarVaultFactory.sol";
import {CzarVault} from "../../src/CzarVault.sol";

/// @title MockVaultFactory
/// @notice Test-only stand-in for CzarVaultFactory as the vault sees it: the three views the vault constructor and
///         spending paths call (networkConfig, defaults, guardianPaused), settable, plus helpers that deploy a vault
///         with this contract as msg.sender (security-and-testing.md §3.3, D88 G-66).
contract MockVaultFactory {
    /// @dev Foundry cheatcode address; this mock is test-only.
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    ICzarVaultFactory.NetworkConfig internal _cfg;
    ICzarVaultFactory.Defaults internal _defaults;
    bool public guardianPaused;

    constructor(ICzarVaultFactory.NetworkConfig memory cfg, ICzarVaultFactory.Defaults memory d) {
        _cfg = cfg;
        _defaults = d;
    }

    function networkConfig() external view returns (ICzarVaultFactory.NetworkConfig memory) {
        return _cfg;
    }

    function defaults() external view returns (ICzarVaultFactory.Defaults memory) {
        return _defaults;
    }

    function setGuardianPaused(bool paused) external {
        guardianPaused = paused;
    }

    function setNetworkConfig(ICzarVaultFactory.NetworkConfig memory cfg) external {
        _cfg = cfg;
    }

    function setDefaults(ICzarVaultFactory.Defaults memory d) external {
        _defaults = d;
    }

    /// @notice Deploys a CzarVault for `ownerAccount` with CREATE; constructor reverts bubble up unchanged.
    function deploy(address ownerAccount) external returns (CzarVault) {
        return CzarVault(payable(deployCode(abi.encodePacked(type(CzarVault).creationCode, abi.encode(ownerAccount)))));
    }

    /// @notice Deploys any creation code (with its constructor arguments appended) with CREATE, so the new contract
    ///         sees this mock as msg.sender. Used for CzarVaultHarness. Constructor reverts bubble up unchanged.
    function deployCode(bytes memory initcode) public returns (address deployed) {
        assembly ("memory-safe") {
            deployed := create(0, add(initcode, 0x20), mload(initcode))
            if iszero(deployed) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }
    }

    /// @notice Deploys creation code at a fixed address (vector tests), the way forge-std deployCodeTo does: run it
    ///         at `where` with this mock as msg.sender, then store the returned runtime code there.
    function deployCodeAt(address where, bytes memory initcode) external returns (address) {
        VM.etch(where, initcode);
        (bool ok, bytes memory runtime) = where.call("");
        require(ok, "MockVaultFactory: constructor reverted");
        VM.etch(where, runtime);
        return where;
    }
}
