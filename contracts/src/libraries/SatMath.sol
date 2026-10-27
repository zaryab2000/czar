// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

library SatMath {
    /// @dev a − b, or 0 when b ≥ a (czar-vault.md §4 "sat"; RV-008, RV-011).
    function sat(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }
}
