// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title ICzarVaultFactory
/// @notice Deploys immutable CzarVaults at CREATE2 addresses and holds the guardian pause flag.
/// @dev Specification: specs/03-smart-contracts/czar-vault-factory.md.
interface ICzarVaultFactory {
    struct Defaults {
        address agentSigner;
        address autonomySigner;
        address evaluator;
    }

    event VaultCreated(
        address indexed ownerAccount,
        address indexed vault,
        uint32 indexed version,
        address agentSigner,
        address autonomySigner,
        address evaluator
    );
    event GuardianPaused(address indexed by);
    event GuardianUnpaused(address indexed by);
    event VersionQueued(bytes32 indexed changeId, bytes32 creationCodeHash, uint64 eta);
    event VersionApplied(uint32 indexed version, bytes32 creationCodeHash);
    event GuardianQueued(bytes32 indexed changeId, address guardian, uint64 eta);
    event GuardianChanged(address indexed oldGuardian, address indexed newGuardian);
    event DefaultsSet(address agentSigner, address autonomySigner, address evaluator);

    error VaultExists();
    error ZeroAddress();
    error NotGuardian();
    error TooEarly();
    error UnknownChange();
    error VersionRetired();

    /// @notice Deploys the vault for `ownerAccount`. Callable by the owner account or an onboarding relayer;
    ///         the vault's owner is always `ownerAccount`.
    function createVault(address ownerAccount, bytes32 salt) external returns (address vault);
    /// @notice CREATE2 address the vault for `ownerAccount` would get with `salt`.
    function predictVault(address ownerAccount, bytes32 salt) external view returns (address);
    /// @notice Guardian stops spending in every vault (read by vaults on each spending path).
    function pause() external;
    /// @notice Guardian resumes.
    function unpause() external;
    /// @notice True while the guardian pause is active.
    function guardianPaused() external view returns (bool);
    /// @notice Vault of an owner account, or zero.
    function vaultOf(address ownerAccount) external view returns (address);
    /// @notice Code version a vault was deployed from.
    function versionOf(address vault) external view returns (uint32);
    /// @notice Admin queues a new vault creation-code hash (48 h timelock).
    function queueVersion(bytes32 creationCodeHash) external returns (bytes32 changeId);
    /// @notice Anyone applies a queued version after its eta.
    function applyVersion(bytes32 changeId) external;
    /// @notice Admin queues a guardian change (48 h timelock).
    function queueGuardian(address newGuardian) external returns (bytes32 changeId);
    /// @notice Anyone applies a queued guardian change after its eta.
    function applyGuardian(bytes32 changeId) external;
    /// @notice Admin sets the signer defaults injected into new vaults.
    function setDefaults(address agentSigner, address autonomySigner, address evaluator) external;
    /// @notice Current defaults.
    function defaults() external view returns (Defaults memory);
}
