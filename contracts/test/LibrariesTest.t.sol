// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {ICzarVault} from "../src/interfaces/ICzarVault.sol";
import {SatMath} from "../src/libraries/SatMath.sol";
import {CzarHashing, TransferSpecFields} from "../src/libraries/CzarHashing.sol";
import {PayeeLeaf} from "../src/libraries/PayeeLeaf.sol";
import {CzarNonces} from "../src/libraries/CzarNonces.sol";
import {PasskeyVerifier} from "../src/libraries/PasskeyVerifier.sol";
import {
    USDC_ADDRESS,
    EIP712_DOMAIN_FULL_TYPEHASH,
    EIP712_DOMAIN_NO_CONTRACT_TYPEHASH,
    TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
    TRANSFER_SPEC_TYPEHASH,
    BURN_INTENT_TYPEHASH,
    RECEIPT_TYPEHASH,
    RECEIPT_ATTESTATION_TYPEHASH,
    AUTONOMY_RAISE_TYPEHASH,
    OWNER_ACTION_TYPEHASH,
    GATEWAY_DOMAIN_SEPARATOR,
    USDC_NAME_HASH,
    USDC_VERSION_HASH,
    VAULT_NAME_HASH,
    SL_NAME_HASH,
    VERSION_1_HASH,
    KIND_USDC_3009,
    KIND_GATEWAY_BURN,
    KIND_SL_RECEIPT,
    PAYEE_LEAF_TAG,
    NONCE_TAG,
    SECP256K1_HALF_N,
    CANCEL_REASON,
    DESCRIPTION_PREFIX
} from "../src/libraries/CzarConstants.sol";

