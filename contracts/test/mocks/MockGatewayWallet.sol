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
contract MockGatewayWallet {
    enum AuthorizationStatus {
        Unauthorized,
        Authorized,
        Revoked
    }

    address public immutable controller;
    bool public paused;
    mapping(address => bool) public isTokenSupported;
    mapping(address => bool) public isDenylisted;
    mapping(address token => mapping(address depositor => uint256)) internal _available;
    mapping(address token => mapping(address depositor => mapping(address delegate => AuthorizationStatus)))
        internal _delegates;

    // Deposits.sol line 45.
    event Deposited(address indexed token, address indexed depositor, address indexed sender, uint256 value);
    // Delegation.sol lines 47, 54.
    event DelegateAdded(address indexed token, address indexed depositor, address delegate);
    event DelegateRemoved(address indexed token, address indexed depositor, address delegate);

    error DepositValueMustBePositive();
    error DepositorIsBlacklisted(address depositor);
    error CannotDelegateToSelf();
    error NotAuthorized();
    error InvalidAddress();
    error AccountDenylisted(address addr);
    error UnsupportedToken(address token);
    error EnforcedPause();
    error InsufficientBalance();

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
        isTokenSupported[usdc] = true;
    }

    // ─────────────── Test controls ───────────────

    function setPaused(bool value) external onlyController {
        paused = value;
    }

    function setDenylisted(address addr, bool value) external onlyController {
        isDenylisted[addr] = value;
    }

    /// @notice Stands in for a minted burn intent: debits `depositor` and sends `value` to `recipient` (A2-16).
    function testBurn(address token, address depositor, uint256 value, address recipient) external onlyController {
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
}
