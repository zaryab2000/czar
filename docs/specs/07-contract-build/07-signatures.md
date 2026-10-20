# 07 — Signatures (`isValidSignature`)

## 1. Scope
- **Task:** T-016 (`isValidSignature`: the `USDC_3009` kind, the 65-byte fallback, `SL_RECEIPT`; the exposure-bound tests).
- **You build:**
  - `contracts/src/vault/logic/SignatureLogic.sol`: a linked library with one external `view` function and its private checks (§7). Its `GATEWAY_BURN` branch is a placeholder that returns `false`; PRD 08 replaces it.
  - `contracts/src/CzarVault.sol`: replaced with the version in §6 (adds the `isValidSignature` wrapper).
  - `contracts/test/SignatureTest.t.sol` (§8).
  - You delete 1 stub from `VaultStubs.sol`.
- **Dependencies:** PRD 06 done (204 tests, `ReserveTest` 33 passed, 17 stubs).

## 2. This PRD is already verified
- A reference `SignatureLogic` written from §7 passed on **Arc Foundry v0.8.0-2** with `FOUNDRY_PROFILE=arc`: clean `--deny-warnings` build (compiler and lint), `fmt --check` clean, 242 tests passed (204 earlier plus 38 here).
- A mutation check was run: with the range checks of §7.3 step 3 removed, `test_usdc3009_outOfRangeHeadWords_invalidNotRevert` and the `USDC_3009` corrupted-byte fuzz test fail with a revert; with them in place all pass.
- Sizes after this PRD: `CzarVault` runtime 11,923 B, initcode 13,616 B; `CzarVaultFactory` runtime 18,130 B; `SignatureLogic` runtime 5,056 B.

## 3. Sources (read these, nothing else)
- `07-contract-build/01-shared-libraries.md` (the `CzarHashing`, `PayeeLeaf`, `CzarNonces` functions the steps call) and `07-contract-build/03-factory-and-vault-skeleton.md` §7 (`VaultState`, `VaultGuards`).
- `07-contract-build/00-conventions.md` (§3.2 library rules, §4.11 traps, §5 tests).
- `docs/specs/03-smart-contracts/czar-vault.md`: §6 (dispatcher and the layout table), §6.1 (`USDC_3009` steps 1–7), §6.3 (`SL_RECEIPT`, RV-013), §6.4 (fallback), §6.5 (exposure bound), §15.2, §15 (D88: never reverts; range checks on narrow head words).
- `docs/specs/02-data-and-protocol/data-and-protocol.md` §6.3 (signature encodings), §6.4 (vectors), §7.2 (derived nonce).
- `docs/specs/03-smart-contracts/interfaces/ICzarVault.sol` (`SlReceipt`).
- `docs/specs/03-smart-contracts/security-and-testing.md` §3.7 rows RV-013, RV-035.

## 4. Files
| File | Action | Section |
|---|---|---|
| `contracts/test/SignatureTest.t.sol` | create | §8 |
| `contracts/src/vault/logic/SignatureLogic.sol` | create | §7 |
| `contracts/src/vault/VaultStubs.sol` | delete 1 stub | §5 |
| `contracts/src/CzarVault.sol` | replace | §6 |

## 5. Delete the stub
- In `VaultStubs.sol`, delete the whole stub of `isValidSignature`. Afterwards `grep -c "revert NotBuilt" src/vault/VaultStubs.sol` prints `16`.

## 6. `src/CzarVault.sol` (replace the whole file)
- Adds `isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4)`, which returns `SignatureLogic.isValidSignature(_s, _config(), digest, signature)`. A `view` function may call an external library `view` function (the compiler uses `DELEGATECALL`, which keeps the static context).
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICzarVault} from "./interfaces/ICzarVault.sol";
import {VaultBase} from "./vault/VaultBase.sol";
import {VaultStubs} from "./vault/VaultStubs.sol";
import {CoreLogic} from "./vault/logic/CoreLogic.sol";
import {EnvelopeLogic} from "./vault/logic/EnvelopeLogic.sol";
import {ReservationLogic} from "./vault/logic/ReservationLogic.sol";
import {SignatureLogic} from "./vault/logic/SignatureLogic.sol";

