// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title MockGatewayMinter
/// @notice Test double of Circle's GatewayMinter replay set, the one minter read the vault relies on to confirm a
///         pullback (czar-vault.md §10). Mirrors evm-gateway-contracts @ c21d2d2
///         `src/modules/common/TransferSpecHashes.sol` lines 29–60 (A2-16, AR-15).
contract MockGatewayMinter {
    address public immutable controller;
    mapping(bytes32 => bool) internal _usedHashes;

    error TransferSpecHashUsed(bytes32 transferSpecHash);

    constructor() {
        controller = msg.sender;
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
