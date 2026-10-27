// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Czar constants
// File-level constants shared by the vault, its modules and tests (czar-vault.md §3; 02 §5.3, §6, §7).
// Every hash literal is checked against docs/specs/02-data-and-protocol/vectors/eip712-vectors.json by test/unit/Libraries.t.sol.

// ── Addresses (testnet and mainnet share USDC; the rest are vault immutables, PRD 04) ──
address constant USDC_ADDRESS = 0x3600000000000000000000000000000000000000; // A1-01

// ── EIP-712 type hashes (02 §6.2; vectors.typeHashes) ──
bytes32 constant EIP712_DOMAIN_FULL_TYPEHASH = 0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f; // EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
bytes32 constant EIP712_DOMAIN_NO_CONTRACT_TYPEHASH =
    0xc2f8787176b8ac6bf7215b4adcc1e069bf4ab82d9ab1df05a57a91d425935b6e; // EIP712Domain(string name,string version,uint256 chainId)
bytes32 constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
    0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;
bytes32 constant TRANSFER_SPEC_TYPEHASH = 0x44409c7ba8872720f5fc290d2788c2d70a3905b7ca1cdb2ffa152791a69e089b;
bytes32 constant BURN_INTENT_TYPEHASH = 0x8b99d17a83a2dd1add9fc2a450e22732c7e8564aa110ab99c20485a7a10ba37c;
bytes32 constant RECEIPT_TYPEHASH = 0xcd6ca6db33168140e9fc8604767fd5dc89fc51ca3853b876f9003e8bedd295f2;
bytes32 constant RECEIPT_ATTESTATION_TYPEHASH = 0x01b75f6051eb731488fad2e8de7925f8a64c89ef33c418e2a62e77ae02691eff;
bytes32 constant AUTONOMY_RAISE_TYPEHASH = 0x6247988191abc5977b0b6f569e66d23eff38cc0f0fe30f8ed678b03c3f21b368;
bytes32 constant OWNER_ACTION_TYPEHASH = 0x5a8b2f7d5d70ba2335e2ee47a9d897748d8694bdb44c148ad01f541eeb2f0248;

// ── Domain separators that do not depend on chain or contract (02 §6.1) ──
bytes32 constant GATEWAY_DOMAIN_SEPARATOR = 0x23a37920eca61226c76d13c4462857a362147e4b18da665dba894fa297ae4f34; // name "GatewayWallet", version "1", no chainId, no contract

// ── Name / version hashes used to compute the other domain separators at construction (PRD 04) ──
bytes32 constant USDC_NAME_HASH = keccak256("USDC");
bytes32 constant USDC_VERSION_HASH = keccak256("2");
bytes32 constant VAULT_NAME_HASH = keccak256("CzarVault");
bytes32 constant SL_NAME_HASH = keccak256("SelectionLayer");
bytes32 constant VERSION_1_HASH = keccak256("1");

// ── Signature kind tags (02 §6.3; vectors.vectors.kindTags) ──
bytes32 constant KIND_USDC_3009 = 0x86b499474d9c0ea9b4a99b5ce22c4ae0f1ef4bf774214e3c1e4095c0371888cb; // keccak256("czar.vault.sig.USDC_3009.v1")
bytes32 constant KIND_GATEWAY_BURN = 0xf453aa3365355a8cf99e674b4443d5009b132245c53a3eb3b5a14953d97265f2; // keccak256("czar.vault.sig.GATEWAY_BURN.v1")
bytes32 constant KIND_SL_RECEIPT = 0x01c314900cb74ef1a689e81bddd748cc950a7aceb730d7cb9b7660a5aa6a3eaa; // keccak256("czar.vault.sig.SL_RECEIPT.v2")

// ── Tags (02 §5.3, §7.2) ──
bytes32 constant PAYEE_LEAF_TAG = 0xabf82537a2dce15f109dca3554542a6a546f104bd1343c99de6c06fdd41462fe; // keccak256("czar.payee-leaf.v1")
bytes32 constant NONCE_TAG = 0x28f8dafc03e5ff5b4b3e5b50613f61c133f15f5a15b023ddecb25e6e9034577d; // keccak256("czar.vault.nonce.v1")

// ── Gateway TransferSpec byte encoding (czar-vault.md §3, §5.4) ──
bytes4 constant TRANSFER_SPEC_MAGIC = 0xca85def7;
uint32 constant TRANSFER_SPEC_VERSION = 1;

// ── ERC-1271 (A1-09) ──
bytes4 constant EIP1271_MAGIC = 0x1626ba7e;
bytes4 constant EIP1271_INVALID = 0xffffffff;

// ── secp256k1 low-s bound ──
uint256 constant SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

// ── Limits (czar-vault.md §3) ──
uint256 constant MAX_AUTHORIZATIONS_PER_RESERVATION = 128;
uint256 constant MAX_DIGEST_MODE_COUNT = 8;
uint256 constant MIN_RESERVATION_TTL = 30; // seconds
uint256 constant MAX_RESERVATION_TTL = 600; // seconds
uint256 constant FINALIZE_CHUNK = 32;
uint256 constant MAX_ENVELOPE_DURATION = 30 days;
uint16 constant DEFAULT_POCKET_CAP_BPS = 2500;
uint16 constant MAX_POCKET_CAP_BPS = 5000; // owner-opened envelopes
uint16 constant MAX_AGENT_POCKET_CAP_BPS = 2500; // agent-opened envelopes (D71)
uint8 constant PAYEE_KIND_X402 = 1;
uint8 constant PAYEE_KIND_JOB = 2;
uint8 constant PAYEE_KIND_TIP = 3; // Phase 2; never accepted by Phase 1 functions
uint8 constant PAYEE_KIND_POCKET = 4;
uint32 constant POCKET_STEP_INDEX = type(uint32).max;
uint256 constant DEFAULT_MAX_PULLBACK_FEE = 10_000; // 0.01 USDC (D81)
uint256 constant MAX_PULLBACK_FEE_CEILING = 500_000; // 0.50 USDC (D81)
uint256 constant MAX_PULLBACK_WINDOW_BLOCKS = 7_200;
uint256 constant PULLBACK_CANCEL_DELAY_BLOCKS = 3_000;
uint256 constant GAS_GRANT_UNIT_WEI = 1e12; // one 6-decimal unit in 18-decimal wei
uint256 constant MAX_GAS_GRANT_PER_POCKET = 50_000; // units (0.05 USDC)
uint256 constant PERIOD_LENGTH = 604_800; // 7 days, seconds
uint256 constant MAX_RAISE_STEP_BPS = 2_000;
uint256 constant BPS = 10_000;
uint256 constant MAX_JOB_FEE_BPS = 500;
uint256 constant MIN_JOB_EXPIRY_LEAD = 6 minutes;
uint256 constant FORCE_CLOSE_DELAY = 1 days; // forceCloseEnvelope after expiresAt + 1 day (czar-vault.md §5.2)

// ── Job escrow (job-escrow-adapter.md §3; czar-vault.md §5.5) ──
bytes32 constant CANCEL_REASON = 0x4be893f3f036dcd68d7b6cb119f5dd94b5db100d08a34bd429ab72d9a6ad1a90; // keccak256("czar:cancel")
string constant DESCRIPTION_PREFIX = "czar:"; // job description = prefix + 64 lowercase hex chars (JOB-3)
uint256 constant CZAR_ESCROW_EVALUATION_GRACE = 1 hours; // Czar-instance claimRefund on Submitted (ERC8183.sol line 78)

// ── Passkey (czar-vault.md §7) ──
bool constant REQUIRE_UV = true; // user verification flag must be set
