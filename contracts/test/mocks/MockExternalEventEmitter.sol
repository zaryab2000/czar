// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

contract MockExternalEventEmitter {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event Upgraded(address indexed implementation);

    function emitTransfer(address from, address to, uint256 value) external {
        emit Transfer(from, to, value);
    }

    function emitAuthorizationUsed(address authorizer, bytes32 nonce) external {
        emit AuthorizationUsed(authorizer, nonce);
    }

    function emitUpgraded(address implementation) external {
        emit Upgraded(implementation);
    }
}
