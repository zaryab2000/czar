// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IERC20Transfer {
    function transfer(address to, uint256 value) external returns (bool);
}

/// @title MockGatewayMinter
/// @notice Test double of Circle's GatewayMinter replay set, the one minter read the vault relies on to confirm a
///         pullback (czar-vault.md §10). Mirrors evm-gateway-contracts @ c21d2d2
///         `src/modules/common/TransferSpecHashes.sol` lines 29–60 (A2-16, AR-15).
/// @dev SCR-150 §3, §4: `gatewayMint` accepts the LOCAL attestation the D92 stand-in returns,
///      `abi.encode(bytes32 transferSpecHash, address recipient, uint256 value, address depositor)`. The signature
///      is NOT verified: this is a test double for a CLEAN local chain; real attestation verification is first
///      exercised in M8 (D92). `AttestationUsed` uses Circle's canonical signature, the one the indexer registers in
///      `apps/indexer/src/external-abis.ts` (`GatewayMinter` ABI), so the local indexer marks the pullback attested.
///      The local attestation carries no source domain or signer: `sourceDomain` is the Arc Gateway domain (26,
///      `Deploy.s.sol` `ARC_GATEWAY_DOMAIN`, A2-01) and `sourceSigner` is zero.
contract MockGatewayMinter {
    address public immutable controller;
    address public usdc;
    mapping(bytes32 => bool) internal _usedHashes;

    error TransferSpecHashUsed(bytes32 transferSpecHash);
    error AlreadyInitialized();
    error NotInitialized();
    error InvalidAddress();

    /// @dev Arc's Gateway domain (A2-01, `Deploy.s.sol` `ARC_GATEWAY_DOMAIN`): the only source domain on a local chain.
    uint32 public constant LOCAL_SOURCE_DOMAIN = 26;

    /// @dev Circle's canonical event; must match `apps/indexer/src/external-abis.ts` exactly (topic0 included).
    event AttestationUsed(
        address indexed token,
        address indexed recipient,
        bytes32 indexed transferSpecHash,
        uint32 sourceDomain,
        bytes32 sourceDepositor,
        bytes32 sourceSigner,
        uint256 value
    );

    constructor() {
        controller = msg.sender;
    }

    /// @notice SCR-150 §1: sets the USDC token once (constructor-free placement with `anvil_setCode`).
    function testInitialize(address token) external {
        require(msg.sender == controller, "MockGatewayMinter: caller is not the controller");
        if (usdc != address(0)) revert AlreadyInitialized();
        if (token == address(0)) revert InvalidAddress();
        usdc = token;
    }

    /// @notice SCR-150 §3: marks the attested transfer spec used and pays `value` USDC to `recipient`.
    ///         Permissionless, as Circle's is when `destinationCaller` is zero (A2-16). `signature` is ignored.
    function gatewayMint(bytes calldata attestation, bytes calldata /* signature */ ) external {
        if (usdc == address(0)) revert NotInitialized();
        (bytes32 transferSpecHash, address recipient, uint256 value, address depositor) =
            abi.decode(attestation, (bytes32, address, uint256, address));
        if (_usedHashes[transferSpecHash]) revert TransferSpecHashUsed(transferSpecHash);
        if (recipient == address(0)) revert InvalidAddress();
        _usedHashes[transferSpecHash] = true;
        require(IERC20Transfer(usdc).transfer(recipient, value), "MockGatewayMinter: transfer failed");
        emit AttestationUsed(
            usdc, recipient, transferSpecHash, LOCAL_SOURCE_DOMAIN, bytes32(uint256(uint160(depositor))), bytes32(0), value
        );
    }

    /// @notice TransferSpecHashes.sol line 35.
    function isTransferSpecHashUsed(bytes32 transferSpecHash) external view returns (bool) {
        return _usedHashes[transferSpecHash];
    }

    /// @notice Stands in for `gatewayMint` marking the attested transfer spec as used (`_checkAndMarkTransferSpecHash`).
    function testMarkTransferSpecHashUsed(bytes32 transferSpecHash) external {
        require(msg.sender == controller, "MockGatewayMinter: caller is not the controller");
        if (_usedHashes[transferSpecHash]) revert TransferSpecHashUsed(transferSpecHash);
        _usedHashes[transferSpecHash] = true;
    }
}
