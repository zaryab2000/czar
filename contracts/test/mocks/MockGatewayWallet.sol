// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IBlacklistableToken {
    function isBlacklisted(address account) external view returns (bool);
}

interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

/// @title MockGatewayWallet
/// @notice Test double of Circle's GatewayWallet for the pocket path: deposit, depositFor, delegates and
///         the advisory balance read. Mirrors circlefin/evm-gateway-contracts @ c21d2d2 (A2-21)
///         `src/modules/wallet/Deposits.sol` and `Delegation.sol`; event and error signatures are copied.
/// @dev Burn intents are signed off-chain and attested by Circle's API (A2-16); `testBurn` stands in for the
///      on-chain `gatewayBurn` so tests can move a pocket balance after a pullback.
///      SCR-150 adds the trustless withdrawal (A2-13 to A2-15) and `testInitialize`, so the runtime code can be
///      copied to the canonical GatewayWallet address on a CLEAN local chain (`anvil_setCode` skips the
///      constructor). Withdrawal event names other than the A2-13 revert are local test names, not verified
///      against Circle's source.
contract MockGatewayWallet {
    enum AuthorizationStatus {
        Unauthorized,
        Authorized,
        Revoked
    }

    /// @notice Local default delay in blocks (SCR-150 §2); Circle uses 1,209,600 (A2-14). Tests must not wait 7 days.
    uint256 public constant DEFAULT_WITHDRAWAL_DELAY_BLOCKS = 10;

    address public immutable controller;
    // Storage layout: the first five slots keep the pre-SCR-150 order (paused, isTokenSupported, isDenylisted,
    // _available, _delegates) so tests that write `isTokenSupported` at slot 1 with `anvil_setStorageAt`
    // (apps/indexer/test/replay-anvil.test.ts) keep working. SCR-150 state is appended below.
    bool public paused;
    mapping(address => bool) public isTokenSupported;
    mapping(address => bool) public isDenylisted;
    mapping(address token => mapping(address depositor => uint256)) internal _available;
    mapping(address token => mapping(address depositor => mapping(address delegate => AuthorizationStatus)))
        internal _delegates;
    bool public initialized;
    uint256 public withdrawalDelay;
    mapping(address token => mapping(address depositor => uint256)) internal _withdrawing;
    mapping(address token => mapping(address depositor => uint256)) internal _withdrawalBlock;

    /// @dev SCR-150 §4 (PR #122 P1): one burn per transfer spec, so stand-in retries, concurrent requests and
    ///      stand-in restarts never debit the depositor twice. The chain, not the stand-in process, is the record.
    struct BurnRecord {
        address token;
        address depositor;
        uint256 value;
        address recipient;
    }

    mapping(bytes32 transferSpecHash => BurnRecord) internal _burns;

    // Deposits.sol line 45.
    event Deposited(address indexed token, address indexed depositor, address indexed sender, uint256 value);
    // Delegation.sol lines 47, 54.
    event DelegateAdded(address indexed token, address indexed depositor, address delegate);
    event DelegateRemoved(address indexed token, address indexed depositor, address delegate);
    // Local test events for the trustless withdrawal (A2-15); names not verified against Withdrawals.sol.
    event WithdrawalInitiated(
        address indexed token, address indexed depositor, uint256 value, uint256 totalWithdrawing, uint256 availableAtBlock
    );
    event WithdrawalCompleted(address indexed token, address indexed depositor, uint256 value);

    error DepositValueMustBePositive();
    error DepositorIsBlacklisted(address depositor);
    error CannotDelegateToSelf();
    error NotAuthorized();
    error InvalidAddress();
    error AccountDenylisted(address addr);
    error UnsupportedToken(address token);
    error EnforcedPause();
    error InsufficientBalance();
    // A2-13: `withdraw` reverts `WithdrawalNotYetAvailable` while the withdrawal block is in the future.
    error WithdrawalNotYetAvailable();
    error WithdrawalValueMustBePositive();
    error NoWithdrawingBalance();
    error AlreadyInitialized();
    error BurnRecordMismatch(bytes32 transferSpecHash);

    modifier whenNotPaused() {
        if (paused) revert EnforcedPause();
        _;
    }

    modifier notDenylisted(address addr) {
        if (isDenylisted[addr]) revert AccountDenylisted(addr);
        _;
    }

    modifier tokenSupported(address token) {
        if (!isTokenSupported[token]) revert UnsupportedToken(token);
        _;
    }

    modifier onlyController() {
        require(msg.sender == controller, "MockGatewayWallet: caller is not the controller");
        _;
    }

    constructor(address usdc) {
        controller = msg.sender;
        _initialize(usdc);
    }

    // ─────────────── Test controls ───────────────

    /// @notice SCR-150 §1: sets the storage the constructor sets, once, after the runtime code was copied to the
    ///         canonical address with `anvil_setCode` (which runs no constructor).
    function testInitialize(address usdc) external onlyController {
        _initialize(usdc);
    }

    /// @notice SCR-150 §2: the delay in blocks between `initiateWithdrawal` and `withdraw`.
    function testSetWithdrawalDelay(uint256 blocks) external onlyController {
        withdrawalDelay = blocks;
    }

    function _initialize(address usdc) internal {
        if (initialized) revert AlreadyInitialized();
        if (usdc == address(0)) revert InvalidAddress();
        initialized = true;
        isTokenSupported[usdc] = true;
        withdrawalDelay = DEFAULT_WITHDRAWAL_DELAY_BLOCKS;
    }

    function setPaused(bool value) external onlyController {
        paused = value;
    }

    function setDenylisted(address addr, bool value) external onlyController {
        isDenylisted[addr] = value;
    }

    /// @notice Stands in for a minted burn intent: debits `depositor` and sends `value` to `recipient` (A2-16).
    function testBurn(address token, address depositor, uint256 value, address recipient) external onlyController {
        _burn(token, depositor, value, recipient);
    }

    /// @notice SCR-150 §4: the stand-in's burn for one attested transfer spec. The first call debits `depositor`
    ///         and records the burn under `transferSpecHash`; a repeat with identical arguments is a no-op (no second
    ///         debit), and a repeat with different arguments reverts `BurnRecordMismatch`.
    function testBurnForTransferSpec(
        bytes32 transferSpecHash,
        address token,
        address depositor,
        uint256 value,
        address recipient
    ) external onlyController {
        if (depositor == address(0) || recipient == address(0)) revert InvalidAddress();
        BurnRecord storage existing = _burns[transferSpecHash];
        if (existing.depositor != address(0)) {
            if (
                existing.token != token || existing.depositor != depositor || existing.value != value
                    || existing.recipient != recipient
            ) revert BurnRecordMismatch(transferSpecHash);
            return;
        }
        _burns[transferSpecHash] = BurnRecord(token, depositor, value, recipient);
        _burn(token, depositor, value, recipient);
    }

    /// @notice The recorded burn for `transferSpecHash`; all zero when none exists.
    function burnRecord(bytes32 transferSpecHash)
        external
        view
        returns (address token, address depositor, uint256 value, address recipient)
    {
        BurnRecord storage record = _burns[transferSpecHash];
        return (record.token, record.depositor, record.value, record.recipient);
    }

    function _burn(address token, address depositor, uint256 value, address recipient) internal {
        if (_available[token][depositor] < value) revert InsufficientBalance();
        _available[token][depositor] -= value;
        IERC20Minimal(token).transfer(recipient, value);
    }

    // ─────────────── Deposits (A2-01, A2-02) ───────────────

    function deposit(address token, uint256 value)
        external
        whenNotPaused
        notDenylisted(msg.sender)
        tokenSupported(token)
    {
        _depositWithApproval(token, msg.sender, msg.sender, value);
    }

    /// @notice A2-02: pulls from msg.sender (approve first) and credits `depositor`. Reverts on a zero
    ///         depositor, a denylisted caller or depositor, or a USDC-blacklisted depositor.
    function depositFor(address token, address depositor, uint256 value)
        external
        whenNotPaused
        notDenylisted(msg.sender)
        notDenylisted(depositor)
        tokenSupported(token)
    {
        if (depositor == address(0)) revert InvalidAddress();
        if (IBlacklistableToken(token).isBlacklisted(depositor)) revert DepositorIsBlacklisted(depositor);
        _depositWithApproval(token, depositor, msg.sender, value);
    }

    function _depositWithApproval(address token, address depositor, address sender, uint256 value) internal {
        if (value == 0) revert DepositValueMustBePositive();
        _available[token][depositor] += value;
        require(IERC20Minimal(token).transferFrom(sender, address(this), value), "MockGatewayWallet: transfer failed");
        emit Deposited(token, depositor, sender, value);
    }

    /// @notice Advisory read only (czar-vault.md §10); Circle's API is the source of truth for spendable balance.
    function availableBalance(address token, address depositor) external view returns (uint256) {
        return _available[token][depositor];
    }

    // ─────────────── Delegation (A2-04, A2-05) ───────────────

    /// @notice A2-04: a full allowance for `delegate` over the caller's `token` balance; cannot delegate to self.
    function addDelegate(address token, address delegate)
        external
        whenNotPaused
        notDenylisted(msg.sender)
        notDenylisted(delegate)
        tokenSupported(token)
    {
        if (delegate == address(0)) revert InvalidAddress();
        if (delegate == msg.sender) revert CannotDelegateToSelf();
        _delegates[token][msg.sender][delegate] = AuthorizationStatus.Authorized;
        emit DelegateAdded(token, msg.sender, delegate);
    }

    /// @notice A2-05: removal sets `Revoked`, not `Unauthorized`; a no-op when never authorized or already revoked.
    function removeDelegate(address token, address delegate)
        external
        whenNotPaused
        notDenylisted(msg.sender)
        tokenSupported(token)
    {
        if (delegate == address(0)) revert InvalidAddress();
        AuthorizationStatus existing = _delegates[token][msg.sender][delegate];
        if (existing == AuthorizationStatus.Unauthorized || existing == AuthorizationStatus.Revoked) return;
        _delegates[token][msg.sender][delegate] = AuthorizationStatus.Revoked;
        emit DelegateRemoved(token, msg.sender, delegate);
    }

    /// @notice A2-04: a depositor is always authorized for its own balance; otherwise the status must be Authorized.
    function isAuthorizedForBalance(address token, address depositor, address addr) external view returns (bool) {
        if (addr == depositor) return true;
        return _delegates[token][depositor][addr] == AuthorizationStatus.Authorized;
    }

    // ─────────────── Trustless withdrawal (A2-13 to A2-15) ───────────────

    /// @notice A2-15: moves `value` from available to withdrawing; a repeat call adds to the amount and resets the
    ///         timer. Uses `msg.sender` only (A2-06): a delegate cannot start it for someone else.
    function initiateWithdrawal(address token, uint256 value)
        external
        whenNotPaused
        notDenylisted(msg.sender)
        tokenSupported(token)
    {
        if (value == 0) revert WithdrawalValueMustBePositive();
        if (_available[token][msg.sender] < value) revert InsufficientBalance();
        _available[token][msg.sender] -= value;
        _withdrawing[token][msg.sender] += value;
        uint256 availableAt = block.number + withdrawalDelay;
        _withdrawalBlock[token][msg.sender] = availableAt;
        emit WithdrawalInitiated(token, msg.sender, value, _withdrawing[token][msg.sender], availableAt);
    }

    /// @notice A2-13, A2-15: pays the full withdrawing balance to `msg.sender` once the withdrawal block is reached.
    function withdraw(address token) external whenNotPaused notDenylisted(msg.sender) tokenSupported(token) {
        uint256 value = _withdrawing[token][msg.sender];
        if (value == 0) revert NoWithdrawingBalance();
        if (_withdrawalBlock[token][msg.sender] > block.number) revert WithdrawalNotYetAvailable();
        _withdrawing[token][msg.sender] = 0;
        _withdrawalBlock[token][msg.sender] = 0;
        require(IERC20Minimal(token).transfer(msg.sender, value), "MockGatewayWallet: transfer failed");
        emit WithdrawalCompleted(token, msg.sender, value);
    }

    /// @notice A2-15 view.
    function withdrawingBalance(address token, address depositor) external view returns (uint256) {
        return _withdrawing[token][depositor];
    }

    /// @notice A2-15 view: the block at which `withdraw` becomes available (0 when nothing is withdrawing).
    function withdrawalBlock(address token, address depositor) external view returns (uint256) {
        return _withdrawalBlock[token][depositor];
    }
}
