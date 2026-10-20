// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IUsdc3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;

    function balanceOf(address account) external view returns (uint256);

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @title SettleProbe
/// @notice Simulation-only helper for experiment A1: placed with an eth_call code override, it
///         calls the bytes-signature overload of `transferWithAuthorization` and reports the
///         before/after balances and nonce state in one call.
contract SettleProbe {
    IUsdc3009 internal constant USDC = IUsdc3009(0x3600000000000000000000000000000000000000);

    /// @notice Settle one authorization and return observed state changes.
    /// @return fromBefore Payer USDC balance before.
    /// @return fromAfter Payer USDC balance after.
    /// @return toBefore Payee USDC balance before.
    /// @return toAfter Payee USDC balance after.
    /// @return nonceUsed `authorizationState(from, nonce)` after.
    function settle(
        address from,
        address to,
        uint256 value,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    )
        external
        returns (
            uint256 fromBefore,
            uint256 fromAfter,
            uint256 toBefore,
            uint256 toAfter,
            bool nonceUsed
        )
    {
        fromBefore = USDC.balanceOf(from);
        toBefore = USDC.balanceOf(to);
        USDC.transferWithAuthorization(from, to, value, 0, validBefore, nonce, signature);
        fromAfter = USDC.balanceOf(from);
        toAfter = USDC.balanceOf(to);
        nonceUsed = USDC.authorizationState(from, nonce);
    }
}