/// @title CzarVault
/// @notice The per-user vault (czar-vault.md). Immutable; no proxy (D33). Every state-changing function is a thin
///         wrapper: the reentrancy guard (§15.5) stays here, the logic runs in a linked library by DELEGATECALL on
///         this vault's storage (07 PRD 03). `msg.sender` is passed as `caller`, so the passkey path can pass the owner.
contract CzarVault is VaultBase, VaultStubs {
    /// @dev czar-vault.md §15.8. Called by CzarVaultFactory.createVault through CREATE2.
    constructor(address ownerAccount) VaultBase(ownerAccount) {}

    // ───────────── Balance and owner settings (§5.1) ─────────────

    /// @dev Native USDC arrives as free balance (A1-05). Not in ICzarVault.
    receive() external payable {
        emit NativeReceived(msg.sender, msg.value);
    }

    /// @inheritdoc ICzarVault
    function sync() external nonReentrant {
        emit BalanceSynced(IERC20(USDC).balanceOf(address(this)), _s.committedTotal);
    }

    /// @inheritdoc ICzarVault
    function withdraw(address to, uint256 amount) external nonReentrant {
        CoreLogic.withdraw(_s, _config(), msg.sender, to, amount);
    }

    /// @inheritdoc ICzarVault
    function setCategoryLimits(bytes32 categoryId, uint256 userMax, uint256 autoLimit) external {
        CoreLogic.setCategoryLimits(_s, _config(), msg.sender, categoryId, userMax, autoLimit);
    }

    /// @inheritdoc ICzarVault
    function freeze() external {
        CoreLogic.freeze(_s, _config(), msg.sender);
    }

    /// @inheritdoc ICzarVault
    function unfreeze() external {
        CoreLogic.unfreeze(_s, _config(), msg.sender);
    }

    /// @inheritdoc ICzarVault
    function rotateSigners(address agent, address autonomy, address evaluator_) external {
        CoreLogic.rotateSigners(_s, _config(), msg.sender, agent, autonomy, evaluator_);
    }

    /// @inheritdoc ICzarVault
    function setPasskey(bytes32 qx, bytes32 qy, bytes32 rpIdHash) external {
        CoreLogic.setPasskey(_s, _config(), msg.sender, qx, qy, rpIdHash);
    }

    /// @inheritdoc ICzarVault
    function setMaxPullbackFee(uint256 newMax) external {
        CoreLogic.setMaxPullbackFee(_s, _config(), msg.sender, newMax);
    }

    // ───────────── Envelopes (§5.2) ─────────────

    /// @inheritdoc ICzarVault
    function openEnvelope(OpenEnvelopeParams calldata p) external nonReentrant returns (uint64) {
        return EnvelopeLogic.openEnvelope(_s, _config(), msg.sender, p);
    }

    /// @inheritdoc ICzarVault
    function closeEnvelope(uint64 envelopeId) external {
        EnvelopeLogic.closeEnvelope(_s, _config(), msg.sender, envelopeId);
    }

    /// @inheritdoc ICzarVault
    function forceCloseEnvelope(uint64 envelopeId) external {
        EnvelopeLogic.forceCloseEnvelope(_s, _config(), msg.sender, envelopeId);
    }

    // ───────────── Reservations (§5.3) ─────────────

    /// @inheritdoc ICzarVault
    function reserve(
        uint64 envelopeId,
        uint32 stepIndex,
        address payee,
        uint256 stepCap,
        bytes32[] calldata proof,
        uint256 unitAmount,
        uint32 count,
        uint64 validBefore
    ) external returns (uint64) {
        ReservationLogic.ReserveRequest memory q = ReservationLogic.ReserveRequest(
            envelopeId, stepIndex, payee, stepCap, unitAmount, count, validBefore, ReservationMode.Envelope
        );
        return ReservationLogic.reserve(_s, _config(), msg.sender, q, proof);
    }

    /// @inheritdoc ICzarVault
    function reserveWithDigests(
        uint64 envelopeId,
        uint32 stepIndex,
        address payee,
        uint256 stepCap,
        bytes32[] calldata proof,
        uint256 unitAmount,
        uint32 count,
        uint64 validBefore
    ) external returns (uint64) {
        ReservationLogic.ReserveRequest memory q = ReservationLogic.ReserveRequest(
            envelopeId, stepIndex, payee, stepCap, unitAmount, count, validBefore, ReservationMode.Digest
        );
        return ReservationLogic.reserve(_s, _config(), msg.sender, q, proof);
    }

    /// @inheritdoc ICzarVault
    function settle(uint64 reservationId, uint32[] calldata indices) external nonReentrant {
        ReservationLogic.settle(_s, _config(), reservationId, indices);
    }

    /// @inheritdoc ICzarVault
    function finalize(uint64 reservationId, uint32 fromIndex, uint32 toIndex) external nonReentrant {
        ReservationLogic.finalize(_s, _config(), reservationId, fromIndex, toIndex);
    }

    // ───────────── ERC-1271 (§6) ─────────────

    /// @inheritdoc ICzarVault
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        return SignatureLogic.isValidSignature(_s, _config(), digest, signature);
    }
}
```

## 7. `src/vault/logic/SignatureLogic.sol`

### 7.1 Header and constants
- `// SPDX-License-Identifier: MIT`, `pragma solidity 0.8.30;`
- Imports, exactly:
  - `{ICzarVault}` from `../../interfaces/ICzarVault.sol`
  - `{ICzarVaultFactory}` from `../../interfaces/ICzarVaultFactory.sol`
  - `{VaultState, VaultConfig, DigestSlot}` from `../VaultState.sol`
  - `{VaultGuards}` from `../VaultGuards.sol`
  - `{CzarHashing}` from `../../libraries/CzarHashing.sol`
  - `{KIND_USDC_3009, KIND_GATEWAY_BURN, KIND_SL_RECEIPT, EIP1271_MAGIC, EIP1271_INVALID}` from `../../libraries/CzarConstants.sol` (PRD 08 adds `GATEWAY_DOMAIN_SEPARATOR` to this list)
