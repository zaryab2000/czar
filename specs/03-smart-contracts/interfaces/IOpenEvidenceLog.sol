// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IOpenEvidenceLog
/// @notice Ownerless, append-only commitment log on Arc. Adopted unchanged from
///         `architecture/selection-layer-architecture.md` §7.1 (Selection Layer, 2026-10-17).
///         Anyone publishes under their own address; readers choose which publishers to trust.
/// @dev No owner, no pause, no upgrade. A new version is a new deployment announced by a
///      `POLICY_RELEASE` on the old one. The contract never inspects contents.
interface IOpenEvidenceLog {
    /// @notice Kinds of commitments. Stored as `uint8` keys in the per-publisher log.
    enum Kind {
        PROBE_INTENT,
        EVIDENCE_BATCH,
        FEATURE_SNAPSHOT,
        POLICY_RELEASE,
        CORRECTION,
        PROBER_REGISTRATION
    }

    /// @notice One commitment in a publisher's per-kind hash chain.
    /// @param root Merkle root or content hash.
    /// @param prev Previous root of the same publisher and kind; 0 for the first.
    /// @param uriHash keccak256 of the archive's IPFS CID (binds availability).
    /// @param timestamp `block.timestamp` at commit.
    /// @param blockNumber Block of the commit, for seed derivation (`blockhash(blockNumber + 1)`).
    /// @param kind The commitment kind.
    struct Commitment {
        bytes32 root;
        bytes32 prev;
        bytes32 uriHash;
        uint64 timestamp;
        uint64 blockNumber;
        Kind kind;
    }

    /// @notice Emitted on every `commit`. `uri` is event-only; readers take it from here.
    event Committed(
        address indexed publisher,
        Kind indexed kind,
        uint256 indexed seq,
        bytes32 root,
        bytes32 prev,
        bytes32 uriHash,
        string uri
    );

    /// @notice Emitted when a probe batch is linked to an earlier `PROBE_INTENT` commitment.
    event Revealed(address indexed publisher, bytes32 indexed intentRoot, bytes32 batchRoot, bytes32 uriHash, string uri);

    /// @notice `prev` did not equal the publisher's latest root for this kind.
    error PrevMismatch(bytes32 expected, bytes32 given);
    /// @notice `reveal` for an intent root this publisher never committed.
    error UnknownIntent(bytes32 intentRoot);
    /// @notice `reveal` called twice for the same intent root.
    error AlreadyRevealed(bytes32 intentRoot);

    /// @notice Append a commitment under `msg.sender`.
    /// @dev `prev` MUST equal the publisher's latest root for this kind, or 0 if none.
    ///      When `kind == PROBE_INTENT` the intent status becomes "committed".
    /// @param kind The commitment kind.
    /// @param root Merkle root or content hash.
    /// @param prev The publisher's previous root of this kind, or 0.
    /// @param uriHash keccak256 of the archive CID.
    /// @param uri The archive URI (event-only).
    /// @return seq The index of the new commitment in the publisher's log for this kind.
    function commit(Kind kind, bytes32 root, bytes32 prev, bytes32 uriHash, string calldata uri)
        external
        returns (uint256 seq);

    /// @notice Link an executed probe batch to an earlier `PROBE_INTENT` commitment by the same publisher.
    /// @dev Reverts unless the intent status is "committed"; sets it to "revealed".
    /// @param intentRoot The root committed earlier as `PROBE_INTENT`.
    /// @param batchRoot The root of the executed batch.
    /// @param uriHash keccak256 of the batch archive CID.
    /// @param uri The batch archive URI (event-only).
    function reveal(bytes32 intentRoot, bytes32 batchRoot, bytes32 uriHash, string calldata uri) external;

    /// @notice Number of commitments a publisher has made of a kind.
    function count(address publisher, Kind kind) external view returns (uint256);

    /// @notice A commitment by index. Reverts when `seq` is out of range.
    function get(address publisher, Kind kind, uint256 seq) external view returns (Commitment memory);

    /// @notice The publisher's latest commitment of a kind; the zero struct when none exists.
    function latest(address publisher, Kind kind) external view returns (Commitment memory);

    /// @notice Status of a probe intent root for a publisher.
    /// @return committed True once committed as `PROBE_INTENT`.
    /// @return revealed True once revealed.
    /// @return batchRoot The batch root given at reveal, or 0.
    function intentStatus(address publisher, bytes32 intentRoot)
        external
        view
        returns (bool committed, bool revealed, bytes32 batchRoot);
}
