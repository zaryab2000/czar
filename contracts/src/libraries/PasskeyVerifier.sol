// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {ICzarVault} from "../interfaces/ICzarVault.sol";
import {REQUIRE_UV} from "./CzarConstants.sol";

library PasskeyVerifier {
    /// @dev True only if (1) authenticatorData is at least 37 bytes, (2) its first 32 bytes equal rpIdHash,
    /// (3) OpenZeppelin WebAuthn.verify(challenge = abi.encodePacked(digest), auth, qx, qy, REQUIRE_UV) is true.
    /// czar-vault.md §7. Never reverts on a bad assertion; returns false.
    function verify(bytes32 digest, ICzarVault.WebAuthnAuth calldata a, bytes32 qx, bytes32 qy, bytes32 rpIdHash)
        internal
        view
        returns (bool)
    {
        if (a.authenticatorData.length < 37) return false;
        if (bytes32(a.authenticatorData[0:32]) != rpIdHash) return false;
        WebAuthn.WebAuthnAuth memory oz = WebAuthn.WebAuthnAuth({
            r: a.r,
            s: a.s,
            challengeIndex: a.challengeIndex,
            typeIndex: a.typeIndex,
            authenticatorData: a.authenticatorData,
            clientDataJSON: a.clientDataJSON
        });
        return WebAuthn.verify(abi.encodePacked(digest), oz, qx, qy, REQUIRE_UV);
    }
}
