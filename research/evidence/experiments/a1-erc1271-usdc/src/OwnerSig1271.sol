// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title OwnerSig1271
/// @notice Throwaway ERC-1271 account for experiment A1. A signature is valid when the first
///         65 bytes (r, s, v) recover to `owner` over the exact digest passed in.
/// @dev Test-only. No replay domain of its own: it relies on the caller's digest (EIP-712 for
///      USDC, which already binds `from` = this contract).
contract OwnerSig1271 {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant INVALID = 0xffffffff;
    uint256 internal constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    error ZeroOwner();

    address public owner;

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroOwner();
        owner = owner_;
    }

    /// @notice ERC-1271 check.
    /// @param hash Digest the token asks about.
    /// @param signature r || s || v (65 bytes); extra trailing bytes are ignored.
    /// @return MAGIC when the signature recovers to `owner`, otherwise 0xffffffff.
    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        if (signature.length < 65) return INVALID;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (uint256(s) > HALF_N) return INVALID;
        address signer = ecrecover(hash, v, r, s);
        if (signer == address(0) || signer != owner) return INVALID;
        return MAGIC;
    }
}
