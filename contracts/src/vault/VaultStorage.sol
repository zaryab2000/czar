// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ICzarVault} from "../interfaces/ICzarVault.sol";
import {ICzarVaultFactory} from "../interfaces/ICzarVaultFactory.sol";
import {CzarHashing} from "../libraries/CzarHashing.sol";
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

/// @title VaultStorage
/// @notice Every immutable and storage variable of CzarVault, the constructor, and the shared caller and gate checks.
/// @dev czar-vault.md §3, §4, §15.1, §15.8. The only vault module with a constructor: Solidity lets only the
///      declaring contract's constructor assign an immutable. Storage order below is fixed (00-conventions §4.9).
abstract contract VaultStorage is ICzarVault, ReentrancyGuardTransient {
    /// @dev Fallback-mode digest lookup (czar-vault.md §4, 02 §6.3.4). Internal only; not in the ABI.
    struct DigestSlot {
        uint64 reservationId;
        uint32 index;
        bool set;
    }

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

    // ───────────── Storage (order fixed) ─────────────

    /// @dev K3 agent key.
    address public agentSigner;
    /// @dev K5 autonomy key.
    address public autonomySigner;
    /// @dev K7 evaluator key.
    address public evaluator;
    /// @dev User freeze flag.
    bool public frozen;
    /// @dev Number of envelopes ever opened; ids start at 1.
    uint64 public envelopeCount;
    /// @dev Number of reservations ever made; ids start at 1.
    uint64 public reservationCount;
    /// @dev Number of pullbacks ever requested; ids start at 1.
    uint64 public pullbackCount;
    /// @dev Current bound on requestPullback.maxFee (D81).
    uint256 public maxPullbackFee;
    /// @dev Replay protection for AutonomyRaise; also bumped by freeze and every lowering (RV-030, D88).
    uint256 public autonomyNonce;
    /// @dev Replay protection for OwnerAction.
    uint256 public ownerActionNonce;
    /// @dev Σ over open envelopes of cap − spent − pocketOutstanding − jobEscrowed − shortfall (INV-2).
    uint256 public committedTotal;
    /// @dev D30 passkey.
    Passkey internal passkey;
    /// @dev Earned-autonomy limits per category.
    mapping(bytes32 categoryId => CategoryLimits) internal limits;
    /// @dev Envelope records.
    mapping(uint64 envelopeId => Envelope) internal envelopes;
    /// @dev Amount reserved or spent per plan step (RV-002). Named with "_" because stepUsed() is the getter.
    mapping(uint64 envelopeId => mapping(uint32 stepIndex => uint256)) internal _stepUsed;
    /// @dev Reservation records.
    mapping(uint64 reservationId => Reservation) internal reservations;
    /// @dev Fallback-mode digest lookup.
    mapping(bytes32 digest => DigestSlot) internal digestSlot;
    /// @dev Pocket records.
    mapping(address pocket => Pocket) internal pockets;
    /// @dev Pullback records.
    mapping(uint64 pullbackId => Pullback) internal pullbacks;
    /// @dev Job records.
    mapping(bytes32 jobKey => Job) internal jobs;

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

        agentSigner = d.agentSigner;
        autonomySigner = d.autonomySigner;
        evaluator = d.evaluator;
        maxPullbackFee = DEFAULT_MAX_PULLBACK_FEE;
    }

    // ───────────── Shared checks (czar-vault.md §15.1, §15.2) ─────────────

    /// @dev Owner-only rule. `caller` is msg.sender, or the owner when dispatched by executeOwnerAction.
    function _requireOwner(address caller) internal view {
        if (caller != owner) revert NotOwner();
    }

    /// @dev Agent-only rule.
    function _requireAgent(address caller) internal view {
        if (caller != agentSigner) revert NotAgent();
    }

    /// @dev Owner-or-agent rule.
    function _requireOwnerOrAgent(address caller) internal view {
        if (caller != owner && caller != agentSigner) revert NotAuthorized();
    }

    /// @dev notPausedOrFrozen: freeze is checked before pause (§15.2).
    function _requireNotPausedOrFrozen() internal view {
        if (frozen) revert FrozenVault();
        if (ICzarVaultFactory(factory).guardianPaused()) revert Paused();
    }
}
