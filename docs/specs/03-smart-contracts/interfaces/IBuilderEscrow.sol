// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IBuilderEscrow
/// @notice Phase 2 (D29). Holds USDC tips per GitHub repository (`repoId`, spec 02 §7.1) until the
///         builder proves ownership (D23). Releases are scheduled by Czar's relayer, delayed, public,
///         and cancellable by the admin. Tippers never get refunds (D19).
interface IBuilderEscrow {
    /// @notice Lifecycle of the single active release for a repo.
    enum ReleaseState {
        None,
        Scheduled,
        Executed,
        Cancelled
    }

    /// @notice The active release record for a repo.
    /// @param wallet The builder wallet that will receive the balance.
    /// @param executableAt Earliest `block.timestamp` at which `executeRelease` may run.
    /// @param state The release state.
    struct Release {
        address wallet;
        uint64 executableAt;
        ReleaseState state;
    }

    /// @notice A tip was deposited for `repoId`.
    event Tipped(bytes32 indexed repoId, address indexed from, uint256 amount, uint256 newBalance);
    /// @notice A release was scheduled; funds move only after `executableAt`.
    event ReleaseScheduled(bytes32 indexed repoId, address indexed wallet, uint64 executableAt, uint256 amountAtSchedule);
    /// @notice The admin cancelled a scheduled release before it executed.
    event ReleaseCancelled(bytes32 indexed repoId, address wallet);
    /// @notice The full repo balance was sent to the builder wallet.
    event ReleaseExecuted(bytes32 indexed repoId, address indexed wallet, uint256 amount);
    /// @notice The relayer role moved to a new key.
    event RelayerSet(address indexed oldRelayer, address indexed newRelayer);

    error ZeroRepo();
    error TipTooSmall(uint256 amount);
    error UnexpectedAmount(uint256 expected, uint256 received);
    error NotRelayer();
    error ZeroWallet();
    error NothingToRelease(bytes32 repoId);
    error ReleaseActive(bytes32 repoId);
    error NotScheduled(bytes32 repoId);
    error DelayNotElapsed(uint64 executableAt);

    /// @notice Deposit a tip for a repo. Caller must have approved `amount` of USDC.
    /// @dev Pulls exactly `amount` and checks the balance delta. Anyone may deposit; the vault does.
    /// @param repoId keccak256("github:" + numeric repository id).
    /// @param amount USDC atomic units (6 decimals), at least `MIN_TIP`.
    function deposit(bytes32 repoId, uint256 amount) external;

    /// @notice Schedule a release of the repo's balance to `wallet` after `RELEASE_DELAY`.
    /// @dev Relayer only. One active release per repo.
    function scheduleRelease(bytes32 repoId, address wallet) external;

    /// @notice Cancel a scheduled release. Admin only. Moves no funds.
    function cancelRelease(bytes32 repoId) external;

    /// @notice Execute a scheduled release once the delay has elapsed. Anyone may call.
    /// @dev Sends the full current balance of the repo to the scheduled wallet.
    function executeRelease(bytes32 repoId) external;

    /// @notice Replace the relayer key. Admin only.
    function setRelayer(address newRelayer) external;

    /// @notice Pause deposits and executions. Admin only.
    function pause() external;

    /// @notice Unpause. Admin only.
    function unpause() external;

    /// @notice Unclaimed balance of a repo in USDC atomic units.
    function balanceOf(bytes32 repoId) external view returns (uint256);

    /// @notice The active release record of a repo.
    function releaseOf(bytes32 repoId) external view returns (Release memory);

    /// @notice The current relayer.
    function relayer() external view returns (address);

    /// @notice Minimum tip in USDC atomic units.
    function MIN_TIP() external view returns (uint256);

    /// @notice Delay between scheduling and execution, in seconds.
    function RELEASE_DELAY() external view returns (uint64);
}
