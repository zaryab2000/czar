// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title PayeeTree
/// @notice The four-leaf payeeRoot fixture (07-contract-build/fixtures/payee-tree.json, czar-merkle-v1) as constants and
///         proofs, for vault tests that need real Merkle proofs. Leaves:
///         0x…beef and 0x…cafe: kind 1 (x402), step 0, stepCap 1,000,000 (two alternate payees of one step);
///         0x…d00d: kind 2 (job), step 1, stepCap 400,000; 0x…b0c0: kind 4 (pocket), step type(uint32).max, cap 0.
abstract contract PayeeTree {
    bytes32 internal constant PAYEE_ROOT = 0x5260a09a91439828d8270628cc7759cccd88e6fb8c0913079b9cb3b4ed7a8053;
    address internal constant PAYEE_BEEF = address(0xbeef);
    address internal constant PAYEE_CAFE = address(0xcafe);
    address internal constant PROVIDER_D00D = address(0xd00d);
    address internal constant POCKET_B0C0 = address(0xb0c0);
    uint32 internal constant STEP_X402 = 0;
    uint32 internal constant STEP_JOB = 1;
    uint256 internal constant STEP_X402_CAP = 1_000_000;
    uint256 internal constant STEP_JOB_CAP = 400_000;

    function _proof2(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = a;
        p[1] = b;
    }

    function _proofBeef() internal pure returns (bytes32[] memory) {
        return _proof2(
            0xab9631b63ff19fbac7755a1065d573f639d8d443130d6077cf2f1c7e3113f856,
            0x89c3e8f52ad7e7775b76d91a2e009bd59bb09b3c83b270fc21645a4443a2cde9
        );
    }

    function _proofCafe() internal pure returns (bytes32[] memory) {
        return _proof2(
            0x04e78038f4a24b35844ef3fcf59c513c5437c3866b648a9e11cf2f90978bf372,
            0x2bc447d59d756cdde730e0958a2ffe4f559f7ebfb0f71c1bc6c372a3407438aa
        );
    }

    function _proofD00d() internal pure returns (bytes32[] memory) {
        return _proof2(
            0x26c269f6eccb85afb6706039229e977df700c4e25fe066861064966295b1dfe7,
            0x2bc447d59d756cdde730e0958a2ffe4f559f7ebfb0f71c1bc6c372a3407438aa
        );
    }

    function _proofB0c0() internal pure returns (bytes32[] memory) {
        return _proof2(
            0x730c32c180b9f083f727dd233f0736cd6a5a0ae28a6e6c49dea73bfa0bf9c6f8,
            0x89c3e8f52ad7e7775b76d91a2e009bd59bb09b3c83b270fc21645a4443a2cde9
        );
    }
}
