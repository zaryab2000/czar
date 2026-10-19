// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title MockUSDC3009
/// @notice Test double of Arc USDC (`NativeFiatTokenV2_2`, A1-04) for unit, fuzz and invariant tests.
///         It reproduces the parts the vault depends on: EIP-3009 with ERC-1271 dispatch, the nonce map,
///         validAfter/validBefore, pause and blacklist. Native-coin balance plumbing (A1-05) is not mocked;
///         fork tests (T-022) cover the real token.
/// @dev Behaviour follows circlefin/stablecoin-evm `contracts/v2/EIP3009.sol` lines 84–143 and 296–335 and
///      `contracts/util/SignatureChecker.sol` lines 38–76 (A1-06, A1-07, A1-09). Revert strings are copied.
contract MockUSDC3009 {
    // A1-03: name "USDC", symbol "USDC", version "2", decimals 6.
    string internal constant NAME = "USDC";
    string internal constant SYMBOL = "USDC";
    string internal constant VERSION = "2";
    uint8 internal constant DECIMALS = 6;

    // EIP3009.sol: keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;
    // keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;
    // keccak256("CancelAuthorization(address authorizer,bytes32 nonce)")
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429;

    bytes4 internal constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
    uint256 internal constant ECDSA_SIGNATURE_LENGTH = 65;
    // secp256k1n / 2; ECRecover rejects malleable high-s signatures.
    uint256 internal constant SECP256K1_HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    bool public paused;
    mapping(address => bool) internal _blacklisted;
    mapping(address => mapping(bytes32 => bool)) internal _authorizationStates;
    address public immutable controller;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);
    event Pause();
    event Unpause();
    event Blacklisted(address indexed account);
    event UnBlacklisted(address indexed account);

    modifier whenNotPaused() {
        require(!paused, "Pausable: paused");
        _;
    }

    modifier notBlacklisted(address account) {
        require(!_blacklisted[account], "Blacklistable: account is blacklisted");
        _;
    }

    modifier onlyController() {
        require(msg.sender == controller, "MockUSDC3009: caller is not the controller");
        _;
    }

    constructor() {
        controller = msg.sender;
    }

    // ─────────────── Test controls (stand in for Circle's minter, pauser and blacklister roles) ───────────────

    function mint(address to, uint256 value) external onlyController {
        require(to != address(0), "FiatToken: mint to the zero address");
        require(value > 0, "FiatToken: mint amount not greater than 0");
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function pause() external onlyController {
        paused = true;
        emit Pause();
    }

    function unpause() external onlyController {
        paused = false;
        emit Unpause();
    }

    function blacklist(address account) external onlyController {
        _blacklisted[account] = true;
        emit Blacklisted(account);
    }

    function unBlacklist(address account) external onlyController {
        _blacklisted[account] = false;
        emit UnBlacklisted(account);
    }

    // ─────────────── ERC-20 (FiatTokenV2_2 modifiers) ───────────────

    function name() external pure returns (string memory) {
        return NAME;
    }

    function symbol() external pure returns (string memory) {
        return SYMBOL;
    }

    function version() external pure returns (string memory) {
        return VERSION;
    }

    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }

    function isBlacklisted(address account) external view returns (bool) {
        return _blacklisted[account];
    }

    /// @notice A1-03: DOMAIN_SEPARATOR = EIP712Domain(name "USDC", version "2", chainId, verifyingContract).
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(NAME)),
                keccak256(bytes(VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    function approve(address spender, uint256 value)
        external
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(spender)
        returns (bool)
    {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value)
        external
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(to)
        returns (bool)
    {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value)
        external
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(from)
        notBlacklisted(to)
        returns (bool)
    {
        require(value <= allowance[from][msg.sender], "ERC20: transfer amount exceeds allowance");
        allowance[from][msg.sender] -= value;
        _transfer(from, to, value);
        return true;
    }

    // ─────────────── EIP-3009 (A1-08 selectors) ───────────────

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /// @notice `0xe3ee160e`: the v,r,s overload packs abi.encodePacked(r, s, v) and takes the same path (A1-09).
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused notBlacklisted(from) notBlacklisted(to) {
        _transferWithAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v)
        );
    }

    /// @notice `0xcf092995`: the bytes overload used for contract signers (A1-08, A1-20).
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external whenNotPaused notBlacklisted(from) notBlacklisted(to) {
        _transferWithAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature
        );
    }

    /// @notice `0x88b7ab63` (A1-08). The caller must be the payee.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external whenNotPaused notBlacklisted(from) notBlacklisted(to) {
        require(to == msg.sender, "FiatTokenV2: caller must be the payee");
        _transferWithAuthorization(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature
        );
    }

    /// @notice `0xb7b72899` (A1-08).
    function cancelAuthorization(address authorizer, bytes32 nonce, bytes memory signature) external whenNotPaused {
        require(!_authorizationStates[authorizer][nonce], "FiatTokenV2: authorization is used or canceled");
        _requireValidSignature(authorizer, keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)), signature);
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _transferWithAuthorization(
        bytes32 typeHash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) internal {
        // EIP3009.sol _requireValidAuthorization: strict inequalities on both bounds.
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!_authorizationStates[from][nonce], "FiatTokenV2: authorization is used or canceled");
        _requireValidSignature(
            from, keccak256(abi.encode(typeHash, from, to, value, validAfter, validBefore, nonce)), signature
        );
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function _requireValidSignature(address signer, bytes32 structHash, bytes memory signature) internal view {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        require(_isValidSignatureNow(signer, digest, signature), "FiatTokenV2: invalid signature");
    }

    /// @dev SignatureChecker.isValidSignatureNow (A1-09): a signer with code is asked through a staticcall to
    ///      isValidSignature(bytes32,bytes); the call must succeed and return at least 32 bytes whose first word
    ///      equals 0x1626ba7e. A signer without code is checked by ECDSA recovery.
    function _isValidSignatureNow(address signer, bytes32 digest, bytes memory signature)
        internal
        view
        returns (bool)
    {
        if (signer.code.length == 0) return _recover(digest, signature) == signer;
        (bool success, bytes memory result) =
            signer.staticcall(abi.encodeWithSelector(ERC1271_MAGIC_VALUE, digest, signature));
        return success && result.length >= 32 && abi.decode(result, (bytes32)) == bytes32(ERC1271_MAGIC_VALUE);
    }

    /// @dev ECRecover.recover: 65-byte r‖s‖v only, low s, v ∈ {27, 28}, non-zero result.
    function _recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        require(signature.length == ECDSA_SIGNATURE_LENGTH, "ECRecover: invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        require(uint256(s) <= SECP256K1_HALF_N, "ECRecover: invalid signature 's' value");
        require(v == 27 || v == 28, "ECRecover: invalid signature 'v' value");
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0), "ECRecover: invalid signature");
        return recovered;
    }

    /// @dev NativeFiatTokenV2_2 _transfer checks (A1-05; zero-address rule also enforced by Arc, A9-14).
    function _transfer(address from, address to, uint256 value) internal {
        require(from != address(0), "ERC20: transfer from the zero address");
        require(to != address(0), "ERC20: transfer to the zero address");
        require(value <= balanceOf[from], "ERC20: transfer amount exceeds balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