- `/// @title SignatureLogic`, a `/// @notice` citing `czar-vault.md` §6 and T-016, and saying it never reverts. `library SignatureLogic { … }`.
- First in the library, the layout constants of the `czar-vault.md` §6 table, exactly:
```solidity
    uint256 internal constant USDC_3009_LENGTH = 416;
    uint256 internal constant USDC_3009_SIG_OFFSET = 0x120;
    uint256 internal constant GATEWAY_BURN_LENGTH = 224;
    uint256 internal constant GATEWAY_BURN_SIG_OFFSET = 0x60;
    uint256 internal constant AGENT_SIG_LENGTH = 65;
    uint256 internal constant SL_MIN_LENGTH = 672;
    uint256 internal constant SL_TUPLE_OFFSET = 0x60;
    uint256 internal constant SL_STRING_OFFSET = 0x1a0;
    uint256 internal constant SL_SIG_OFFSET_BASE = 0x220; // 0x60 + 0x1c0
    uint256 internal constant SL_STRING_LENGTH_POS = 0x200; // 0x60 + 0x1a0
```

### 7.2 `isValidSignature(VaultState storage s, VaultConfig memory c, bytes32 digest, bytes calldata signature) external view returns (bytes4)`
1. `bool ok;`
2. If `signature.length == AGENT_SIG_LENGTH`: `ok = _checkFallback(s, c, digest, signature);`
3. Else if `signature.length >= 32`: `bytes32 kind = bytes32(signature[0:32]);` then
   - `kind == KIND_USDC_3009` → `ok = _checkUsdc3009(s, c, digest, signature);`
   - `kind == KIND_GATEWAY_BURN` → `ok = _checkGatewayBurn(s, c, digest, signature);`
   - `kind == KIND_SL_RECEIPT` → `ok = _checkSlReceipt(s, c, digest, signature);`
   - any other kind (including the retired v1 `SL_RECEIPT` tag) leaves `ok` false.
4. `return ok ? EIP1271_MAGIC : EIP1271_INVALID;`

### 7.3 `USDC_3009` (§6.1)
- The decoded fields, as a struct in the library (a function with `s`, `c` and nine decoded values is "stack too deep"), exactly:
```solidity
    struct Usdc3009Sig {
        uint64 reservationId;
        uint32 index;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        bytes agentSig;
    }
```
- **`_checkUsdc3009(s, c, bytes32 digest, bytes calldata sig) private view returns (bool)`**, in this order; any failed line returns `false`:
  1. `sig.length == USDC_3009_LENGTH`
  2. `_word(sig, 8) == USDC_3009_SIG_OFFSET` and `_word(sig, 9) == AGENT_SIG_LENGTH`
  3. Range checks on the narrow head words, so the decode below can never revert (D88): `_word(sig, 1) <= type(uint64).max`, `_word(sig, 2) <= type(uint32).max`, `_word(sig, 3) <= type(uint160).max`
  4. `Usdc3009Sig memory u = _decodeUsdc3009(sig);`
  5. Step 1: `_spendingAllowed(s, c)` (not frozen, not paused)
  6. Step 2: `ICzarVault.Reservation storage r = s.reservations[u.reservationId];` `r.state == ICzarVault.ReservationState.Active`
  7. Step 3: `u.index < r.count` and `r.doneMask & (uint128(1) << u.index) == 0`
  8. Step 4: `u.nonce == VaultGuards.derivedNonce(u.reservationId, u.index)`
  9. `u.to == r.payee && u.value == r.unitAmount && u.validAfter == 0 && u.validBefore == r.validBefore` (RV-035: `value` exactly the unit)
  10. Step 5: `block.timestamp < u.validBefore`
  11. Step 6: `digest == CzarHashing.typedDataHash(c.usdcDomainSeparator, CzarHashing.transferWithAuthorizationHash(address(this), u.to, u.value, u.validAfter, u.validBefore, u.nonce))`
  12. Step 7: `return VaultGuards.agentSigned(s, digest, u.agentSig);`
- **`_decodeUsdc3009(bytes calldata sig) private pure returns (Usdc3009Sig memory u)`**:
  - `(, u.reservationId, u.index, u.to, u.value, u.validAfter, u.validBefore, u.nonce, u.agentSig) = abi.decode(sig, (bytes32, uint64, uint32, address, uint256, uint256, uint256, bytes32, bytes));`

### 7.4 Fallback, 65 bytes (§6.4)
- **`_checkFallback(s, c, bytes32 digest, bytes calldata sig) private view returns (bool)`**; any failed line returns `false`:
  1. `DigestSlot memory slot = s.digestSlot[digest];` `slot.set`
  2. `_spendingAllowed(s, c)`
  3. `ICzarVault.Reservation storage r = s.reservations[slot.reservationId];` `r.state == Active`
  4. `slot.index < r.count` and its done bit is clear
  5. `block.timestamp < r.validBefore` (D88)
  6. `r.mode == ICzarVault.ReservationMode.Digest`
  7. `return VaultGuards.agentSigned(s, digest, sig);`

### 7.5 `GATEWAY_BURN` placeholder (PRD 08 replaces it)
- Exactly this, between the fallback and `SL_RECEIPT` sections:
```solidity
    /// @dev Built by 07 PRD 08 (pockets). Until then a GATEWAY_BURN signature is never valid.
    function _checkGatewayBurn(VaultState storage, VaultConfig memory, bytes32, bytes calldata)
        private
        pure
        returns (bool)
    {
        return false;
    }
```

