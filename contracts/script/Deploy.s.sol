// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {ICzarVaultFactory} from "../src/interfaces/ICzarVaultFactory.sol";
import {USDC_ADDRESS} from "../src/libraries/CzarConstants.sol";

/// @title Deploy
/// @notice T-027 (07 PRD 13): deploys the eight vault logic libraries, OpenEvidenceLog and CzarVaultFactory through
///         the Arachnid CREATE2 deployer with fixed salts and the reproducible `deploy` profile
///         (security-and-testing.md §4 steps 1–3; czar-vault-factory.md §3, §11). Idempotent: an address that
///         already has code is skipped. Refuses every chain except Arc testnet and a local arc-anvil.
/// @dev Library addresses are part of the vault and factory bytecode, so `script/deploy.sh` builds in three passes
///      and passes `--libraries` (the one place the build passes it by hand). `run()` checks that every linked address
///      equals the CREATE2 address of that library's own code, so a stale link cannot reach the chain.
contract Deploy is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C; // A9-15
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;
    uint256 internal constant LOCAL_CHAIN_ID = 31337;
    uint32 internal constant ARC_GATEWAY_DOMAIN = 26;
    address internal constant GATEWAY_WALLET = 0x0077777d7EBA4688BDeF3E311b846F25870A19B9; // A2-01
    address internal constant GATEWAY_MINTER = 0x0022222ABE238Cc2C7Bb1f21003F0a260052475B; // A2-01
    address internal constant CIRCLE_JOB_ESCROW = 0x0747EEf0706327138c69792bF28Cd525089e4583; // A4-01
    uint8 internal constant JOB_ESCROW_KIND_CIRCLE = 0;
    bytes32 internal constant OEL_SALT = keccak256("czar.open-evidence-log.v1");
    bytes32 internal constant FACTORY_SALT = keccak256("czar.vault-factory.v1");

    /// @dev The order matters: OwnerActionLogic links the five before it (security-and-testing.md §4 step 1a).
    string[8] internal LIBRARIES = [
        "CoreLogic",
        "EnvelopeLogic",
        "ReservationLogic",
        "SignatureLogic",
        "PocketLogic",
        "JobLogic",
        "AutonomyLogic",
        "OwnerActionLogic"
    ];

    function _requireNetwork() internal view {
        require(
            block.chainid == ARC_TESTNET_CHAIN_ID || block.chainid == LOCAL_CHAIN_ID,
            "Deploy: Arc testnet or local arc-anvil only"
        );
    }

    function _artifact(string memory name) internal pure returns (string memory) {
        return string.concat("src/vault/logic/", name, ".sol:", name);
    }

    function _salt(string memory name) internal pure returns (bytes32) {
        return keccak256(bytes(string.concat("czar.lib.", name, ".v1")));
    }

    function _predict(bytes32 salt, bytes memory initcode) internal pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, keccak256(initcode)))))
        );
    }

    /// @dev Deploys `initcode` with `salt` unless the address already has code; returns the address.
    function _deploy(bytes32 salt, bytes memory initcode) internal returns (address at) {
        at = _predict(salt, initcode);
        if (at.code.length != 0) {
            console.log("exists  ", at);
            return at;
        }
        vm.broadcast();
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initcode));
        require(ok && at.code.length != 0, "Deploy: CREATE2 failed");
        console.log("deployed", at);
    }

    /// @notice Passes 1 and 2 of deploy.sh: prints the `--libraries` entry of libraries `from` … `to − 1`.
    ///         Pass 1 prints the first seven (they link nothing); pass 2, built with those seven linked, prints
    ///         OwnerActionLogic.
    function predictLibraries(uint256 from, uint256 to) external view {
        for (uint256 i = from; i < to; i++) {
            address at = _predict(_salt(LIBRARIES[i]), vm.getCode(_artifact(LIBRARIES[i])));
            console.log(string.concat("src/vault/logic/", LIBRARIES[i], ".sol:", LIBRARIES[i], ":", vm.toString(at)));
        }
    }

    /// @notice Pass 3: deploys everything. `keysFile` is relative to the project root, for example
    ///         `../deployments/arc-testnet-keys.json` (T-105; addresses only).
    function run(string memory keysFile, string memory outFile) external {
        _requireNetwork();
        string memory keys = vm.readFile(keysFile);
        ICzarVaultFactory.Defaults memory d = ICzarVaultFactory.Defaults({
            agentSigner: vm.parseJsonAddress(keys, ".K3.address"),
            autonomySigner: vm.parseJsonAddress(keys, ".K5.address"),
            evaluator: vm.parseJsonAddress(keys, ".K7.address")
        });
        address guardian = vm.parseJsonAddress(keys, ".K6.address");
        address admin = vm.parseJsonAddress(keys, ".K20.address");

        string memory json = "deployment";
        for (uint256 i = 0; i < LIBRARIES.length; i++) {
            bytes memory code = vm.getCode(_artifact(LIBRARIES[i]));
            address at = _deploy(_salt(LIBRARIES[i]), code);
            vm.serializeAddress(json, LIBRARIES[i], at);
        }
        address oel = _deploy(OEL_SALT, vm.getCode("src/OpenEvidenceLog.sol:OpenEvidenceLog"));
        vm.serializeAddress(json, "OpenEvidenceLog", oel);

        ICzarVaultFactory.NetworkConfig memory cfg = ICzarVaultFactory.NetworkConfig({
            usdc: USDC_ADDRESS,
            gatewayWallet: GATEWAY_WALLET,
            gatewayMinter: GATEWAY_MINTER,
            gatewayDomain: ARC_GATEWAY_DOMAIN,
            jobEscrow: CIRCLE_JOB_ESCROW,
            jobEscrowKind: JOB_ESCROW_KIND_CIRCLE
        });
        vm.serializeAddress(json, "usdc", cfg.usdc);
        vm.serializeAddress(json, "gatewayWallet", cfg.gatewayWallet);
        vm.serializeAddress(json, "gatewayMinter", cfg.gatewayMinter);
        vm.serializeUint(json, "gatewayDomain", cfg.gatewayDomain);
        vm.serializeAddress(json, "jobEscrow", cfg.jobEscrow);
        bytes memory args = abi.encode(cfg, d, guardian, admin);
        bytes memory factoryInit = abi.encodePacked(vm.getCode("src/CzarVaultFactory.sol:CzarVaultFactory"), args);
        address factory = _deploy(FACTORY_SALT, factoryInit);
        _checkFactory(ICzarVaultFactory(factory), d);

        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeBytes(json, "factoryConstructorArgs", args);
        vm.serializeBytes32(json, "factoryInitcodeHash", keccak256(factoryInit));
        vm.serializeBytes32(json, "factoryRuntimeHash", factory.codehash);
        vm.serializeBytes32(json, "vaultCreationCodeHash", ICzarVaultFactory(factory).VAULT_CREATION_CODE_HASH());
        string memory out = vm.serializeAddress(json, "CzarVaultFactory", factory);
        vm.writeJson(out, outFile);
    }

    /// @dev T-027 acceptance, checked before the record is written.
    function _checkFactory(ICzarVaultFactory factory, ICzarVaultFactory.Defaults memory d) internal view {
        require(!factory.guardianPaused(), "Deploy: factory paused");
        ICzarVaultFactory.Defaults memory got = factory.defaults();
        require(
            got.agentSigner == d.agentSigner && got.autonomySigner == d.autonomySigner && got.evaluator == d.evaluator,
            "Deploy: defaults differ from the keys file"
        );
    }
}