/// @dev 07-contract-build/01-shared-libraries.md (first part of T-013). Every expected value is copied from
/// docs/specs/02-data-and-protocol/vectors/eip712-vectors.json or 07-contract-build/fixtures/payee-tree.json.
contract LibrariesTest is Test {
    address internal constant VAULT = address(0xc2a21); // vectors: example vault 0x...0c2a21
    uint256 internal constant TESTNET = 5042002;
    uint256 internal constant MAINNET = 5042;
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    // ─────────────── CzarConstants (PRD §5.3) ───────────────

    function test_constants_tagsMatchPreimages() public pure {
        assertEq(KIND_USDC_3009, keccak256("czar.vault.sig.USDC_3009.v1"));
        assertEq(KIND_GATEWAY_BURN, keccak256("czar.vault.sig.GATEWAY_BURN.v1"));
        assertEq(KIND_SL_RECEIPT, keccak256("czar.vault.sig.SL_RECEIPT.v2"));
        assertEq(PAYEE_LEAF_TAG, keccak256("czar.payee-leaf.v1"));
        assertEq(NONCE_TAG, keccak256("czar.vault.nonce.v1"));
        assertEq(CANCEL_REASON, keccak256("czar:cancel"));
        assertEq(keccak256(bytes(DESCRIPTION_PREFIX)), keccak256("czar:"));
    }

    function test_constants_typeHashesMatchTypeStrings() public pure {
        assertEq(
            EIP712_DOMAIN_FULL_TYPEHASH,
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
        );
        assertEq(
            EIP712_DOMAIN_NO_CONTRACT_TYPEHASH, keccak256("EIP712Domain(string name,string version,uint256 chainId)")
        );
        assertEq(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
            keccak256(
                "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
            )
        );
        assertEq(RECEIPT_ATTESTATION_TYPEHASH, keccak256("ReceiptAttestation(bytes32 receiptStructHash)"));
        assertEq(
            AUTONOMY_RAISE_TYPEHASH,
            keccak256("AutonomyRaise(bytes32 category,uint256 newLimit,uint64 periodId,uint256 nonce,uint256 deadline)")
        );
        assertEq(
            OWNER_ACTION_TYPEHASH,
            keccak256("OwnerAction(uint8 action,bytes32 payloadHash,uint256 nonce,uint256 deadline)")
        );
        // TransferSpec, BurnIntent and Receipt type strings are long; their hashes are checked through the digest vectors below.
        assertEq(TRANSFER_SPEC_TYPEHASH, 0x44409c7ba8872720f5fc290d2788c2d70a3905b7ca1cdb2ffa152791a69e089b);
        assertEq(BURN_INTENT_TYPEHASH, 0x8b99d17a83a2dd1add9fc2a450e22732c7e8564aa110ab99c20485a7a10ba37c);
        assertEq(RECEIPT_TYPEHASH, 0xcd6ca6db33168140e9fc8604767fd5dc89fc51ca3853b876f9003e8bedd295f2);
    }

    function test_constants_halfN() public pure {
        assertEq(SECP256K1_HALF_N, uint256(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141) / 2);
    }

    function test_constants_gatewayDomain() public pure {
        bytes32 nameVersionOnly = 0xb03948446334eb9b2196d5eb166f69b9d49403eb4a12f36de8d3f9f3cb8e15c3;
        assertEq(
            GATEWAY_DOMAIN_SEPARATOR, keccak256(abi.encode(nameVersionOnly, keccak256("GatewayWallet"), keccak256("1")))
        );
    }

    // ─────────────── SatMath (PRD §6) ───────────────

    function testFuzz_sat_neverReverts(uint256 a, uint256 b) public pure {
        assertEq(SatMath.sat(a, b), a > b ? a - b : 0);
    }

    // ─────────────── CzarHashing (PRD §7.3) ───────────────

    function _usdcDomain(uint256 chainId) internal pure returns (bytes32) {
        return CzarHashing.domainSeparatorFull(USDC_NAME_HASH, USDC_VERSION_HASH, chainId, USDC_ADDRESS);
    }

    function _vaultDomain(uint256 chainId) internal pure returns (bytes32) {
        return CzarHashing.domainSeparatorFull(VAULT_NAME_HASH, VERSION_1_HASH, chainId, VAULT);
    }

    function _slDomain(uint256 chainId) internal pure returns (bytes32) {
        return CzarHashing.domainSeparatorNoContract(SL_NAME_HASH, VERSION_1_HASH, chainId);
    }

    function test_hashing_usdcDomainTestnet() public pure {
        assertEq(_usdcDomain(TESTNET), 0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0);
    }

    function test_hashing_usdcDomainMainnet() public pure {
        assertEq(_usdcDomain(MAINNET), 0x940506929bba468048a19b567f4f0d534714bc06604b5c3017e5d16785ccdf84);
    }

    function test_hashing_vaultDomainExample() public pure {
        assertEq(_vaultDomain(TESTNET), 0x64b8044ade387c82cd664c7d2b51859e664c6cee481b628977a3b94c6f77b6b0);
        assertEq(_vaultDomain(MAINNET), 0xc5b5d62f4382d2cb6a455b9848f98172337df886e42c7c57c0ff82f43c4fa755);
    }

    function test_hashing_slDomain() public pure {
        assertEq(_slDomain(TESTNET), 0x4937387a5eb9c824f88751eb9abc6792a901e035deb9ec3fa75f584cc4669f69);
        assertEq(_slDomain(MAINNET), 0x2a6156c387de0428b039beeb8edae161131616d6fc1fd3901b1f1836dfdc5a82);
    }

    function test_hashing_usdcTransferDigestVector() public pure {
        bytes32 structHash = CzarHashing.transferWithAuthorizationHash(
            VAULT,
            address(0xbEEF),
            100000,
            0,
            1760800000,
            bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111))
        );
        assertEq(
            CzarHashing.typedDataHash(_usdcDomain(TESTNET), structHash),
            0x0b90a5995f31dd9e567d03c72be39bad175cf2bb4fc652767365a0b44bf366b0
        );
    }

    function _burnSpec() internal pure returns (TransferSpecFields memory f) {
        f.version = 1;
        f.sourceDomain = 26;
        f.destinationDomain = 26;
        f.sourceContract = CzarHashing.toBytes32(0x0077777d7EBA4688BDeF3E311b846F25870A19B9); // testnet GatewayWallet
        f.destinationContract = CzarHashing.toBytes32(0x0022222ABE238Cc2C7Bb1f21003F0a260052475B); // testnet GatewayMinter
        f.sourceToken = CzarHashing.toBytes32(USDC_ADDRESS);
        f.destinationToken = CzarHashing.toBytes32(USDC_ADDRESS);
        f.sourceDepositor = CzarHashing.toBytes32(address(0xb0c0));
        f.destinationRecipient = CzarHashing.toBytes32(VAULT);
        f.sourceSigner = CzarHashing.toBytes32(VAULT);
        f.destinationCaller = bytes32(0);
        f.value = 199600;
        f.salt = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
    }

    function test_hashing_burnIntentVector() public pure {
        bytes32 specHash = CzarHashing.transferSpecStructHash(_burnSpec());
        assertEq(
            CzarHashing.typedDataHash(
                GATEWAY_DOMAIN_SEPARATOR, CzarHashing.burnIntentStructHash(68000000, 10000, specHash)
            ),
            0xbaa687f22d9719e8afd3f756b6c2c3991f4fcf2674f419c095132f7ec22d6ec8
        );
    }

    function test_hashing_transferSpecReplayVector() public pure {
        TransferSpecFields memory f = _burnSpec();
        assertEq(
            CzarHashing.transferSpecReplayHash(f), 0xa2f49c1a7ff819bf27ffd2ff6d87a0ea51b77284f7b879ac42deb760376d3616
        );
        // Length check of the same byte layout (vectors: transferSpecBytesLength = 340).
        bytes memory encoded = bytes.concat(
            bytes.concat(bytes4(0xca85def7), bytes4(f.version), bytes4(f.sourceDomain), bytes4(f.destinationDomain)),
            bytes.concat(f.sourceContract, f.destinationContract, f.sourceToken, f.destinationToken),
            bytes.concat(f.sourceDepositor, f.destinationRecipient, f.sourceSigner, f.destinationCaller),
            bytes.concat(bytes32(f.value), f.salt, bytes4(uint32(0)))
        );
        assertEq(encoded.length, 340);
        assertEq(keccak256(encoded), CzarHashing.transferSpecReplayHash(f));
    }

    function _receipt() internal pure returns (ICzarVault.SlReceipt memory r) {
        r.paymentRefHash = bytes32(uint256(0x3333333333333333333333333333333333333333333333333333333333333333));
        r.requestCommit = bytes32(uint256(0x4444444444444444444444444444444444444444444444444444444444444444));
        r.responseCommit = bytes32(uint256(0x5555555555555555555555555555555555555555555555555555555555555555));
        r.statusCode = 200;
        r.originAsserted = "https://merchant.example";
        r.requirementsHashSeen = bytes32(uint256(0x6666666666666666666666666666666666666666666666666666666666666666));
        r.tRequest = 1760790000;
        r.tPaymentSigned = 1760790001;
        r.tComplete = 1760790003;
        r.outcome = 0;
        r.localChecksCommit = bytes32(0);
        r.disclosure = 2;
        r.createdAt = 1760790004;
    }

    function test_hashing_receiptVector() public pure {
        bytes32 structHash = CzarHashing.receiptStructHash(_receipt());
        assertEq(structHash, 0xe79fd862d70a3af78fdf18fc3b4039605e1728e44110a659b1de9b4bd9c2f0df);
        assertEq(
            CzarHashing.typedDataHash(_slDomain(TESTNET), structHash),
            0x8bef0825cbab5aff373a3651d22ee4169a09d1504ad6eb30c02277d37725d561
        );
    }

    function test_hashing_receiptAttestationVector() public pure {
        bytes32 receiptHash = 0xe79fd862d70a3af78fdf18fc3b4039605e1728e44110a659b1de9b4bd9c2f0df;
        assertEq(
            CzarHashing.typedDataHash(_vaultDomain(TESTNET), CzarHashing.receiptAttestationStructHash(receiptHash)),
            0xe4f941d6e918d974ccc3f435b16b3dc38eaa8027fb1955a87ea3763d250e65a0
        );
    }

    function test_hashing_autonomyRaiseVector() public pure {
        bytes32 structHash = CzarHashing.autonomyRaiseStructHash(
            0x95f7801c97b17401c2c5a5b8fdb4f956cc377f647e35794f5b5da6aed60cd40d, 5000000, 2963, 7, 1792026000
        );
        assertEq(
            CzarHashing.typedDataHash(_vaultDomain(TESTNET), structHash),
            0xb6d92f2ab8f255a7aa93ad87b86fb4e3c22ccc3f7b86c4b4988a8c1fdf2123a3
        );
    }

    function test_hashing_ownerActionVector() public pure {
        bytes32 structHash = CzarHashing.ownerActionStructHash(
            1, bytes32(uint256(0x7777777777777777777777777777777777777777777777777777777777777777)), 3, 1760900000
        );
        assertEq(
            CzarHashing.typedDataHash(_vaultDomain(TESTNET), structHash),
            0x69b896f95e60ed729ed2cfab1c7a025da52213188bb0fa2fcee14cda92c559f5
        );
    }

    // ─────────────── PayeeLeaf (PRD §8.2) ───────────────

    /// @dev External so the proof is calldata, as PayeeLeaf.verify requires.
    function verifyExt(
        bytes32[] calldata proof,
        bytes32 root,
        address payee,
        uint8 kind,
        uint32 stepIndex,
        uint256 stepCap
    ) external pure returns (bool) {
        return PayeeLeaf.verify(proof, root, payee, kind, stepIndex, stepCap);
    }

    function _proof(bytes32 a) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = a;
    }

    function _proof(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = a;
        p[1] = b;
    }

    function _assertLeaf(
        bytes32 root,
        address payee,
        uint8 kind,
        uint32 stepIndex,
        uint256 stepCap,
        bytes32 expectedLeaf,
        bytes32[] memory proof
    ) internal view {
        assertEq(PayeeLeaf.hash(payee, kind, stepIndex, stepCap), expectedLeaf);
        assertTrue(this.verifyExt(proof, root, payee, kind, stepIndex, stepCap));
    }

    function test_payeeLeaf_fourLeafTree() public view {
        _assertLeaf(
            0x5260a09a91439828d8270628cc7759cccd88e6fb8c0913079b9cb3b4ed7a8053,
            address(0xbeef),
            1,
            0,
            1000000,
            0x730c32c180b9f083f727dd233f0736cd6a5a0ae28a6e6c49dea73bfa0bf9c6f8,
            _proof(
                0xab9631b63ff19fbac7755a1065d573f639d8d443130d6077cf2f1c7e3113f856,
                0x89c3e8f52ad7e7775b76d91a2e009bd59bb09b3c83b270fc21645a4443a2cde9
            )
        );
        _assertLeaf(
            0x5260a09a91439828d8270628cc7759cccd88e6fb8c0913079b9cb3b4ed7a8053,
            address(0xcafe),
            1,
            0,
            1000000,
            0x26c269f6eccb85afb6706039229e977df700c4e25fe066861064966295b1dfe7,
            _proof(
                0x04e78038f4a24b35844ef3fcf59c513c5437c3866b648a9e11cf2f90978bf372,
                0x2bc447d59d756cdde730e0958a2ffe4f559f7ebfb0f71c1bc6c372a3407438aa
            )
        );
        _assertLeaf(
            0x5260a09a91439828d8270628cc7759cccd88e6fb8c0913079b9cb3b4ed7a8053,
            address(0xd00d),
            2,
            1,
            400000,
            0x04e78038f4a24b35844ef3fcf59c513c5437c3866b648a9e11cf2f90978bf372,
            _proof(
                0x26c269f6eccb85afb6706039229e977df700c4e25fe066861064966295b1dfe7,
                0x2bc447d59d756cdde730e0958a2ffe4f559f7ebfb0f71c1bc6c372a3407438aa
            )
        );
        _assertLeaf(
            0x5260a09a91439828d8270628cc7759cccd88e6fb8c0913079b9cb3b4ed7a8053,
            address(0xb0c0),
            4,
            4294967295,
            0,
            0xab9631b63ff19fbac7755a1065d573f639d8d443130d6077cf2f1c7e3113f856,
            _proof(
                0x730c32c180b9f083f727dd233f0736cd6a5a0ae28a6e6c49dea73bfa0bf9c6f8,
                0x89c3e8f52ad7e7775b76d91a2e009bd59bb09b3c83b270fc21645a4443a2cde9
            )
        );
    }

    function test_payeeLeaf_threeLeafTreeOddCarry() public view {
        _assertLeaf(
            0xe963ac023d4d117e5d7256956871299fbb685e71713ea9eb912cb79f97f6a281,
            address(0xbeef),
            1,
            0,
            1000000,
            0x730c32c180b9f083f727dd233f0736cd6a5a0ae28a6e6c49dea73bfa0bf9c6f8,
            _proof(0x89c3e8f52ad7e7775b76d91a2e009bd59bb09b3c83b270fc21645a4443a2cde9)
        );
        _assertLeaf(
            0xe963ac023d4d117e5d7256956871299fbb685e71713ea9eb912cb79f97f6a281,
            address(0xcafe),
            1,
            0,
            1000000,
            0x26c269f6eccb85afb6706039229e977df700c4e25fe066861064966295b1dfe7,
            _proof(
                0x04e78038f4a24b35844ef3fcf59c513c5437c3866b648a9e11cf2f90978bf372,
                0x730c32c180b9f083f727dd233f0736cd6a5a0ae28a6e6c49dea73bfa0bf9c6f8
            )
        );
        _assertLeaf(
            0xe963ac023d4d117e5d7256956871299fbb685e71713ea9eb912cb79f97f6a281,
            address(0xd00d),
            2,
            1,
            400000,
            0x04e78038f4a24b35844ef3fcf59c513c5437c3866b648a9e11cf2f90978bf372,
            _proof(
                0x26c269f6eccb85afb6706039229e977df700c4e25fe066861064966295b1dfe7,
                0x730c32c180b9f083f727dd233f0736cd6a5a0ae28a6e6c49dea73bfa0bf9c6f8
            )
        );
    }

    function test_payeeLeaf_wrongKindFails() public view {
        assertFalse(
            this.verifyExt(
                _proof(
                    0xab9631b63ff19fbac7755a1065d573f639d8d443130d6077cf2f1c7e3113f856,
                    0x89c3e8f52ad7e7775b76d91a2e009bd59bb09b3c83b270fc21645a4443a2cde9
                ),
                0x5260a09a91439828d8270628cc7759cccd88e6fb8c0913079b9cb3b4ed7a8053,
                address(0xbeef),
                2,
                0,
                1000000
            )
        );
    }

    function test_payeeLeaf_wrongCapFails() public view {
        assertFalse(
            this.verifyExt(
                _proof(
                    0xab9631b63ff19fbac7755a1065d573f639d8d443130d6077cf2f1c7e3113f856,
                    0x89c3e8f52ad7e7775b76d91a2e009bd59bb09b3c83b270fc21645a4443a2cde9
                ),
                0x5260a09a91439828d8270628cc7759cccd88e6fb8c0913079b9cb3b4ed7a8053,
                address(0xbeef),
                1,
                0,
                1000001
            )
        );
    }

    function test_payeeLeaf_wrongStepFails() public view {
        assertFalse(
            this.verifyExt(
                _proof(
                    0xab9631b63ff19fbac7755a1065d573f639d8d443130d6077cf2f1c7e3113f856,
                    0x89c3e8f52ad7e7775b76d91a2e009bd59bb09b3c83b270fc21645a4443a2cde9
                ),
                0x5260a09a91439828d8270628cc7759cccd88e6fb8c0913079b9cb3b4ed7a8053,
                address(0xbeef),
                1,
                1,
                1000000
            )
        );
    }

    function test_payeeLeaf_wrongRootFails() public view {
        assertFalse(
            this.verifyExt(
                _proof(
                    0xab9631b63ff19fbac7755a1065d573f639d8d443130d6077cf2f1c7e3113f856,
                    0x89c3e8f52ad7e7775b76d91a2e009bd59bb09b3c83b270fc21645a4443a2cde9
                ),
                0xe963ac023d4d117e5d7256956871299fbb685e71713ea9eb912cb79f97f6a281,
                address(0xbeef),
                1,
                0,
                1000000
            )
        );
    }

    function test_payeeLeaf_singleLeafTree() public view {
        bytes32 leaf = PayeeLeaf.hash(address(0xbeef), 1, 0, 1000000);
        assertTrue(this.verifyExt(new bytes32[](0), leaf, address(0xbeef), 1, 0, 1000000));
    }

    // ─────────────── CzarNonces (PRD §9) ───────────────

    function test_nonces_derivedNonceVector() public pure {
        assertEq(
            CzarNonces.derivedNonce(VAULT, 12, 3), 0x1f7eb762975d3148f76637d5498c320aa01d5daa71be09a5e6ca4947371fd59f
        );
    }

    function testFuzz_nonces_distinctIndices(uint64 reservationId, uint32 i, uint32 j) public pure {
        vm.assume(i != j);
        assertTrue(CzarNonces.derivedNonce(VAULT, reservationId, i) != CzarNonces.derivedNonce(VAULT, reservationId, j));
    }

    function test_nonces_saltDiffersFromNonce() public pure {
        assertTrue(CzarNonces.pullbackSalt(VAULT, 12) != CzarNonces.derivedNonce(VAULT, 12, 0));
    }

    // ─────────────── PasskeyVerifier (PRD §10.4) ───────────────

    uint256 internal constant PASSKEY_PK = 0xA11CE; // test-only P-256 private key
    bytes32 internal constant RP_ID_HASH = keccak256("czar-test-rp"); // any fixed 32 bytes
    bytes1 internal constant FLAGS_UP_UV = 0x05;
    bytes1 internal constant FLAGS_UP_ONLY = 0x01;

    /// @dev External so the assertion is calldata, as PasskeyVerifier.verify requires.
    function verifyPasskeyExt(
        bytes32 digest,
        ICzarVault.WebAuthnAuth calldata a,
        bytes32 qx,
        bytes32 qy,
        bytes32 rpIdHash
    ) external view returns (bool) {
        return PasskeyVerifier.verify(digest, a, qx, qy, rpIdHash);
    }

    function _pubKey() internal pure returns (bytes32 qx, bytes32 qy) {
        (uint256 x, uint256 y) = vm.publicKeyP256(PASSKEY_PK);
        return (bytes32(x), bytes32(y));
    }

    /// @dev Builds a WebAuthn assertion over `digest` the way a browser does (czar-vault.md §7).
    function _assertion(bytes32 digest, bytes32 rpIdHash, bytes1 flags)
        internal
        pure
        returns (ICzarVault.WebAuthnAuth memory a)
    {
        bytes memory authenticatorData = abi.encodePacked(rpIdHash, flags, uint32(0)); // 37 bytes
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(digest)),
            '","origin":"http://localhost"}'
        );
        bytes32 messageHash = sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(PASSKEY_PK, messageHash);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s)); // low-s form
        a.challengeIndex = 23; // index of "challenge" in clientDataJSON
        a.typeIndex = 1; // index of "type" in clientDataJSON
        a.r = r;
        a.s = s;
        a.authenticatorData = authenticatorData;
        a.clientDataJSON = clientDataJSON;
    }

    function test_passkey_challengeIndexIs23() public pure {
        bytes memory json = bytes(_assertion(bytes32(0), RP_ID_HASH, FLAGS_UP_UV).clientDataJSON);
        assertEq(json[23], bytes1('"'));
        assertEq(json[24], bytes1("c"));
        assertEq(json[1], bytes1('"'));
        assertEq(json[2], bytes1("t"));
    }

    function test_passkey_validAssertion() public view {
        (bytes32 qx, bytes32 qy) = _pubKey();
        bytes32 digest = keccak256("digest");
        assertTrue(this.verifyPasskeyExt(digest, _assertion(digest, RP_ID_HASH, FLAGS_UP_UV), qx, qy, RP_ID_HASH));
    }

    function test_passkey_wrongRpIdHash() public view {
        (bytes32 qx, bytes32 qy) = _pubKey();
        bytes32 digest = keccak256("digest");
        ICzarVault.WebAuthnAuth memory a = _assertion(digest, keccak256("other-rp"), FLAGS_UP_UV);
        assertFalse(this.verifyPasskeyExt(digest, a, qx, qy, RP_ID_HASH));
    }

    function test_passkey_missingUV() public view {
        (bytes32 qx, bytes32 qy) = _pubKey();
        bytes32 digest = keccak256("digest");
        assertFalse(this.verifyPasskeyExt(digest, _assertion(digest, RP_ID_HASH, FLAGS_UP_ONLY), qx, qy, RP_ID_HASH));
    }

    function test_passkey_highS() public view {
        (bytes32 qx, bytes32 qy) = _pubKey();
        bytes32 digest = keccak256("digest");
        ICzarVault.WebAuthnAuth memory a = _assertion(digest, RP_ID_HASH, FLAGS_UP_UV);
        a.s = bytes32(P256_N - uint256(a.s)); // same signature, high-s form (RV-034)
        assertFalse(this.verifyPasskeyExt(digest, a, qx, qy, RP_ID_HASH));
    }

    function test_passkey_wrongDigest() public view {
        (bytes32 qx, bytes32 qy) = _pubKey();
        bytes32 digest = keccak256("digest");
        ICzarVault.WebAuthnAuth memory a = _assertion(digest, RP_ID_HASH, FLAGS_UP_UV);
        assertFalse(this.verifyPasskeyExt(keccak256("other"), a, qx, qy, RP_ID_HASH));
    }

    function test_passkey_shortAuthenticatorData() public view {
        (bytes32 qx, bytes32 qy) = _pubKey();
        bytes32 digest = keccak256("digest");
        ICzarVault.WebAuthnAuth memory a = _assertion(digest, RP_ID_HASH, FLAGS_UP_UV);
        a.authenticatorData = abi.encodePacked(RP_ID_HASH, FLAGS_UP_UV, bytes3(0)); // 36 bytes
        assertFalse(this.verifyPasskeyExt(digest, a, qx, qy, RP_ID_HASH));
    }

    function test_passkey_gas() public view {
        (bytes32 qx, bytes32 qy) = _pubKey();
        bytes32 digest = keccak256("digest");
        ICzarVault.WebAuthnAuth memory a = _assertion(digest, RP_ID_HASH, FLAGS_UP_UV);
        uint256 before = gasleft();
        bool ok = this.verifyPasskeyExt(digest, a, qx, qy, RP_ID_HASH);
        uint256 used = before - gasleft();
        assertTrue(ok);
        // 60,000 when the P-256 precompile at 0x100 answers (6,900 gas, A6-02); 300,000 when OpenZeppelin
        // falls back to its Solidity verifier (measured 259,572 on a Prague EVM without the precompile).
        assertLt(used, _precompileMissing() ? 300_000 : 60_000);
    }

    /// @dev True when the P-256 precompile at 0x100 does not verify a valid signature (it returns empty output on
    /// failure, and on chains without it the call also returns empty). OpenZeppelin then uses its Solidity verifier.
    function _precompileMissing() internal view returns (bool) {
        bytes32 h = sha256("probe");
        (bytes32 r, bytes32 s) = vm.signP256(PASSKEY_PK, h);
        (bytes32 qx, bytes32 qy) = _pubKey();
        (bool success, bytes memory ret) = address(0x100).staticcall(abi.encode(h, r, s, qx, qy));
        return !success || ret.length != 32 || uint256(bytes32(ret)) != 1;
    }
}