### 7.6 `SL_RECEIPT` (§6.3, RV-013)
- **`_checkSlReceipt(s, c, bytes32 digest, bytes calldata sig) private view returns (bool)`**; not gated by freeze or pause (§15, G-40); any failed line returns `false`:
  1. `_slLayoutOk(sig)`
  2. `(, ICzarVault.SlReceipt memory receipt, bytes memory agentSig) = abi.decode(sig, (bytes32, ICzarVault.SlReceipt, bytes));`
  3. `bytes32 structHash = CzarHashing.receiptStructHash(receipt);`
  4. `digest == CzarHashing.typedDataHash(c.slDomainSeparator, structHash)`
  5. `bytes32 bound = CzarHashing.typedDataHash(c.vaultDomainSeparator, CzarHashing.receiptAttestationStructHash(structHash));`
  6. `return VaultGuards.agentSigned(s, bound, agentSig);`
- **`_slLayoutOk(bytes calldata sig) private pure returns (bool)`** (the `SL_RECEIPT` row of the §6 table, in this order; any failed line returns `false`):
  1. `uint256 len = sig.length;` `len >= SL_MIN_LENGTH`
  2. `_word(sig, 1) == SL_TUPLE_OFFSET`
  3. `_tupleWord(sig, 4) == SL_STRING_OFFSET` (the string's offset inside the tuple)
  4. `uint256 l = uint256(bytes32(sig[SL_STRING_LENGTH_POS:SL_STRING_LENGTH_POS + 32]));` `l < len`
  5. `uint256 padded = (l + 31) / 32 * 32;` `len == SL_MIN_LENGTH + padded`
  6. `_word(sig, 2) == SL_SIG_OFFSET_BASE + padded`
  7. `uint256 sigOffset = SL_SIG_OFFSET_BASE + padded;` `uint256(bytes32(sig[sigOffset:sigOffset + 32])) == AGENT_SIG_LENGTH`
  8. `_tupleWord(sig, 3) <= type(uint16).max`
  9. `_tupleWord(sig, 6)`, `_tupleWord(sig, 7)`, `_tupleWord(sig, 8)` and `_tupleWord(sig, 12)` each `<= type(uint64).max`
  10. `_tupleWord(sig, 9)` and `_tupleWord(sig, 11)` each `<= type(uint8).max`
  11. `return true;`

### 7.7 Shared private helpers
1. **`_spendingAllowed(VaultState storage s, VaultConfig memory c) private view returns (bool)`** (§6.1 step 1; cannot revert):
   - `if (s.frozen) return false;`
   - `try ICzarVaultFactory(c.factory).guardianPaused() returns (bool paused) { return !paused; } catch { return false; }`
2. **`_word(bytes calldata sig, uint256 i) private pure returns (uint256)`**: `return uint256(bytes32(sig[32 * i:32 * i + 32]));`
3. **`_tupleWord(bytes calldata sig, uint256 i) private pure returns (uint256)`**: `uint256 at = SL_TUPLE_OFFSET + 32 * i; return uint256(bytes32(sig[at:at + 32]));`
- Every slice above is in range because the length checks come first; that is why the order inside each function is binding.

### 7.8 Order in the file
Constants, `isValidSignature`, `Usdc3009Sig`, `_checkUsdc3009`, `_decodeUsdc3009`, `_checkFallback`, `_checkGatewayBurn`, `_checkSlReceipt`, `_slLayoutOk`, `_spendingAllowed`, `_word`, `_tupleWord`, each section under a `// ───────────── <Name> ─────────────` divider.

## 8. `test/SignatureTest.t.sol`
- 38 tests: an end-to-end `transferWithAuthorization` through the real `MockArcUSDC` and ERC-1271 path, then `settle`; the exposure bound (a second use of one index fails); every `USDC_3009` refusal the T-016 acceptance list names (wrong nonce, index ≥ count, done bit, wrong `to`, `value` above and below `unitAmount` (RV-035), `validAfter != 0`, wrong `validBefore`, expired, frozen, paused, wrong digest, wrong signer, high-s, bad `v`), wrong lengths and offsets, out-of-range head words; the fallback (valid through USDC, unregistered digest, envelope-mode digest, frozen or expired, wrong signer); `SL_RECEIPT` (valid, not gated by freeze or pause, another SL type, a signature for vault A on vault B, the v1 tag, origin lengths, malformed); unknown kinds; and three never-revert fuzz tests.
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICzarVault} from "../src/interfaces/ICzarVault.sol";
import {CzarHashing} from "../src/libraries/CzarHashing.sol";
import {KIND_USDC_3009, KIND_SL_RECEIPT, SECP256K1_HALF_N} from "../src/libraries/CzarConstants.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";
import {CzarVaultHarness} from "./helpers/CzarVaultHarness.sol";
import {PayeeTree} from "./helpers/PayeeTree.sol";

