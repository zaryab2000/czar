// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IRecipeSplits
/// @notice Phase 2 (D29). Routes a `recipeId` to its payout target: a 0xSplits v2.2 PushSplit
///         (claimed authors, A7-01, A7-07) or the `BuilderEscrow` (unclaimed, D19). Holds no funds.
interface IRecipeSplits {
    /// @notice Target kinds.
    enum TargetKind {
        Unset,
        PushSplit,
        BuilderEscrow
    }

    /// @notice A recipe's payout target.
    struct Target {
        address addr;
        TargetKind kind;
    }

    /// @notice Emitted on every target change. Carries everything the indexer needs (A7-04: no subgraph on Arc).
    event TargetSet(bytes32 indexed recipeId, address indexed addr, TargetKind kind);

    error ZeroRecipe();
    error ZeroWallet();
    error BadKind(uint8 kind);
    error LengthMismatch();
    error TooManyRecipients(uint256 count);
    error BadAllocation();

    /// @notice Set a recipe's target directly. Admin only.
    /// @dev `kind == BuilderEscrow` requires `addr == BUILDER_ESCROW()`.
    function setTarget(bytes32 recipeId, address addr, TargetKind kind) external;

    /// @notice Create an immutable PushSplit for the recipe's authors through the pinned factory and set it as target.
    /// @dev Calls `PushSplitFactory.createSplit(Split, owner = address(0), creator = this)`
    ///      (`splits-contracts-monorepo` @ efec4ac4, `SplitFactoryV2.sol` lines 82–96).
    ///      `distributionIncentive` must be 0.
    /// @param recipeId The recipe.
    /// @param recipients Author wallets, at most `MAX_RECIPIENTS()`.
    /// @param allocations Per-recipient allocation units; must sum to `totalAllocation`.
    /// @param totalAllocation Sum of allocations.
    /// @param distributionIncentive Must be 0.
    /// @return split The created split address.
    function createAuthorSplit(
        bytes32 recipeId,
        address[] calldata recipients,
        uint256[] calldata allocations,
        uint256 totalAllocation,
        uint16 distributionIncentive
    ) external returns (address split);

    /// @notice The payout target of a recipe.
    function payoutTarget(bytes32 recipeId) external view returns (address addr, TargetKind kind);

    /// @notice Pinned 0xSplits v2.2 PushSplitFactory (`0x8E8eB0cC6AE34A38B67D5Cf91ACa38f60bc3Ecf4` on both Arc networks, A7-01).
    function PUSH_SPLIT_FACTORY() external view returns (address);

    /// @notice The `BuilderEscrow` used for unclaimed recipes.
    function BUILDER_ESCROW() external view returns (address);

    /// @notice Maximum recipients per author split.
    function MAX_RECIPIENTS() external view returns (uint256);
}
