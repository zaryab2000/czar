// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICzarVault} from "../src/interfaces/ICzarVault.sol";
import {ICzarVaultFactory} from "../src/interfaces/ICzarVaultFactory.sol";
import {CzarHashing} from "../src/libraries/CzarHashing.sol";
import {GATEWAY_DOMAIN_SEPARATOR, PERIOD_LENGTH} from "../src/libraries/CzarConstants.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";
import {CzarVaultHarness} from "./helpers/CzarVaultHarness.sol";

/// @dev 07 PRD 12 (T-023; RV-061, RV-013, INV-11). Reproduces the 02 §6.4 vectors on-chain from
///      docs/specs/02-data-and-protocol/vectors/eip712-vectors.json, with a CzarVaultHarness placed at the vectors'
///      example vault address 0x…0c2a21 on chain 5042002 and the real Arc Gateway addresses in its network config.
///      `briefRequest` and `deliverableUpload` are off-chain and excluded (D88, G-54).
contract VectorsTest is VaultTestBase {
    string internal constant VECTORS_PATH = "../docs/specs/02-data-and-protocol/vectors/eip712-vectors.json";
    address internal constant VECTOR_VAULT = address(0xc2a21);
    address internal constant ARC_GATEWAY_WALLET = 0x0077777d7EBA4688BDeF3E311b846F25870A19B9;
    address internal constant ARC_GATEWAY_MINTER = 0x0022222ABE238Cc2C7Bb1f21003F0a260052475B;

    uint256 internal autonomyPk = uint256(keccak256(abi.encodePacked("autonomy")));
    string internal json;
    CzarVaultHarness internal h;

    function setUp() public override {
        super.setUp();
        json = vm.readFile(VECTORS_PATH);
        ICzarVaultFactory.NetworkConfig memory cfg = _networkConfig();
        cfg.gatewayWallet = ARC_GATEWAY_WALLET;
        cfg.gatewayMinter = ARC_GATEWAY_MINTER;
        vaultFactory.setNetworkConfig(cfg);
        bytes memory initcode = abi.encodePacked(type(CzarVaultHarness).creationCode, abi.encode(owner));
        h = CzarVaultHarness(payable(vaultFactory.deployCodeAt(VECTOR_VAULT, initcode)));
    }

    function _b32(string memory key) internal view returns (bytes32) {
        return vm.parseJsonBytes32(json, key);
    }

    function _uint(string memory key) internal view returns (uint256) {
        return vm.parseJsonUint(json, key);
    }

    function _addr(string memory key) internal view returns (address) {
        return vm.parseJsonAddress(json, key);
    }

    /// @dev RV-061 named test: the seven 02 §6.4 entries reproduce from the vault's own domains and code paths.
    function test_vectors_reproducedOnChain() public {
        // Domains.
        assertEq(h.exposed_usdcDomainSeparator(), _b32(".domains.USDC_5042002"), "USDC domain");
        assertEq(h.exposed_slDomainSeparator(), _b32(".domains.SelectionLayer_5042002"), "SL domain");
        assertEq(h.exposed_vaultDomainSeparator(), _b32(".domains.CzarVault_5042002_exampleVault"), "vault domain");
        assertEq(GATEWAY_DOMAIN_SEPARATOR, _b32(".domains.GatewayWallet_nameVersionOnly"), "Gateway domain");

        // 1. Derived nonce, through the vault's own derivedNonce.
        uint64 rid = uint64(_uint(".vectors.derivedNonce_example.reservationId"));
        uint32 index = uint32(_uint(".vectors.derivedNonce_example.index"));
        assertEq(h.derivedNonce(rid, index), _b32(".vectors.derivedNonce_example.nonce"), "derivedNonce");

        // 2. USDC TransferWithAuthorization digest under the vault's USDC domain.
        string memory u = ".vectors.usdcTransferWithAuthorization_5042002.message";
        bytes32 usdcStruct = CzarHashing.transferWithAuthorizationHash(
            _addr(string.concat(u, ".from")),
            _addr(string.concat(u, ".to")),
            _uint(string.concat(u, ".value")),
            _uint(string.concat(u, ".validAfter")),
            _uint(string.concat(u, ".validBefore")),
            _b32(string.concat(u, ".nonce"))
        );
        assertEq(
            CzarHashing.typedDataHash(h.exposed_usdcDomainSeparator(), usdcStruct),
            _b32(".vectors.usdcTransferWithAuthorization_5042002.digest"),
            "USDC digest"
        );

        // 3. Gateway burn intent and transfer-spec hash, built by the vault from a pullback record (salt 0x22…22).
        string memory g = ".vectors.gatewayBurnIntent_sameChain.message";
        (bytes32 burnDigest, bytes32 replayHash) = h.exposed_pullbackDigests(
            address(uint160(uint256(_b32(string.concat(g, ".spec.sourceDepositor"))))),
            _uint(string.concat(g, ".spec.value")),
            _b32(string.concat(g, ".spec.salt")),
            _uint(string.concat(g, ".maxFee")),
            _uint(string.concat(g, ".maxBlockHeight"))
        );
        assertEq(burnDigest, _b32(".vectors.gatewayBurnIntent_sameChain.digest"), "burn digest");
        assertEq(replayHash, _b32(".vectors.gatewayBurnIntent_sameChain.transferSpecHash"), "transferSpecHash");

        // 4. SL Receipt struct hash and digest; 5. the vault-bound ReceiptAttestation (RV-013).
        bytes32 receiptStruct = CzarHashing.receiptStructHash(_receipt());
        assertEq(receiptStruct, _b32(".vectors.slReceipt_5042002.structHash"), "Receipt struct hash");
        assertEq(
            CzarHashing.typedDataHash(h.exposed_slDomainSeparator(), receiptStruct),
            _b32(".vectors.slReceipt_5042002.digest"),
            "Receipt digest"
        );
        assertEq(_addr(".vectors.receiptAttestation_5042002.vault"), address(h));
        assertEq(
            CzarHashing.typedDataHash(
                h.exposed_vaultDomainSeparator(), CzarHashing.receiptAttestationStructHash(receiptStruct)
            ),
            _b32(".vectors.receiptAttestation_5042002.digest"),
            "ReceiptAttestation digest"
        );

        // 6. AutonomyRaise: the digest, then the vault accepts a signature over it at its deadline.
        assertEq(_autonomyDigest(), _b32(".vectors.autonomyRaise_5042002.digest"), "AutonomyRaise digest");
        _raiseAtVectorDeadline();

        // 7. OwnerAction digest under the vault's domain.
        string memory o = ".vectors.ownerAction_5042002.message";
        bytes32 ownerStruct = CzarHashing.ownerActionStructHash(
            uint8(_uint(string.concat(o, ".action"))),
            _b32(string.concat(o, ".payloadHash")),
            _uint(string.concat(o, ".nonce")),
            _uint(string.concat(o, ".deadline"))
        );
        assertEq(
            CzarHashing.typedDataHash(h.exposed_vaultDomainSeparator(), ownerStruct),
            _b32(".vectors.ownerAction_5042002.digest"),
            "OwnerAction digest"
        );
    }

    function _receipt() internal view returns (ICzarVault.SlReceipt memory r) {
        string memory m = ".vectors.slReceipt_5042002.message";
        r.paymentRefHash = _b32(string.concat(m, ".paymentRefHash"));
        r.requestCommit = _b32(string.concat(m, ".requestCommit"));
        r.responseCommit = _b32(string.concat(m, ".responseCommit"));
        r.statusCode = uint16(_uint(string.concat(m, ".statusCode")));
        r.originAsserted = vm.parseJsonString(json, string.concat(m, ".originAsserted"));
        r.requirementsHashSeen = _b32(string.concat(m, ".requirementsHashSeen"));
        r.tRequest = uint64(_uint(string.concat(m, ".tRequest")));
        r.tPaymentSigned = uint64(_uint(string.concat(m, ".tPaymentSigned")));
        r.tComplete = uint64(_uint(string.concat(m, ".tComplete")));
        r.outcome = uint8(_uint(string.concat(m, ".outcome")));
        r.localChecksCommit = _b32(string.concat(m, ".localChecksCommit"));
        r.disclosure = uint8(_uint(string.concat(m, ".disclosure")));
        r.createdAt = uint64(_uint(string.concat(m, ".createdAt")));
    }

    function _autonomyDigest() internal view returns (bytes32) {
        string memory a = ".vectors.autonomyRaise_5042002.message";
        return CzarHashing.typedDataHash(
            h.exposed_vaultDomainSeparator(),
            CzarHashing.autonomyRaiseStructHash(
                _b32(string.concat(a, ".category")),
                _uint(string.concat(a, ".newLimit")),
                uint64(_uint(string.concat(a, ".periodId"))),
                _uint(string.concat(a, ".nonce")),
                _uint(string.concat(a, ".deadline"))
            )
        );
    }

    /// @dev RV-061: the vector's deadline lies inside its periodId, so raiseAutoLimit succeeds at that time once the
    ///      vault's autonomyNonce has reached the vector's nonce. The autonomy key signs the vector digest itself.
    function _raiseAtVectorDeadline() internal {
        string memory a = ".vectors.autonomyRaise_5042002.message";
        bytes32 category = _b32(string.concat(a, ".category"));
        uint256 newLimit = _uint(string.concat(a, ".newLimit"));
        uint64 periodId = uint64(_uint(string.concat(a, ".periodId")));
        uint256 nonce = _uint(string.concat(a, ".nonce"));
        uint256 deadline = _uint(string.concat(a, ".deadline"));
        assertEq(deadline / PERIOD_LENGTH, periodId, "deadline inside periodId");
        vm.prank(owner);
        h.setCategoryLimits(category, 5 * newLimit, 0); // a raise of newLimit is 20% of userMax: the largest step
        while (h.autonomyNonce() < nonce) {
            vm.prank(owner);
            h.lowerAutoLimit(category, 0); // each lowering bumps autonomyNonce (RV-030)
        }
        assertEq(h.autonomyNonce(), nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(autonomyPk, _b32(".vectors.autonomyRaise_5042002.digest"));
        vm.warp(deadline);
        vm.prank(stranger); // any relayer
        h.raiseAutoLimit(category, newLimit, periodId, deadline, abi.encodePacked(r, s, v));
        assertEq(h.getLimits(category).autoLimit, newLimit);
    }
}
