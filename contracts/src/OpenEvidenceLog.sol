// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IOpenEvidenceLog} from "./interfaces/IOpenEvidenceLog.sol";

/// @title OpenEvidenceLog
/// @notice Ownerless, append-only commitment log (Selection Layer §7.1, adopted verbatim; RV-014 amendment).
///         Anyone publishes under their own address; readers choose publishers.
/// @dev Specification: specs/03-smart-contracts/open-evidence-log.md. No owner, no pause, no upgrade, no
///      payable function, no external calls. Contents are never inspected; `uri` is event-only.
contract OpenEvidenceLog is IOpenEvidenceLog {
    uint8 private constant INTENT_UNKNOWN = 0;
    uint8 private constant INTENT_COMMITTED = 1;
    uint8 private constant INTENT_REVEALED = 2;

    /// @dev publisher → kind → commitments, append-only.
    mapping(address => mapping(uint8 => Commitment[])) private _log;
    /// @dev publisher → intent root → 0 unknown, 1 committed, 2 revealed.
    mapping(address => mapping(bytes32 => uint8)) private _intent;
    /// @dev publisher → intent root → batch root.
    mapping(address => mapping(bytes32 => bytes32)) private _batchOf;

    /// @inheritdoc IOpenEvidenceLog
    function commit(Kind kind, bytes32 root, bytes32 prev, bytes32 uriHash, string calldata uri)
        external
        returns (uint256 seq)
    {
        Commitment[] storage chain = _log[msg.sender][uint8(kind)];
        bytes32 expected = chain.length == 0 ? bytes32(0) : chain[chain.length - 1].root;
        if (prev != expected) revert PrevMismatch(expected, prev);
        if (kind == Kind.PROBE_INTENT) {
            // RV-014: a PROBE_INTENT root is committed at most once, before or after its reveal.
            if (_intent[msg.sender][root] != INTENT_UNKNOWN) revert AlreadyCommitted(root);
            _intent[msg.sender][root] = INTENT_COMMITTED;
        }
        seq = chain.length;
        chain.push(
            Commitment({
                root: root,
                prev: prev,
                uriHash: uriHash,
                timestamp: uint64(block.timestamp),
                blockNumber: uint64(block.number),
                kind: kind
            })
        );
        emit Committed(msg.sender, kind, seq, root, prev, uriHash, uri);
    }

    /// @inheritdoc IOpenEvidenceLog
    function reveal(bytes32 intentRoot, bytes32 batchRoot, bytes32 uriHash, string calldata uri) external {
        uint8 status = _intent[msg.sender][intentRoot];
        if (status == INTENT_UNKNOWN) revert UnknownIntent(intentRoot);
        if (status == INTENT_REVEALED) revert AlreadyRevealed(intentRoot);
        _intent[msg.sender][intentRoot] = INTENT_REVEALED;
        _batchOf[msg.sender][intentRoot] = batchRoot;
        emit Revealed(msg.sender, intentRoot, batchRoot, uriHash, uri);
    }

    /// @inheritdoc IOpenEvidenceLog
    function count(address publisher, Kind kind) external view returns (uint256) {
        return _log[publisher][uint8(kind)].length;
    }

    /// @inheritdoc IOpenEvidenceLog
    function get(address publisher, Kind kind, uint256 seq) external view returns (Commitment memory) {
        // Out-of-range reads revert with the array bounds panic (03 open-evidence-log.md §6).
        return _log[publisher][uint8(kind)][seq];
    }

    /// @inheritdoc IOpenEvidenceLog
    function latest(address publisher, Kind kind) external view returns (Commitment memory c) {
        Commitment[] storage chain = _log[publisher][uint8(kind)];
        if (chain.length != 0) c = chain[chain.length - 1];
    }

    /// @inheritdoc IOpenEvidenceLog
    function intentStatus(address publisher, bytes32 intentRoot)
        external
        view
        returns (bool committed, bool revealed, bytes32 batchRoot)
    {
        uint8 status = _intent[publisher][intentRoot];
        committed = status != INTENT_UNKNOWN;
        revealed = status == INTENT_REVEALED;
        batchRoot = _batchOf[publisher][intentRoot];
    }
}
