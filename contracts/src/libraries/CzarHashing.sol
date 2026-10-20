// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ICzarVault} from "../interfaces/ICzarVault.sol";
import {
    EIP712_DOMAIN_FULL_TYPEHASH,
    EIP712_DOMAIN_NO_CONTRACT_TYPEHASH,
    TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
    TRANSFER_SPEC_TYPEHASH,
    BURN_INTENT_TYPEHASH,
    RECEIPT_TYPEHASH,
    RECEIPT_ATTESTATION_TYPEHASH,
    AUTONOMY_RAISE_TYPEHASH,
    OWNER_ACTION_TYPEHASH,
    TRANSFER_SPEC_MAGIC
} from "./CzarConstants.sol";

library CzarHashing {
    /// @dev EIP-712 domain with chainId and verifyingContract (02 §6.1: USDC, CzarVault).
    function domainSeparatorFull(bytes32 nameHash, bytes32 versionHash, uint256 chainId, address verifyingContract)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(EIP712_DOMAIN_FULL_TYPEHASH, nameHash, versionHash, chainId, verifyingContract));
    }

    /// @dev EIP-712 domain with chainId and no contract (02 §6.1: SelectionLayer).
    function domainSeparatorNoContract(bytes32 nameHash, bytes32 versionHash, uint256 chainId)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(EIP712_DOMAIN_NO_CONTRACT_TYPEHASH, nameHash, versionHash, chainId));
    }

    /// @dev "\x19\x01" ‖ domain ‖ structHash, via OpenZeppelin (02 §6.1 last line).
    function typedDataHash(bytes32 domainSeparator, bytes32 structHash) internal pure returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
    }

    /// @dev USDC TransferWithAuthorization struct hash (02 §6.3.1).
    function transferWithAuthorizationHash(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
    }

    /// @dev Gateway TransferSpec struct hash (czar-vault.md §6.2 table; hookData is empty, so its hash is keccak256("")).
    /// Field order is binding: version, sourceDomain, destinationDomain, sourceContract, destinationContract,
    /// sourceToken, destinationToken, sourceDepositor, destinationRecipient, sourceSigner, destinationCaller, value, salt, hookData.
    function transferSpecStructHash(TransferSpecFields memory f) internal pure returns (bytes32) {
        // Split in two abi.encode calls to stay under the 16-slot stack limit without via-IR.
        // All fields are static 32-byte words, so the concatenation equals one abi.encode of all 15 values.
        return keccak256(
            bytes.concat(
                abi.encode(
                    TRANSFER_SPEC_TYPEHASH,
                    f.version,
                    f.sourceDomain,
                    f.destinationDomain,
                    f.sourceContract,
                    f.destinationContract,
                    f.sourceToken
                ),
                abi.encode(
                    f.destinationToken,
                    f.sourceDepositor,
                    f.destinationRecipient,
                    f.sourceSigner,
                    f.destinationCaller,
                    f.value,
                    f.salt,
                    keccak256("")
                )
            )
        );
    }

    /// @dev Gateway BurnIntent struct hash (czar-vault.md §6.2 step 3).
    function burnIntentStructHash(uint256 maxBlockHeight, uint256 maxFee, bytes32 specStructHash)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(BURN_INTENT_TYPEHASH, maxBlockHeight, maxFee, specStructHash));
    }

    /// @dev Gateway replay id: keccak256 of the 340-byte TransferSpec encoding (czar-vault.md §5.4 requestPullback;
    /// TransferSpec.sol lines 50–67). The last field is the hookData length (uint32 0); hookData itself is empty.
    function transferSpecReplayHash(TransferSpecFields memory f) internal pure returns (bytes32) {
        // Two nested concats (stack limit without via-IR). Byte layout: 4 + 3×4 + 8×32 + 32 + 32 + 4 = 340.
        bytes memory head = bytes.concat(
            TRANSFER_SPEC_MAGIC,
            bytes4(f.version),
            bytes4(f.sourceDomain),
            bytes4(f.destinationDomain),
            f.sourceContract,
            f.destinationContract,
            f.sourceToken,
            f.destinationToken
        );
        bytes memory tail = bytes.concat(
            f.sourceDepositor,
            f.destinationRecipient,
            f.sourceSigner,
            f.destinationCaller,
            bytes32(f.value),
            f.salt,
            bytes4(uint32(0))
        );
        return keccak256(bytes.concat(head, tail));
    }

    /// @dev SL Receipt struct hash (02 §6.3.3); `originAsserted` is hashed as keccak256(bytes(string)).
    function receiptStructHash(ICzarVault.SlReceipt memory r) internal pure returns (bytes32) {
        // Split in two abi.encode calls (stack limit without via-IR); every field is a static 32-byte word.
        return keccak256(
            bytes.concat(
                abi.encode(
                    RECEIPT_TYPEHASH,
                    r.paymentRefHash,
                    r.requestCommit,
                    r.responseCommit,
                    r.statusCode,
                    keccak256(bytes(r.originAsserted)),
                    r.requirementsHashSeen
                ),
                abi.encode(
                    r.tRequest, r.tPaymentSigned, r.tComplete, r.outcome, r.localChecksCommit, r.disclosure, r.createdAt
                )
            )
        );
    }

    /// @dev ReceiptAttestation(bytes32 receiptStructHash) struct hash (02 §6.2; RV-013).
    function receiptAttestationStructHash(bytes32 receiptHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(RECEIPT_ATTESTATION_TYPEHASH, receiptHash));
    }

    /// @dev AutonomyRaise(bytes32 category,uint256 newLimit,uint64 periodId,uint256 nonce,uint256 deadline).
    function autonomyRaiseStructHash(
        bytes32 category,
        uint256 newLimit,
        uint64 periodId,
        uint256 nonce,
        uint256 deadline
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(AUTONOMY_RAISE_TYPEHASH, category, newLimit, periodId, nonce, deadline));
    }

    /// @dev OwnerAction(uint8 action,bytes32 payloadHash,uint256 nonce,uint256 deadline).
    function ownerActionStructHash(uint8 action, bytes32 payloadHash, uint256 nonce, uint256 deadline)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(OWNER_ACTION_TYPEHASH, action, payloadHash, nonce, deadline));
    }

    /// @dev Left-pads an address to bytes32 (Gateway uses bytes32 addresses).
    function toBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}

/// @dev The 14 TransferSpec fields (hookData omitted: always empty in Czar).
struct TransferSpecFields {
    uint32 version;
    uint32 sourceDomain;
    uint32 destinationDomain;
    bytes32 sourceContract;
    bytes32 destinationContract;
    bytes32 sourceToken;
    bytes32 destinationToken;
    bytes32 sourceDepositor;
    bytes32 destinationRecipient;
    bytes32 sourceSigner;
    bytes32 destinationCaller;
    uint256 value;
    bytes32 salt;
}
