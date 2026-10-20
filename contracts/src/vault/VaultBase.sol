// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ICzarVault} from "../interfaces/ICzarVault.sol";
import {ICzarVaultFactory} from "../interfaces/ICzarVaultFactory.sol";
import {VaultState, VaultConfig} from "./VaultState.sol";
import {VaultGuards} from "./VaultGuards.sol";
import {CzarHashing} from "../libraries/CzarHashing.sol";
import {SatMath} from "../libraries/SatMath.sol";
import {
    MAX_PULLBACK_FEE_CEILING as MAX_PULLBACK_FEE_CEILING_VALUE,
    MAX_AGENT_POCKET_CAP_BPS as MAX_AGENT_POCKET_CAP_BPS_VALUE,
    POCKET_STEP_INDEX as POCKET_STEP_INDEX_VALUE,
    DEFAULT_MAX_PULLBACK_FEE,
    USDC_NAME_HASH,
    USDC_VERSION_HASH,
    VAULT_NAME_HASH,
    SL_NAME_HASH,
    VERSION_1_HASH
} from "../libraries/CzarConstants.sol";

/// @title VaultBase
/// @notice The vault's immutables, its one storage struct, the constructor, `_config()` and every read-only getter
///         (czar-vault.md §3, §4, §15.8; 07 PRD 03). The logic lives in linked libraries under src/vault/logic/.
abstract contract VaultBase is ICzarVault, ReentrancyGuardTransient {
    // ───────────── Constants exposed by ICzarVault (values in CzarConstants.sol) ─────────────

    /// @dev 500000 (0.50 USDC), D81.
    uint256 public constant MAX_PULLBACK_FEE_CEILING = MAX_PULLBACK_FEE_CEILING_VALUE;
    /// @dev 2500, D22 and D71.
    uint16 public constant MAX_AGENT_POCKET_CAP_BPS = MAX_AGENT_POCKET_CAP_BPS_VALUE;
    /// @dev type(uint32).max, D71.
    uint32 public constant POCKET_STEP_INDEX = POCKET_STEP_INDEX_VALUE;

    // ───────────── Immutables (czar-vault.md §3, §4; read from the factory, RV-015) ─────────────

    /// @dev The user's smart account.
    address public immutable owner;
    /// @dev The deploying factory; read for guardianPaused().
    address public immutable factory;
    /// @dev ERC-8183 instance.
    address public immutable jobEscrow;
    /// @dev 0 CircleTestnet, 1 CzarBase.
    uint8 public immutable jobEscrowKind;
    /// @dev Arc USDC, 0x3600…0000 on both networks (A1-01).
    address internal immutable USDC;
    /// @dev Circle GatewayWallet for this network.
    address internal immutable GATEWAY_WALLET;
    /// @dev Circle GatewayMinter for this network.
    address internal immutable GATEWAY_MINTER;
    /// @dev Gateway domain id (26 on Arc).
    uint32 internal immutable GATEWAY_DOMAIN;
    /// @dev EIP-712 domain of USDC ("USDC", "2", chainid, USDC).
    bytes32 internal immutable USDC_DOMAIN_SEPARATOR;
    /// @dev EIP-712 domain of the Selection Layer ("SelectionLayer", "1", chainid).
    bytes32 internal immutable SL_DOMAIN_SEPARATOR;
    /// @dev EIP-712 domain of this vault ("CzarVault", "1", chainid, this).
    bytes32 internal immutable VAULT_DOMAIN_SEPARATOR;

    // ───────────── Storage ─────────────

    /// @dev Every storage variable, in the czar-vault.md §4 order, at slot 0 (VaultState.sol).
    VaultState internal _s;

    /// @dev czar-vault.md §15.8. `msg.sender` is the factory.
    constructor(address ownerAccount) {
        ICzarVaultFactory.NetworkConfig memory cfg = ICzarVaultFactory(msg.sender).networkConfig();
        ICzarVaultFactory.Defaults memory d = ICzarVaultFactory(msg.sender).defaults();
        if (
            ownerAccount == address(0) || cfg.usdc == address(0) || cfg.gatewayWallet == address(0)
                || cfg.gatewayMinter == address(0) || cfg.jobEscrow == address(0) || d.agentSigner == address(0)
                || d.autonomySigner == address(0) || d.evaluator == address(0)
        ) revert ZeroAddress();
        if (cfg.jobEscrowKind > 1 || d.agentSigner == d.evaluator) revert BadParams();

        owner = ownerAccount;
        factory = msg.sender;
        jobEscrow = cfg.jobEscrow;
        jobEscrowKind = cfg.jobEscrowKind;
        USDC = cfg.usdc;
        GATEWAY_WALLET = cfg.gatewayWallet;
        GATEWAY_MINTER = cfg.gatewayMinter;
        GATEWAY_DOMAIN = cfg.gatewayDomain;
        USDC_DOMAIN_SEPARATOR =
            CzarHashing.domainSeparatorFull(USDC_NAME_HASH, USDC_VERSION_HASH, block.chainid, cfg.usdc);
        SL_DOMAIN_SEPARATOR = CzarHashing.domainSeparatorNoContract(SL_NAME_HASH, VERSION_1_HASH, block.chainid);
        VAULT_DOMAIN_SEPARATOR =
            CzarHashing.domainSeparatorFull(VAULT_NAME_HASH, VERSION_1_HASH, block.chainid, address(this));

        _s.agentSigner = d.agentSigner;
        _s.autonomySigner = d.autonomySigner;
        _s.evaluator = d.evaluator;
        _s.maxPullbackFee = DEFAULT_MAX_PULLBACK_FEE;
    }

    /// @dev The immutables as one memory struct, passed to every logic library call (a library cannot read them).
    function _config() internal view returns (VaultConfig memory) {
        return VaultConfig({
            owner: owner,
            factory: factory,
            usdc: USDC,
            gatewayWallet: GATEWAY_WALLET,
            gatewayMinter: GATEWAY_MINTER,
            jobEscrow: jobEscrow,
            jobEscrowKind: jobEscrowKind,
            gatewayDomain: GATEWAY_DOMAIN,
            usdcDomainSeparator: USDC_DOMAIN_SEPARATOR,
            slDomainSeparator: SL_DOMAIN_SEPARATOR,
            vaultDomainSeparator: VAULT_DOMAIN_SEPARATOR
        });
    }

    // ───────────── Getters (D88, G-07) ─────────────

    /// @inheritdoc ICzarVault
    function freeBalance() public view returns (uint256) {
        return SatMath.sat(IERC20(USDC).balanceOf(address(this)), _s.committedTotal);
    }

    /// @inheritdoc ICzarVault
    function agentSigner() external view returns (address) {
        return _s.agentSigner;
    }

    /// @inheritdoc ICzarVault
    function autonomySigner() external view returns (address) {
        return _s.autonomySigner;
    }

    /// @inheritdoc ICzarVault
    function evaluator() external view returns (address) {
        return _s.evaluator;
    }

    /// @inheritdoc ICzarVault
    function frozen() external view returns (bool) {
        return _s.frozen;
    }

    /// @inheritdoc ICzarVault
    function committedTotal() external view returns (uint256) {
        return _s.committedTotal;
    }

    /// @inheritdoc ICzarVault
    function envelopeCount() external view returns (uint64) {
        return _s.envelopeCount;
    }

    /// @inheritdoc ICzarVault
    function reservationCount() external view returns (uint64) {
        return _s.reservationCount;
    }

    /// @inheritdoc ICzarVault
    function pullbackCount() external view returns (uint64) {
        return _s.pullbackCount;
    }

    /// @inheritdoc ICzarVault
    function autonomyNonce() external view returns (uint256) {
        return _s.autonomyNonce;
    }

    /// @inheritdoc ICzarVault
    function ownerActionNonce() external view returns (uint256) {
        return _s.ownerActionNonce;
    }

    /// @inheritdoc ICzarVault
    function maxPullbackFee() external view returns (uint256) {
        return _s.maxPullbackFee;
    }

    /// @inheritdoc ICzarVault
    function stepUsed(uint64 envelopeId, uint32 stepIndex) external view returns (uint256) {
        return _s.stepUsed[envelopeId][stepIndex];
    }

    /// @inheritdoc ICzarVault
    function envelopePocket(uint64 envelopeId) external view returns (address) {
        return _s.envelopes[envelopeId].pocket;
    }

    /// @inheritdoc ICzarVault
    function envelopeShortfall(uint64 envelopeId) external view returns (uint256) {
        return _s.envelopes[envelopeId].shortfall;
    }

    /// @inheritdoc ICzarVault
    function getEnvelope(uint64 envelopeId) external view returns (Envelope memory) {
        return _s.envelopes[envelopeId];
    }

    /// @inheritdoc ICzarVault
    function getReservation(uint64 reservationId) external view returns (Reservation memory) {
        return _s.reservations[reservationId];
    }

    /// @inheritdoc ICzarVault
    function getPocket(address pocket) external view returns (Pocket memory) {
        return _s.pockets[pocket];
    }

    /// @inheritdoc ICzarVault
    function getPullback(uint64 pullbackId) external view returns (Pullback memory) {
        return _s.pullbacks[pullbackId];
    }

    /// @inheritdoc ICzarVault
    function getJob(bytes32 jobKey) external view returns (Job memory) {
        return _s.jobs[jobKey];
    }

    /// @inheritdoc ICzarVault
    function getLimits(bytes32 categoryId) external view returns (CategoryLimits memory) {
        return _s.limits[categoryId];
    }

    /// @inheritdoc ICzarVault
    function getPasskey() external view returns (Passkey memory) {
        return _s.passkey;
    }

    /// @inheritdoc ICzarVault
    function derivedNonce(uint64 reservationId, uint32 index) external view returns (bytes32) {
        return VaultGuards.derivedNonce(reservationId, index);
    }
}