/// @dev 07 PRD 07 (T-016). czar-vault.md §6.1, §6.3, §6.4, §6.5, §15; INV-4, INV-5, INV-11.
contract SignatureTest is VaultTestBase, PayeeTree {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant INVALID = 0xffffffff;
    bytes32 internal constant SL_V1_TAG = 0x6caa53e9addf8fd5f6ef2283c076da956fffddb63f2677a5beeed71428d8601f;
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint64 internal constant LIFETIME = 1 days;
    uint64 internal constant TTL = 300;
    uint256 internal constant UNIT = 100_000;

    uint256 internal agentPk = uint256(keccak256(abi.encodePacked("agent"))); // forge-std makeAddr("agent") key
    address internal relayer = makeAddr("relayer");
    uint64 internal env;
    uint64 internal rid;
    uint64 internal vb;

    function setUp() public override {
        super.setUp();
        env = _openEnvelope(vault);
        vb = uint64(block.timestamp + TTL);
        rid = _reserve(vault, env, 4, false);
    }

    // ───────────── Helpers ─────────────

    function _openEnvelope(ICzarVault v) internal returns (uint64 id) {
        usdc.mint(address(v), 2 * ONE_USDC);
        ICzarVault.OpenEnvelopeParams memory p;
        p.cap = 2 * ONE_USDC;
        p.maxStepAmount = ONE_USDC;
        p.expiresAt = uint64(block.timestamp + LIFETIME);
        p.categoryId = keccak256("category");
        p.payeeRoot = PAYEE_ROOT;
        vm.prank(owner);
        id = v.openEnvelope(p);
    }

    function _reserve(ICzarVault v, uint64 id, uint32 count, bool digestMode) internal returns (uint64) {
        bytes32[] memory proof = _proofBeef();
        uint64 validBefore = uint64(block.timestamp + TTL);
        vm.prank(agent);
        return digestMode
            ? v.reserveWithDigests(id, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, proof, UNIT, count, validBefore)
            : v.reserve(id, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, proof, UNIT, count, validBefore);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _usdcDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes32) {
        return CzarHashing.typedDataHash(
            usdc.DOMAIN_SEPARATOR(),
            CzarHashing.transferWithAuthorizationHash(from, to, value, validAfter, validBefore, nonce)
        );
    }

    /// @dev Full USDC_3009 envelope (02 §6.3.1) for index `i` of `rid` on `vault`, with explicit fields.
    function _envelope(
        uint64 r,
        uint32 i,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint256 pk
    ) internal view returns (bytes memory sig, bytes32 digest) {
        digest = _usdcDigest(address(vault), to, value, validAfter, validBefore, nonce);
        sig = abi.encode(KIND_USDC_3009, r, i, to, value, validAfter, validBefore, nonce, _sign(pk, digest));
    }

    function _validEnvelope(uint32 i) internal view returns (bytes memory sig, bytes32 digest) {
        return _envelope(rid, i, PAYEE_BEEF, UNIT, 0, vb, vault.derivedNonce(rid, i), agentPk);
    }

    function _check(bytes32 digest, bytes memory sig) internal view returns (bytes4) {
        return vault.isValidSignature(digest, sig);
    }

    // ───────────── USDC_3009: the real path through USDC ─────────────

    function test_usdc3009_endToEnd_transferThenSettle() public {
        (bytes memory sig,) = _validEnvelope(2);
        bytes32 nonce = vault.derivedNonce(rid, 2);
        vm.prank(relayer); // Circle's relayer calls the bytes overload 0xcf092995 (A1-18)
        usdc.transferWithAuthorization(address(vault), PAYEE_BEEF, UNIT, 0, vb, nonce, sig);
        assertEq(usdc.balanceOf(PAYEE_BEEF), UNIT);
        assertTrue(usdc.authorizationState(address(vault), nonce));
        uint32[] memory idx = new uint32[](1);
        idx[0] = 2;
        vault.settle(rid, idx);
        assertEq(vault.getEnvelope(env).spent, UNIT);
    }

    function test_usdc3009_valid_returnsMagic() public view {
        (bytes memory sig, bytes32 digest) = _validEnvelope(0);
        assertEq(sig.length, 416);
        assertEq(_check(digest, sig), MAGIC);
    }

    /// @dev §6.5: the agent can sign many authorizations for one index; USDC accepts only the first (one nonce).
    function test_exposureBound_secondUseOfIndexFails() public {
        (bytes memory sig,) = _validEnvelope(1);
        bytes32 nonce = vault.derivedNonce(rid, 1);
        vm.prank(relayer);
        usdc.transferWithAuthorization(address(vault), PAYEE_BEEF, UNIT, 0, vb, nonce, sig);
        vm.prank(relayer);
        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        usdc.transferWithAuthorization(address(vault), PAYEE_BEEF, UNIT, 0, vb, nonce, sig);
    }

    // ───────────── USDC_3009: each check of §6.1 failing alone ─────────────

    function test_usdc3009_frozen_invalid() public {
        (bytes memory sig, bytes32 digest) = _validEnvelope(0);
        vm.prank(owner);
        vault.freeze();
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_paused_invalid() public {
        (bytes memory sig, bytes32 digest) = _validEnvelope(0);
        vaultFactory.setGuardianPaused(true);
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_reservationNotActive_invalid() public {
        (bytes memory sig, bytes32 digest) =
            _envelope(99, 0, PAYEE_BEEF, UNIT, 0, vb, vault.derivedNonce(99, 0), agentPk);
        assertEq(_check(digest, sig), INVALID); // unknown reservation
        (sig, digest) = _validEnvelope(0);
        vm.warp(vb + 1);
        vault.finalize(rid, 0, 1); // now Finalizing
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_indexOutOfRange_invalid() public view {
        (bytes memory sig, bytes32 digest) =
            _envelope(rid, 4, PAYEE_BEEF, UNIT, 0, vb, vault.derivedNonce(rid, 4), agentPk);
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_doneIndex_invalid() public {
        (bytes memory sig, bytes32 digest) = _validEnvelope(0);
        usdc.consumeAuthorizationForTest(address(vault), PAYEE_BEEF, UNIT, vault.derivedNonce(rid, 0));
        uint32[] memory idx = new uint32[](1);
        vault.settle(rid, idx); // index 0 is done
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_wrongNonce_invalid() public view {
        (bytes memory sig, bytes32 digest) =
            _envelope(rid, 0, PAYEE_BEEF, UNIT, 0, vb, vault.derivedNonce(rid, 1), agentPk);
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_wrongPayee_invalid() public view {
        (bytes memory sig, bytes32 digest) =
            _envelope(rid, 0, PAYEE_CAFE, UNIT, 0, vb, vault.derivedNonce(rid, 0), agentPk);
        assertEq(_check(digest, sig), INVALID);
    }

    /// @dev RV-035 named test.
    function test_usdc3009_valueBelowUnitAmount_invalid() public view {
        (bytes memory sig, bytes32 digest) =
            _envelope(rid, 0, PAYEE_BEEF, UNIT - 1, 0, vb, vault.derivedNonce(rid, 0), agentPk);
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_valueAboveUnitAmount_invalid() public view {
        (bytes memory sig, bytes32 digest) =
            _envelope(rid, 0, PAYEE_BEEF, UNIT + 1, 0, vb, vault.derivedNonce(rid, 0), agentPk);
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_validAfterNonZero_invalid() public view {
        (bytes memory sig, bytes32 digest) =
            _envelope(rid, 0, PAYEE_BEEF, UNIT, 1, vb, vault.derivedNonce(rid, 0), agentPk);
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_wrongValidBefore_invalid() public view {
        (bytes memory sig, bytes32 digest) =
            _envelope(rid, 0, PAYEE_BEEF, UNIT, 0, vb - 1, vault.derivedNonce(rid, 0), agentPk);
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_expired_invalid() public {
        (bytes memory sig, bytes32 digest) = _validEnvelope(0);
        vm.warp(vb);
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_digestMismatch_invalid() public view {
        (bytes memory sig,) = _validEnvelope(0);
        assertEq(_check(keccak256("other"), sig), INVALID);
    }

    function test_usdc3009_wrongSigner_invalid() public view {
        (bytes memory sig, bytes32 digest) =
            _envelope(rid, 0, PAYEE_BEEF, UNIT, 0, vb, vault.derivedNonce(rid, 0), 0xBAD);
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_highS_invalid() public view {
        bytes32 nonce = vault.derivedNonce(rid, 0);
        bytes32 digest = _usdcDigest(address(vault), PAYEE_BEEF, UNIT, 0, vb, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);
        bytes32 highS = bytes32(SECP256K1_N - uint256(s)); // same signature, malleable form
        uint8 flippedV = v == 27 ? 28 : 27;
        assertGt(uint256(highS), SECP256K1_HALF_N);
        bytes memory sig = abi.encode(
            KIND_USDC_3009,
            rid,
            uint32(0),
            PAYEE_BEEF,
            UNIT,
            uint256(0),
            uint256(vb),
            nonce,
            abi.encodePacked(r, highS, flippedV)
        );
        assertEq(_check(digest, sig), INVALID);
    }

    function test_usdc3009_badV_invalid() public view {
        bytes32 nonce = vault.derivedNonce(rid, 0);
        bytes32 digest = _usdcDigest(address(vault), PAYEE_BEEF, UNIT, 0, vb, nonce);
        (, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);
        bytes memory sig = abi.encode(
            KIND_USDC_3009,
            rid,
            uint32(0),
            PAYEE_BEEF,
            UNIT,
            uint256(0),
            uint256(vb),
            nonce,
            abi.encodePacked(r, s, uint8(1))
        );
        assertEq(_check(digest, sig), INVALID);
    }

    // ───────────── USDC_3009: malformed bytes never revert ─────────────

    function test_usdc3009_wrongLength_invalid() public view {
        (bytes memory sig, bytes32 digest) = _validEnvelope(0);
        assertEq(_check(digest, abi.encodePacked(sig, bytes1(0))), INVALID);
        bytes memory shorter = new bytes(415);
        for (uint256 i = 0; i < 415; i++) {
            shorter[i] = sig[i];
        }
        assertEq(_check(digest, shorter), INVALID);
    }

    function test_usdc3009_badOffsetOrSigLength_invalid() public view {
        (bytes memory sig, bytes32 digest) = _validEnvelope(0);
        bytes memory a = sig;
        a[32 * 8 + 31] = 0x00; // offset word no longer 0x120
        assertEq(_check(digest, a), INVALID);
        (bytes memory b,) = _validEnvelope(0);
        b[32 * 9 + 31] = 0x40; // agentSig length word no longer 65
        assertEq(_check(digest, b), INVALID);
    }

    function test_usdc3009_outOfRangeHeadWords_invalidNotRevert() public view {
        uint256[3] memory words = [uint256(1), 2, 3]; // reservationId (uint64), index (uint32), to (address)
        for (uint256 k = 0; k < 3; k++) {
            (bytes memory sig, bytes32 digest) = _validEnvelope(0);
            sig[32 * words[k]] = 0x01; // set a high byte: out of range for the narrow type
            assertEq(_check(digest, sig), INVALID);
        }
    }

    // ───────────── 65-byte fallback (§6.4) ─────────────

    function test_fallback_digestMode_validThroughUsdc() public {
        uint64 r2 = _reserve(vault, env, 2, true);
        bytes32 nonce = vault.derivedNonce(r2, 1);
        bytes32 digest = _usdcDigest(address(vault), PAYEE_BEEF, UNIT, 0, vb, nonce);
        bytes memory sig65 = _sign(agentPk, digest);
        assertEq(_check(digest, sig65), MAGIC);
        vm.prank(relayer);
        usdc.transferWithAuthorization(address(vault), PAYEE_BEEF, UNIT, 0, vb, nonce, sig65);
        assertEq(usdc.balanceOf(PAYEE_BEEF), UNIT);
    }

    function test_fallback_unregisteredDigest_invalid() public view {
        bytes32 digest = keccak256("not registered");
        assertEq(_check(digest, _sign(agentPk, digest)), INVALID);
    }

    function test_fallback_envelopeModeDigest_invalid() public view {
        (, bytes32 digest) = _validEnvelope(0); // envelope-mode reservation: no digest slot
        assertEq(_check(digest, _sign(agentPk, digest)), INVALID);
    }

    function test_fallback_frozenOrExpired_invalid() public {
        uint64 r2 = _reserve(vault, env, 1, true);
        bytes32 digest = _usdcDigest(address(vault), PAYEE_BEEF, UNIT, 0, vb, vault.derivedNonce(r2, 0));
        bytes memory sig65 = _sign(agentPk, digest);
        vm.prank(owner);
        vault.freeze();
        assertEq(_check(digest, sig65), INVALID);
        vm.prank(owner);
        vault.unfreeze();
        assertEq(_check(digest, sig65), MAGIC);
        vm.warp(vb);
        assertEq(_check(digest, sig65), INVALID); // validBefore reached (D88, G-39)
    }

    function test_fallback_wrongSigner_invalid() public {
        uint64 r2 = _reserve(vault, env, 1, true);
        bytes32 digest = _usdcDigest(address(vault), PAYEE_BEEF, UNIT, 0, vb, vault.derivedNonce(r2, 0));
        assertEq(_check(digest, _sign(0xBAD, digest)), INVALID);
    }

    // ───────────── SL_RECEIPT (§6.3, RV-013) ─────────────

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
        r.disclosure = 2;
        r.createdAt = 1760790004;
    }

    /// @dev The SL digest (vector 0x8bef0825…d561 on 5042002) and an agent signature bound to vault `v`.
    function _slSig(ICzarVault v, ICzarVault.SlReceipt memory r)
        internal
        view
        returns (bytes memory sig, bytes32 digest)
    {
        bytes32 structHash = CzarHashing.receiptStructHash(r);
        digest = CzarHashing.typedDataHash(
            CzarHashing.domainSeparatorNoContract(keccak256("SelectionLayer"), keccak256("1"), block.chainid),
            structHash
        );
        bytes32 vaultDomain =
            CzarHashing.domainSeparatorFull(keccak256("CzarVault"), keccak256("1"), block.chainid, address(v));
        bytes32 bound = CzarHashing.typedDataHash(vaultDomain, CzarHashing.receiptAttestationStructHash(structHash));
        sig = abi.encode(KIND_SL_RECEIPT, r, _sign(agentPk, bound));
    }

    function test_slReceipt_valid_returnsMagic() public view {
        (bytes memory sig, bytes32 digest) = _slSig(vault, _receipt());
        assertEq(digest, 0x8bef0825cbab5aff373a3651d22ee4169a09d1504ad6eb30c02277d37725d561); // the vector
        assertEq(sig.length, 704);
        assertEq(_check(digest, sig), MAGIC);
    }

    function test_slReceipt_notGatedByFreezeOrPause() public {
        (bytes memory sig, bytes32 digest) = _slSig(vault, _receipt());
        vm.prank(owner);
        vault.freeze();
        vaultFactory.setGuardianPaused(true);
        assertEq(_check(digest, sig), MAGIC);
    }

    /// @dev RV-013 named test.
    function test_slReceipt_otherSlType_invalid() public view {
        (bytes memory sig,) = _slSig(vault, _receipt());
        bytes32 correctionDigest = keccak256("a Correction or any other SL type");
        assertEq(_check(correctionDigest, sig), INVALID);
    }

    /// @dev RV-013 named test.
    function test_slReceipt_signatureForVaultA_invalidOnVaultB() public {
        ICzarVault vaultB = vaultFactory.deploy(makeAddr("ownerB")); // same agentSigner (factory defaults)
        (bytes memory sigForA, bytes32 digest) = _slSig(vault, _receipt());
        assertEq(vault.isValidSignature(digest, sigForA), MAGIC);
        assertEq(vaultB.isValidSignature(digest, sigForA), INVALID);
    }

    /// @dev RV-013 named test.
    function test_slReceipt_v1Tag_invalid() public view {
        (bytes memory sig, bytes32 digest) = _slSig(vault, _receipt());
        for (uint256 i = 0; i < 32; i++) {
            sig[i] = SL_V1_TAG[i];
        }
        assertEq(_check(digest, sig), INVALID);
    }

    function test_slReceipt_originLengths_valid() public view {
        string[4] memory origins = ["", "a", "https://exactly-thirty-two-chars", "https://thirty-three-characters.io"];
        for (uint256 i = 0; i < origins.length; i++) {
            ICzarVault.SlReceipt memory r = _receipt();
            r.originAsserted = origins[i];
            (bytes memory sig, bytes32 digest) = _slSig(vault, r);
            assertEq(_check(digest, sig), MAGIC);
        }
    }

    function test_slReceipt_malformed_invalidNotRevert() public view {
        (bytes memory sig, bytes32 digest) = _slSig(vault, _receipt());
        bytes memory shortSig = new bytes(100);
        for (uint256 i = 0; i < 32; i++) {
            shortSig[i] = sig[i];
        }
        assertEq(_check(digest, shortSig), INVALID); // shorter than 672: no read past the end
        bytes memory a = sig;
        a[0x60 + 32 * 3] = 0x01; // statusCode word out of uint16 range
        assertEq(_check(digest, a), INVALID);
        (bytes memory b,) = _slSig(vault, _receipt());
        b[0x200 + 31] = 0x40; // string length word no longer matches the total length
        assertEq(_check(digest, b), INVALID);
        (bytes memory c,) = _slSig(vault, _receipt());
        c[0x60 + 32 * 9] = 0x01; // outcome word out of uint8 range
        assertEq(_check(digest, c), INVALID);
    }

    // ───────────── Dispatcher ─────────────

    function test_unknownKindOrShort_invalid() public view {
        bytes32 digest = keccak256("d");
        assertEq(_check(digest, ""), INVALID);
        assertEq(_check(digest, hex"01"), INVALID);
        assertEq(_check(digest, abi.encode(keccak256("unknown kind"), uint256(1))), INVALID);
    }

    function testFuzz_isValidSignature_neverReverts(bytes32 digest, uint8 kindSel, bytes calldata blob) public view {
        bytes32[4] memory kinds = [
            KIND_USDC_3009, KIND_SL_RECEIPT, 0xf453aa3365355a8cf99e674b4443d5009b132245c53a3eb3b5a14953d97265f2, digest
        ];
        bytes4 result = vault.isValidSignature(digest, abi.encodePacked(kinds[kindSel % 4], blob));
        assertTrue(result == INVALID || result == MAGIC);
    }

    function testFuzz_usdc3009_corruptedByte_neverReverts(uint256 pos, uint8 value) public view {
        (bytes memory sig, bytes32 digest) = _validEnvelope(0);
        pos = bound(pos, 32, sig.length - 1);
        sig[pos] = bytes1(value);
        bytes4 result = vault.isValidSignature(digest, sig);
        assertTrue(result == INVALID || result == MAGIC);
    }

    function testFuzz_slReceipt_corruptedByte_neverReverts(uint256 pos, uint8 value) public view {
        (bytes memory sig, bytes32 digest) = _slSig(vault, _receipt());
        pos = bound(pos, 32, sig.length - 1);
        sig[pos] = bytes1(value);
        bytes4 result = vault.isValidSignature(digest, sig);
        assertTrue(result == INVALID || result == MAGIC);
    }
}
```

## 9. Build steps (tests first)
1. Create `test/SignatureTest.t.sol` (§8).
2. Run `FOUNDRY_PROFILE=arc arc-forge test --match-path test/SignatureTest.t.sol`. Expected: `0 passed; 38 failed`. 36 failures mention `NotBuilt()`; `test_usdc3009_endToEnd_transferThenSettle` and `test_exposureBound_secondUseOfIndexFails` fail with `FiatTokenV2: invalid signature` (USDC asks the stub, which refuses). Paste the summary line into your report.
3. Write `src/vault/logic/SignatureLogic.sol` from §7.
4. Do §5 (delete the stub) and §6 (replace `CzarVault.sol`).
5. Run the test file again: 38 passed.
6. `arc-forge fmt src/vault/logic/SignatureLogic.sol src/vault/VaultStubs.sol`, then `arc-forge fmt --check` on those two files plus `src/CzarVault.sol` and `test/SignatureTest.t.sol`: nothing printed apart from the flag notice.
7. Run the clean gate build and the full suite (00-conventions §2.2).

## 10. Definition of done
- `FOUNDRY_PROFILE=arc arc-forge test --match-contract SignatureTest` → 38 passed, 0 failed (T-016 acceptance command).
- `FOUNDRY_PROFILE=arc arc-forge test` → 242 passed, 0 failed.
- `rm -rf out cache && FOUNDRY_PROFILE=arc arc-forge build --deny-warnings --sizes` → no warnings; `CzarVault` runtime about 11,923 B and `SignatureLogic` about 5,056 B (more than 300 B off means your code differs from §6 or §7).
- `grep -c "revert NotBuilt" src/vault/VaultStubs.sol` → 16.
- `diff -r src/interfaces ../docs/specs/03-smart-contracts/interfaces` → nothing.

- **Not in this PRD (deferred to PRD 12):** T-016's exposure test that signs 1,000 authorizations against a `count = 10` reservation is `test/ExposureTest.t.sol` in PRD 12. Report T-016 as done except that item, citing PRD 12.

## 11. Stop conditions
- A test fails after you have compared the function with its numbered steps in §7: stop and report the test name and failure line. Never change a test.
- A fuzz test reports a revert: a length, offset or range check is missing or out of order. Compare with §7.3 steps 1–3 and §7.6 `_slLayoutOk`. If they match, stop and report the counterexample.

## Change log
| Date | Change |
|---|---|
| 2026-10-20 | First version (D89 library layout), verified on Arc Foundry v0.8.0-2 against a reference implementation. |
| 2026-10-20 | Red phase: two failures are `FiatTokenV2: invalid signature`; the 1,000-authorization exposure test is deferred to PRD 12; Sources (review). |
