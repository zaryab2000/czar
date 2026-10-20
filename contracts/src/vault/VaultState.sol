// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICzarVault} from "../interfaces/ICzarVault.sol";

/// @dev Fallback-mode digest lookup (czar-vault.md §4, 02 §6.3.4). Internal only; not in the ABI.
struct DigestSlot {
    uint64 reservationId;
    uint32 index;
    bool set;
}

/// @dev Every storage variable of CzarVault (czar-vault.md §4), grouped so small fields share a slot; this field
///      order is binding (07 PRD 03). The vault holds exactly one `VaultState`, at slot 0.
///      The vault's logic libraries receive it as `VaultState storage s` (they run by DELEGATECALL in the vault).
struct VaultState {
    address agentSigner; // K3
    address autonomySigner; // K5
    address evaluator; // K7
    bool frozen;
    uint64 envelopeCount; // ids start at 1
    uint64 reservationCount; // ids start at 1
    uint64 pullbackCount; // ids start at 1
    uint256 maxPullbackFee; // D81
    uint256 autonomyNonce; // RV-030, D88
    uint256 ownerActionNonce;
    uint256 committedTotal; // INV-2
    ICzarVault.Passkey passkey; // D30
    mapping(bytes32 categoryId => ICzarVault.CategoryLimits) limits;
    mapping(uint64 envelopeId => ICzarVault.Envelope) envelopes;
    mapping(uint64 envelopeId => mapping(uint32 stepIndex => uint256)) stepUsed; // RV-002
    mapping(uint64 reservationId => ICzarVault.Reservation) reservations;
    mapping(bytes32 digest => DigestSlot) digestSlot;
    mapping(address pocket => ICzarVault.Pocket) pockets;
    mapping(uint64 pullbackId => ICzarVault.Pullback) pullbacks;
    mapping(bytes32 jobKey => ICzarVault.Job) jobs;
}

/// @dev The vault's immutables, copied into memory by CzarVault._config() and passed to every logic library call:
///      a library cannot read the calling contract's immutables (07 PRD 03).
struct VaultConfig {
    address owner;
    address factory;
    address usdc;
    address gatewayWallet;
    address gatewayMinter;
    address jobEscrow;
    uint8 jobEscrowKind;
    uint32 gatewayDomain;
    bytes32 usdcDomainSeparator;
    bytes32 slDomainSeparator;
    bytes32 vaultDomainSeparator;
}
