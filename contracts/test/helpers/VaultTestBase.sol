// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ICzarVault} from "../../src/interfaces/ICzarVault.sol";
import {ICzarVaultFactory} from "../../src/interfaces/ICzarVaultFactory.sol";
import {CzarVault} from "../../src/CzarVault.sol";
import {USDC_ADDRESS} from "../../src/libraries/CzarConstants.sol";
import {MockArcUSDC} from "../mocks/MockArcUSDC.sol";
import {MockGatewayWallet} from "../mocks/MockGatewayWallet.sol";
import {MockGatewayMinter} from "../mocks/MockGatewayMinter.sol";
import {MockCircleAgenticCommerce} from "../mocks/MockCircleAgenticCommerce.sol";
import {MockVaultFactory} from "../mocks/MockVaultFactory.sol";

/// @title VaultTestBase
/// @notice Shared setup for every vault test (07 PRD 04): Arc chain id, a fixed time and block, the one-ledger USDC
///         mock at 0x3600…0000, the Gateway and job-escrow mocks, a MockVaultFactory and one vault.
abstract contract VaultTestBase is Test {
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;
    uint256 internal constant START_TIME = 1_792_000_000; // 00-conventions §5.4
    uint256 internal constant START_BLOCK = 68_000_000; // 00-conventions §5.4
    uint32 internal constant ARC_GATEWAY_DOMAIN = 26; // czar-vault.md §3
    uint256 internal constant ONE_USDC = 1_000_000;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal autonomy = makeAddr("autonomy");
    address internal evaluatorKey = makeAddr("evaluator");
    address internal stranger = makeAddr("stranger");
    address internal treasury = makeAddr("treasury");

    MockArcUSDC internal usdc;
    MockGatewayWallet internal gatewayWallet;
    MockGatewayMinter internal gatewayMinter;
    MockCircleAgenticCommerce internal jobEscrow;
    MockVaultFactory internal vaultFactory;
    CzarVault internal vault;

    function setUp() public virtual {
        vm.chainId(ARC_TESTNET_CHAIN_ID);
        vm.warp(START_TIME);
        vm.roll(START_BLOCK);

        deployCodeTo("MockArcUSDC.sol:MockArcUSDC", USDC_ADDRESS);
        usdc = MockArcUSDC(USDC_ADDRESS);
        gatewayWallet = new MockGatewayWallet(USDC_ADDRESS);
        gatewayMinter = new MockGatewayMinter();
        jobEscrow = new MockCircleAgenticCommerce(USDC_ADDRESS, treasury);

        vaultFactory = new MockVaultFactory(_networkConfig(), _defaults());
        vault = vaultFactory.deploy(owner);
    }

    function _networkConfig() internal view returns (ICzarVaultFactory.NetworkConfig memory) {
        return ICzarVaultFactory.NetworkConfig({
            usdc: USDC_ADDRESS,
            gatewayWallet: address(gatewayWallet),
            gatewayMinter: address(gatewayMinter),
            gatewayDomain: ARC_GATEWAY_DOMAIN,
            jobEscrow: address(jobEscrow),
            jobEscrowKind: 0
        });
    }

    function _defaults() internal view returns (ICzarVaultFactory.Defaults memory) {
        return ICzarVaultFactory.Defaults({agentSigner: agent, autonomySigner: autonomy, evaluator: evaluatorKey});
    }

    /// @dev Mints USDC to the vault (free balance).
    function _fundVault(uint256 amount) internal {
        usdc.mint(address(vault), amount);
    }
}
