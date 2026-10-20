// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {PAYEE_LEAF_TAG} from "./CzarConstants.sol";

library PayeeLeaf {
    /// @dev Double-hashed leaf (02 §5.3): keccak256(bytes.concat(keccak256(abi.encode(TAG, payee, kind, stepIndex, stepCap)))).
    function hash(address payee, uint8 kind, uint32 stepIndex, uint256 stepCap) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(PAYEE_LEAF_TAG, payee, kind, stepIndex, stepCap))));
    }

    /// @dev True when the leaf is in the tree with this root (sorted-pair nodes, OpenZeppelin MerkleProof).
    function verify(
        bytes32[] calldata proof,
        bytes32 root,
        address payee,
        uint8 kind,
        uint32 stepIndex,
        uint256 stepCap
    ) internal pure returns (bool) {
        return MerkleProof.verifyCalldata(proof, root, hash(payee, kind, stepIndex, stepCap));
    }
}
