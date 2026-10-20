// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ICzarVaultFactory} from "./interfaces/ICzarVaultFactory.sol";
import {CzarVault} from "./CzarVault.sol";

/// @title CzarVaultFactory
/// @notice Deploys one immutable CzarVault per owner and manages the guardian pause and timelocked defaults.
/// @dev czar-vault-factory.md §§1–9; 07 PRD 03 §10.
contract CzarVaultFactory is ICzarVaultFactory, Ownable2Step {
    /// @dev Queued guardian or defaults change (czar-vault-factory.md §4).
    struct PendingChange {
        uint8 kind;
        uint64 eta;
        bytes32 payloadHash;
    }

    /// @dev Delay for guardian and defaults changes (czar-vault-factory.md §3).
    uint256 internal constant ADMIN_TIMELOCK = 48 hours;
    /// @dev Guardian change type (czar-vault-factory.md §4).
    uint8 internal constant KIND_GUARDIAN = 1;
    /// @dev Defaults change type (czar-vault-factory.md §4).
    uint8 internal constant KIND_DEFAULTS = 2;

    /// @inheritdoc ICzarVaultFactory
    uint32 public constant VAULT_VERSION = 1;
    /// @inheritdoc ICzarVaultFactory
    bytes32 public immutable VAULT_CREATION_CODE_HASH;

    /// @dev Network USDC address (czar-vault-factory.md §3).
    address internal immutable USDC;
    /// @dev Network Gateway Wallet address (czar-vault-factory.md §3).
    address internal immutable GATEWAY_WALLET;
    /// @dev Network Gateway Minter address (czar-vault-factory.md §3).
    address internal immutable GATEWAY_MINTER;
    /// @dev Network Gateway domain id (czar-vault-factory.md §3).
    uint32 internal immutable GATEWAY_DOMAIN;
    /// @dev Network job escrow address (czar-vault-factory.md §3).
    address internal immutable JOB_ESCROW;
    /// @dev Network job escrow ABI kind (czar-vault-factory.md §3).
    uint8 internal immutable JOB_ESCROW_KIND;

    /// @inheritdoc ICzarVaultFactory
    address public guardian;
    /// @inheritdoc ICzarVaultFactory
    bool public guardianPaused;
    /// @dev Defaults applied to newly created vaults (czar-vault-factory.md §4).
    Defaults internal _defaults;
    /// @inheritdoc ICzarVaultFactory
    mapping(address ownerAccount => address vault) public vaultOf;
    /// @inheritdoc ICzarVaultFactory
    mapping(address vault => bool) public isVault;
    /// @dev Pending timelocked changes (czar-vault-factory.md §4).
    mapping(bytes32 changeId => PendingChange) internal _pendingChanges;
    /// @dev Change id nonce (czar-vault-factory.md §4, D88).
    uint256 internal _changeNonce;

    /// @notice Deploys the factory with its network configuration, initial defaults, guardian and admin.
    /// @dev czar-vault-factory.md §3; 07 PRD 03 §10.3.
    constructor(NetworkConfig memory cfg, Defaults memory initialDefaults, address guardian_, address admin_)
        Ownable(_nonZero(admin_))
    {
        if (
            cfg.usdc == address(0) || cfg.gatewayWallet == address(0) || cfg.gatewayMinter == address(0)
                || cfg.jobEscrow == address(0) || initialDefaults.agentSigner == address(0)
                || initialDefaults.autonomySigner == address(0) || initialDefaults.evaluator == address(0)
                || guardian_ == address(0)
        ) revert ZeroAddress();
        if (cfg.jobEscrowKind > 1 || initialDefaults.agentSigner == initialDefaults.evaluator) revert BadParams();

        USDC = cfg.usdc;
        GATEWAY_WALLET = cfg.gatewayWallet;
        GATEWAY_MINTER = cfg.gatewayMinter;
        GATEWAY_DOMAIN = cfg.gatewayDomain;
        JOB_ESCROW = cfg.jobEscrow;
        JOB_ESCROW_KIND = cfg.jobEscrowKind;
        _defaults = initialDefaults;
        guardian = guardian_;
        VAULT_CREATION_CODE_HASH = keccak256(type(CzarVault).creationCode);
    }

    /// @inheritdoc ICzarVaultFactory
    function createVault(address ownerAccount) external returns (address vault) {
        if (ownerAccount == address(0)) revert ZeroAddress();
        if (vaultOf[ownerAccount] != address(0)) revert VaultExists();

        vault = address(new CzarVault{salt: keccak256(abi.encode(ownerAccount))}(ownerAccount));
        vaultOf[ownerAccount] = vault;
        isVault[vault] = true;
        emit VaultCreated(
            ownerAccount, vault, VAULT_VERSION, _defaults.agentSigner, _defaults.autonomySigner, _defaults.evaluator
        );
    }

    /// @inheritdoc ICzarVaultFactory
    function predictVault(address ownerAccount) external view returns (address) {
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(CzarVault).creationCode, abi.encode(ownerAccount)));
        bytes32 h =
            keccak256(abi.encodePacked(bytes1(0xff), address(this), keccak256(abi.encode(ownerAccount)), initCodeHash));
        return address(uint160(uint256(h)));
    }

    /// @inheritdoc ICzarVaultFactory
    function pause() external {
        if (msg.sender != guardian) revert NotGuardian();
        guardianPaused = true;
        emit GuardianPaused(msg.sender);
    }

    /// @inheritdoc ICzarVaultFactory
    function unpause() external {
        if (msg.sender != guardian) revert NotGuardian();
        guardianPaused = false;
        emit GuardianUnpaused(msg.sender);
    }

    /// @inheritdoc ICzarVaultFactory
    function networkConfig() external view returns (NetworkConfig memory) {
        return NetworkConfig({
            usdc: USDC,
            gatewayWallet: GATEWAY_WALLET,
            gatewayMinter: GATEWAY_MINTER,
            gatewayDomain: GATEWAY_DOMAIN,
            jobEscrow: JOB_ESCROW,
            jobEscrowKind: JOB_ESCROW_KIND
        });
    }

    /// @inheritdoc ICzarVaultFactory
    function defaults() external view returns (Defaults memory) {
        return _defaults;
    }

    /// @inheritdoc ICzarVaultFactory
    function queueGuardian(address newGuardian) external onlyOwner returns (bytes32 changeId) {
        if (newGuardian == address(0)) revert ZeroAddress();
        uint64 eta;
        (changeId, eta) = _queue(KIND_GUARDIAN, keccak256(abi.encode(newGuardian)));
        emit GuardianQueued(changeId, newGuardian, eta);
    }

    /// @inheritdoc ICzarVaultFactory
    function applyGuardian(bytes32 changeId, address newGuardian) external {
        if (newGuardian == address(0)) revert ZeroAddress();
        _consume(changeId, KIND_GUARDIAN, keccak256(abi.encode(newGuardian)));
        address oldGuardian = guardian;
        guardian = newGuardian;
        emit GuardianChanged(oldGuardian, newGuardian);
    }

    /// @inheritdoc ICzarVaultFactory
    function queueDefaults(address agentSigner, address autonomySigner, address evaluator)
        external
        onlyOwner
        returns (bytes32 changeId)
    {
        if (agentSigner == address(0) || autonomySigner == address(0) || evaluator == address(0)) {
            revert ZeroAddress();
        }
        if (agentSigner == evaluator) revert BadParams();
        uint64 eta;
        (changeId, eta) = _queue(KIND_DEFAULTS, keccak256(abi.encode(agentSigner, autonomySigner, evaluator)));
        emit DefaultsQueued(changeId, agentSigner, autonomySigner, evaluator, eta);
    }

    /// @inheritdoc ICzarVaultFactory
    function applyDefaults(bytes32 changeId, address agentSigner, address autonomySigner, address evaluator) external {
        if (agentSigner == address(0) || autonomySigner == address(0) || evaluator == address(0)) {
            revert ZeroAddress();
        }
        _consume(changeId, KIND_DEFAULTS, keccak256(abi.encode(agentSigner, autonomySigner, evaluator)));
        _defaults = Defaults({agentSigner: agentSigner, autonomySigner: autonomySigner, evaluator: evaluator});
        emit DefaultsSet(agentSigner, autonomySigner, evaluator);
    }

    /// @inheritdoc ICzarVaultFactory
    function cancelChange(bytes32 changeId) external onlyOwner {
        if (_pendingChanges[changeId].kind == 0) revert UnknownChange();
        delete _pendingChanges[changeId];
        emit ChangeCancelled(changeId);
    }

    /// @dev Queues a payload under a unique id and its 48-hour eta (czar-vault-factory.md §5).
    function _queue(uint8 kind, bytes32 payloadHash) internal returns (bytes32 changeId, uint64 eta) {
        eta = SafeCast.toUint64(block.timestamp + ADMIN_TIMELOCK);
        changeId = keccak256(abi.encode(kind, payloadHash, eta, ++_changeNonce));
        _pendingChanges[changeId] = PendingChange({kind: kind, eta: eta, payloadHash: payloadHash});
    }

    /// @dev Validates and consumes a queued payload (czar-vault-factory.md §5).
    function _consume(bytes32 changeId, uint8 kind, bytes32 payloadHash) internal {
        PendingChange memory c = _pendingChanges[changeId];
        if (c.kind != kind) revert UnknownChange();
        if (block.timestamp < c.eta) revert TooEarly();
        if (c.payloadHash != payloadHash) revert UnknownChange();
        delete _pendingChanges[changeId];
    }

    /// @dev Rejects zero before the Ownable base constructor runs (czar-vault-factory.md §3).
    function _nonZero(address a) private pure returns (address) {
        if (a == address(0)) revert ZeroAddress();
        return a;
    }
}
