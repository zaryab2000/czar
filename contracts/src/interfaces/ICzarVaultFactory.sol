// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title ICzarVaultFactory
/// @notice Deploys immutable CzarVaults at CREATE2 addresses and holds the guardian pause flag.
/// @dev Specification: specs/03-smart-contracts/czar-vault-factory.md. Amended 2026-10-19 (RV-015, D73):
///      no version register (a new vault version is a new factory); the vault address depends only on the
///      factory and the owner; default signers change only through a 48 h timelock.
interface ICzarVaultFactory {
    struct Defaults {
        address agentSigner;
        address autonomySigner;
        address evaluator;
    }

    /// @notice Per-network immutables each vault's constructor reads from the factory (not in init code).
    struct NetworkConfig {
        address usdc;
        address gatewayWallet;
        address gatewayMinter;
        uint32 gatewayDomain;
        address jobEscrow;
        uint8 jobEscrowKind;
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
    event GuardianQueued(bytes32 indexed changeId, address guardian, uint64 eta);
    event GuardianChanged(address indexed oldGuardian, address indexed newGuardian);
    event DefaultsQueued(
        bytes32 indexed changeId, address agentSigner, address autonomySigner, address evaluator, uint64 eta
    );
    event DefaultsSet(address agentSigner, address autonomySigner, address evaluator);

    error VaultExists();
    error ZeroAddress();
    error NotGuardian();
    error TooEarly();
    error UnknownChange();

    /// @notice Deploys the vault for `ownerAccount` at keccak256(abi.encode(ownerAccount)) as CREATE2 salt.
    ///         Anyone may call; the vault's owner is always `ownerAccount` and its signers are the current defaults.
    function createVault(address ownerAccount) external returns (address vault);
    /// @notice CREATE2 address of the vault for `ownerAccount`; independent of defaults and of the caller.
    function predictVault(address ownerAccount) external view returns (address);
    /// @notice Guardian stops spending in every vault (read by vaults on each spending path).
    function pause() external;
    /// @notice Guardian resumes.
    function unpause() external;
    /// @notice True while the guardian pause is active.
    function guardianPaused() external view returns (bool);
    /// @notice Vault of an owner account, or zero.
    function vaultOf(address ownerAccount) external view returns (address);
    /// @notice True for vaults deployed by this factory.
    function isVault(address vault) external view returns (bool);
    /// @notice The one vault version this factory deploys (D73).
    function VAULT_VERSION() external view returns (uint32);
    /// @notice keccak256 of the vault creation code compiled into this factory.
    function VAULT_CREATION_CODE_HASH() external view returns (bytes32);
    /// @notice Per-network immutables passed to vaults through their constructor's read of msg.sender.
    function networkConfig() external view returns (NetworkConfig memory);
    /// @notice Admin queues a guardian change (48 h timelock).
    function queueGuardian(address newGuardian) external returns (bytes32 changeId);
    /// @notice Anyone applies a queued guardian change after its eta.
    function applyGuardian(bytes32 changeId) external;
    /// @notice Admin queues new signer defaults for future vaults (48 h timelock, RV-015).
    function queueDefaults(address agentSigner, address autonomySigner, address evaluator)
        external
        returns (bytes32 changeId);
    /// @notice Anyone applies queued defaults after their eta; arguments must match the queued payload hash.
    function applyDefaults(bytes32 changeId, address agentSigner, address autonomySigner, address evaluator) external;
    /// @notice Current defaults.
    function defaults() external view returns (Defaults memory);
}
