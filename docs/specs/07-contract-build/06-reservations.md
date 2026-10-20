# 06 — Reservations

## 1. Scope
- **Task:** T-015 (reservations: `reserve`, `reserveWithDigests`, `settle`, `finalize`; `derivedNonce` was built by PRD 03).
- **You build:**
  - `contracts/src/vault/logic/ReservationLogic.sol`: a linked library with 3 external functions and its private helpers (§8).
  - `contracts/src/CzarVault.sol`: replaced with the version in §6 (adds 4 wrappers).
  - Test setup: one test control in `MockArcUSDC`, two read helpers in `CzarVaultHarness`, and the payee-tree helper `PayeeTree` (§7).
  - `contracts/test/ReserveTest.t.sol` (§9).
  - You delete 4 stubs from `VaultStubs.sol`.
- **You do not build:** `isValidSignature` (PRD 07). Until then a reservation's authorizations are "used" in tests through `MockArcUSDC.consumeAuthorizationForTest`, which marks the derived nonce used exactly as a settled `transferWithAuthorization` does. PRD 07 repeats the key cases through the real ERC-1271 path.
- **Dependencies:** PRD 05 done (171 tests, `EnvelopeTest` 28 passed, 21 stubs).

## 2. This PRD is already verified
- A reference `ReservationLogic` written from §8 passed on **Arc Foundry v0.8.0-2** with `FOUNDRY_PROFILE=arc`: clean `--deny-warnings` build (compiler and lint), `fmt --check` clean, 204 tests passed (171 earlier plus 33 here).
- Sizes after this PRD: `CzarVault` runtime 11,657 B, initcode 13,350 B; `CzarVaultFactory` runtime 17,864 B; `ReservationLogic` runtime 6,595 B.
- The test file (§9) and the test setup (§7) are printed in full: copy them exactly.

## 3. Sources (read these, nothing else)
- `07-contract-build/00-conventions.md` (§3.1 stubs, §3.2 library rules, §4.11 traps, §5 tests, §5.6 traps).
- `07-contract-build/04-vault-core.md` §5 (the wrapper-and-library rule).
- `docs/specs/03-smart-contracts/czar-vault.md`: §5.3 (the reservation functions), §6.5 (exposure bound), §8.2 (reservation state machine), §11 INV-5, INV-8, INV-12, INV-13, §15.2, §15.3, §15.4 (`StepUsed`), §15.5, §15.6 (ids), §15.7 (`finalize` time gate), §15.11 (digest-mode cleanup).
- `docs/specs/02-data-and-protocol/data-and-protocol.md` §5.3 (payee leaf), §7.2 (derived nonce).
- `docs/specs/03-smart-contracts/interfaces/ICzarVault.sol` (`Reservation`, `ReservationMode`, `ReservationState`, events, errors).
- `docs/specs/03-smart-contracts/security-and-testing.md` §3.7 rows RV-001, RV-002, RV-056.

## 4. Files
| File | Action | Section |
|---|---|---|
| `contracts/test/mocks/MockArcUSDC.sol` | replace (adds one function) | §7.1 |
| `contracts/test/helpers/CzarVaultHarness.sol` | replace (adds two functions) | §7.2 |
| `contracts/test/helpers/PayeeTree.sol` | create | §7.3 |
| `contracts/test/ReserveTest.t.sol` | create | §9 |
| `contracts/src/vault/logic/ReservationLogic.sol` | create | §8 |
| `contracts/src/vault/VaultStubs.sol` | delete 4 stubs | §5 |
| `contracts/src/CzarVault.sol` | replace | §6 |

## 5. Delete the stubs
- In `VaultStubs.sol`, delete the whole stub of `finalize`, `reserve`, `reserveWithDigests` and `settle` (any method). Afterwards `grep -c "revert NotBuilt" src/vault/VaultStubs.sol` prints `17`.

## 6. `src/CzarVault.sol` (replace the whole file)
- Adds four wrappers. `reserve` and `reserveWithDigests` build one `ReservationLogic.ReserveRequest` (the struct keeps the library function under the stack limit, 00-conventions §4.11) and differ only in `mode`. They are not guarded: they make no external call other than the factory's `guardianPaused()` view (§15.5). `settle` and `finalize` read USDC, so they are `nonReentrant`.
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
}
```

## 7. Test setup

### 7.1 `test/mocks/MockArcUSDC.sol` (replace the whole file)
- Adds one test control, `consumeAuthorizationForTest(from, to, value, nonce)` (controller only), right after `mint`. It marks `from`'s authorization `nonce` used, emits `AuthorizationUsed`, and moves `value` from `from` to `to`: exactly the effects of a settled `transferWithAuthorization`, without a signature. Nothing else in the file changes.
- Its name must not start with `test` (00-conventions §5.6).
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";

/// @title MockArcUSDC
/// @notice Test double of Arc USDC (`NativeFiatTokenV2_2`, A1-04) for vault unit, fuzz and invariant tests, with
///         ONE ledger: the native balance is the USDC balance, as on Arc (A1-05). `balanceOf(a) = a.balance / 1e12`;
///         every transfer moves native value with `vm.deal`. So a native send by the vault (grantPocketGas) lowers its
///         USDC balance exactly as on Arc (security-and-testing.md §3.3, D88 G-62). A copy of MockUSDC3009 with the
///         ledger replaced; everything else (EIP-3009, ERC-1271 dispatch, nonces, pause, blacklist) is unchanged.
///         Place it at 0x3600…0000 with deployCodeTo (00-conventions §5.5).
/// @dev Behaviour follows circlefin/stablecoin-evm `contracts/v2/EIP3009.sol` lines 84–143 and 296–335 and
///      `contracts/util/SignatureChecker.sol` lines 38–76 (A1-06, A1-07, A1-09). Revert strings are copied.
contract MockArcUSDC {
    /// @dev Foundry cheatcode address; this mock is test-only.
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    /// @dev One 6-decimal USDC unit is 10^12 wei of native value (A1-05).
    uint256 internal constant NATIVE_SCALE = 1e12;

    // A1-03: name "USDC", symbol "USDC", version "2", decimals 6.
    string internal constant NAME = "USDC";
    string internal constant SYMBOL = "USDC";
    string internal constant VERSION = "2";
    uint8 internal constant DECIMALS = 6;

    // EIP3009.sol: keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;
    // keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;
    // keccak256("CancelAuthorization(address authorizer,bytes32 nonce)")
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429;

    bytes4 internal constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
    uint256 internal constant ECDSA_SIGNATURE_LENGTH = 65;
    // secp256k1n / 2; ECRecover rejects malleable high-s signatures.
    uint256 internal constant SECP256K1_HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    bool public paused;
    mapping(address => bool) internal _blacklisted;
    mapping(address => mapping(bytes32 => bool)) internal _authorizationStates;
    address public immutable controller;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);
    event Pause();
    event Unpause();
    event Blacklisted(address indexed account);
    event UnBlacklisted(address indexed account);

    modifier whenNotPaused() {
        require(!paused, "Pausable: paused");
        _;
    }

    modifier notBlacklisted(address account) {
        require(!_blacklisted[account], "Blacklistable: account is blacklisted");
        _;
    }

    modifier onlyController() {
        require(msg.sender == controller, "MockArcUSDC: caller is not the controller");
        _;
    }

    constructor() {
        controller = msg.sender;
    }

    // ─────────────── Test controls (stand in for Circle's minter, pauser and blacklister roles) ───────────────

    function mint(address to, uint256 value) external onlyController {
        require(to != address(0), "FiatToken: mint to the zero address");
        require(value > 0, "FiatToken: mint amount not greater than 0");
        totalSupply += value;
        VM.deal(to, to.balance + value * NATIVE_SCALE);
        emit Transfer(address(0), to, value);
    }

    /// @notice Test control (07 PRD 06): consumes `from`'s authorization `nonce` and moves `value` to `to`, exactly as a
    ///         settled transferWithAuthorization does, without a signature. Lets reservation tests run before the vault's
    ///         isValidSignature exists (PRD 07 then repeats the key cases through the real ERC-1271 path).
    function consumeAuthorizationForTest(address from, address to, uint256 value, bytes32 nonce)
        external
        onlyController
    {
        require(!_authorizationStates[from][nonce], "FiatTokenV2: authorization is used or canceled");
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function pause() external onlyController {
        paused = true;
        emit Pause();
    }

    function unpause() external onlyController {
        paused = false;
        emit Unpause();
    }

    function blacklist(address account) external onlyController {
        _blacklisted[account] = true;
        emit Blacklisted(account);
    }

    function unBlacklist(address account) external onlyController {
        _blacklisted[account] = false;
        emit UnBlacklisted(account);
    }

    // ─────────────── ERC-20 (FiatTokenV2_2 modifiers) ───────────────

    /// @notice Arc rule: the ERC-20 view of the native balance, rounded down to 6 decimals (A1-05).
    function balanceOf(address account) public view returns (uint256) {
        return account.balance / NATIVE_SCALE;
    }

    function name() external pure returns (string memory) {
        return NAME;
    }

    function symbol() external pure returns (string memory) {
        return SYMBOL;
    }

    function version() external pure returns (string memory) {
        return VERSION;
    }

    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }

    function isBlacklisted(address account) external view returns (bool) {
        return _blacklisted[account];
    }

    /// @notice A1-03: DOMAIN_SEPARATOR = EIP712Domain(name "USDC", version "2", chainId, verifyingContract).
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(NAME)),
                keccak256(bytes(VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    function approve(address spender, uint256 value)
        external
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(spender)
        returns (bool)
    {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value)
        external
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(to)
        returns (bool)
    {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value)
        external
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(from)
        notBlacklisted(to)
        returns (bool)
    {
        require(value <= allowance[from][msg.sender], "ERC20: transfer amount exceeds allowance");
        allowance[from][msg.sender] -= value;
        _transfer(from, to, value);
        return true;
    }

    // ─────────────── EIP-3009 (A1-08 selectors) ───────────────

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /// @notice `0xe3ee160e`: the v,r,s overload packs abi.encodePacked(r, s, v) and takes the same path (A1-09).
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused notBlacklisted(from) notBlacklisted(to) {
        _transferWithAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce,
            abi.encodePacked(r, s, v)
        );
    }

    /// @notice `0xcf092995`: the bytes overload used for contract signers (A1-08, A1-20).
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external whenNotPaused notBlacklisted(from) notBlacklisted(to) {
        _transferWithAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature
        );
    }

    /// @notice `0x88b7ab63` (A1-08). The caller must be the payee.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external whenNotPaused notBlacklisted(from) notBlacklisted(to) {
        require(to == msg.sender, "FiatTokenV2: caller must be the payee");
        _transferWithAuthorization(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature
        );
    }

    /// @notice `0xb7b72899` (A1-08).
    function cancelAuthorization(address authorizer, bytes32 nonce, bytes memory signature) external whenNotPaused {
        require(!_authorizationStates[authorizer][nonce], "FiatTokenV2: authorization is used or canceled");
        _requireValidSignature(
            authorizer, keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)), signature
        );
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _transferWithAuthorization(
        bytes32 typeHash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) internal {
        // EIP3009.sol _requireValidAuthorization: strict inequalities on both bounds.
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!_authorizationStates[from][nonce], "FiatTokenV2: authorization is used or canceled");
        _requireValidSignature(
            from, keccak256(abi.encode(typeHash, from, to, value, validAfter, validBefore, nonce)), signature
        );
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function _requireValidSignature(address signer, bytes32 structHash, bytes memory signature) internal view {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        require(_isValidSignatureNow(signer, digest, signature), "FiatTokenV2: invalid signature");
    }

    /// @dev SignatureChecker.isValidSignatureNow (A1-09): a signer with code is asked through a staticcall to
    ///      isValidSignature(bytes32,bytes); the call must succeed and return at least 32 bytes whose first word
    ///      equals 0x1626ba7e. A signer without code is checked by ECDSA recovery.
    function _isValidSignatureNow(address signer, bytes32 digest, bytes memory signature) internal view returns (bool) {
        if (signer.code.length == 0) return _recover(digest, signature) == signer;
        (bool success, bytes memory result) =
            signer.staticcall(abi.encodeWithSelector(ERC1271_MAGIC_VALUE, digest, signature));
        return success && result.length >= 32 && abi.decode(result, (bytes32)) == bytes32(ERC1271_MAGIC_VALUE);
    }

    /// @dev ECRecover.recover: 65-byte r‖s‖v only, low s, v ∈ {27, 28}, non-zero result.
    function _recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        require(signature.length == ECDSA_SIGNATURE_LENGTH, "ECRecover: invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        require(uint256(s) <= SECP256K1_HALF_N, "ECRecover: invalid signature 's' value");
        require(v == 27 || v == 28, "ECRecover: invalid signature 'v' value");
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0), "ECRecover: invalid signature");
        return recovered;
    }

    /// @dev NativeFiatTokenV2_2 _transfer checks (A1-05; zero-address rule also enforced by Arc, A9-14).
    function _transfer(address from, address to, uint256 value) internal {
        require(from != address(0), "ERC20: transfer from the zero address");
        require(to != address(0), "ERC20: transfer to the zero address");
        require(value <= balanceOf(from), "ERC20: transfer amount exceeds balance");
        VM.deal(from, from.balance - value * NATIVE_SCALE);
        VM.deal(to, to.balance + value * NATIVE_SCALE);
        emit Transfer(from, to, value);
    }
}
```

### 7.2 `test/helpers/CzarVaultHarness.sol` (replace the whole file)
- Adds `exposed_digestSlot(digest)` (reads `_s.digestSlot`) and `exposed_usdcDigest(reservationId, i)` (the USDC digest the vault computes for index `i`, through `VaultGuards.usdcDigest`).
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {CzarVault} from "../../src/CzarVault.sol";
import {DigestSlot} from "../../src/vault/VaultState.sol";
import {VaultGuards} from "../../src/vault/VaultGuards.sol";

/// @title CzarVaultHarness
/// @notice Test-only subclass that exposes internal values for vector and storage tests (security-and-testing.md
///         §3.3, D88 G-58). Later PRDs add `exposed_*` functions here; it never changes vault behaviour.
contract CzarVaultHarness is CzarVault {
    constructor(address ownerAccount) CzarVault(ownerAccount) {}

    function exposed_usdcDomainSeparator() external view returns (bytes32) {
        return USDC_DOMAIN_SEPARATOR;
    }

    function exposed_slDomainSeparator() external view returns (bytes32) {
        return SL_DOMAIN_SEPARATOR;
    }

    function exposed_vaultDomainSeparator() external view returns (bytes32) {
        return VAULT_DOMAIN_SEPARATOR;
    }

    function exposed_gatewayDomain() external view returns (uint32) {
        return GATEWAY_DOMAIN;
    }

    // ───────────── Test-only state setters (07 PRD 05). They write exactly the fields a later function would
    // write, so envelope tests can run before reservations, pockets and jobs exist. Never used outside tests.

    /// @dev Stands in for open reservations (PRD 06).
    function exposed_setOpenReservations(uint64 envelopeId, uint32 count) external {
        _s.envelopes[envelopeId].openReservations = count;
    }

    /// @dev Mirrors registerPocket + fundPocket accounting (czar-vault.md §5.4) for one pocket.
    function exposed_simulateFundedPocket(uint64 envelopeId, address pocket, uint256 amount) external {
        Envelope storage e = _s.envelopes[envelopeId];
        _s.pockets[pocket] = Pocket({
            envelopeId: envelopeId,
            state: PocketState.Funded,
            funded: amount,
            gasGranted: 0,
            outstanding: amount,
            pendingPullback: 0
        });
        e.pocket = pocket;
        e.openPockets = 1;
        e.pocketOutstanding += amount;
        _s.committedTotal -= amount;
    }

    /// @dev Mirrors openJob accounting (czar-vault.md §5.5) for one unfunded job.
    function exposed_simulateOpenedJob(uint64 envelopeId, uint32 stepIndex, bytes32 jobKey, uint256 reservedCap)
        external
    {
        Envelope storage e = _s.envelopes[envelopeId];
        e.reserved += reservedCap;
        _s.stepUsed[envelopeId][stepIndex] += reservedCap;
        e.openJobs += 1;
        _s.jobs[jobKey].envelopeId = envelopeId;
        _s.jobs[jobKey].stepIndex = stepIndex;
        _s.jobs[jobKey].state = JobState.Opened;
        _s.jobs[jobKey].reservedCap = reservedCap;
    }

    /// @dev Reads a fallback-mode digest slot (07 PRD 06).
    function exposed_digestSlot(bytes32 digest) external view returns (uint64 reservationId, uint32 index, bool set) {
        DigestSlot memory d = _s.digestSlot[digest];
        return (d.reservationId, d.index, d.set);
    }

    /// @dev The USDC digest the vault computes for index `i` of a reservation (07 PRD 06).
    function exposed_usdcDigest(uint64 reservationId, uint32 i) external view returns (bytes32) {
        Reservation storage r = _s.reservations[reservationId];
        return VaultGuards.usdcDigest(_config(), r.payee, r.unitAmount, r.validBefore, reservationId, i);
    }
}
```

### 7.3 `test/helpers/PayeeTree.sol` (create)
- The four-leaf `payeeRoot` fixture of `07-contract-build/fixtures/payee-tree.json` as constants and proofs. PRDs 06–10 use it.
```solidity
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
```

## 8. `src/vault/logic/ReservationLogic.sol`

### 8.1 Header, interface and struct
- `// SPDX-License-Identifier: MIT`, `pragma solidity 0.8.30;`
- Imports, exactly:
  - `{ICzarVault}` from `../../interfaces/ICzarVault.sol`
  - `{VaultState, VaultConfig, DigestSlot}` from `../VaultState.sol`
  - `{VaultGuards}` from `../VaultGuards.sol`
  - `{PayeeLeaf}` from `../../libraries/PayeeLeaf.sol`
  - `{MAX_AUTHORIZATIONS_PER_RESERVATION, MAX_DIGEST_MODE_COUNT, MIN_RESERVATION_TTL, MAX_RESERVATION_TTL, FINALIZE_CHUNK, PAYEE_KIND_X402, POCKET_STEP_INDEX}` from `../../libraries/CzarConstants.sol`
- A file-level interface for the one USDC read (`czar-vault.md` §10; A1-11), with a `/// @dev` line:
```solidity
interface IUSDCAuthorizationState {
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
```
- `/// @title ReservationLogic`, a `/// @notice` citing `czar-vault.md` §5.3, §6.5, §15 and T-015. `library ReservationLogic { … }`.
- The request struct, first thing in the library, exactly:
```solidity
    struct ReserveRequest {
        uint64 envelopeId;
        uint32 stepIndex;
        address payee;
        uint256 stepCap;
        uint256 unitAmount;
        uint32 count;
        uint64 validBefore;
        ICzarVault.ReservationMode mode;
    }
```

### 8.2 `reserve(VaultState storage s, VaultConfig memory c, address caller, ReserveRequest memory q, bytes32[] calldata proof) external returns (uint64 reservationId)`
- Body: `(uint256 total, uint256 used) = _checkReserve(s, c, caller, q, proof); reservationId = _storeReservation(s, c, q, total, used);` (two private functions: one function with every check and effect is "stack too deep").
- **`_checkReserve(s, c, caller, q, proof) private view returns (uint256 total, uint256 used)`**, checks in this order (§15.3 general order):
  1. `VaultGuards.requireAgent(s, caller);`
  2. `VaultGuards.requireNotPausedOrFrozen(s, c);`
  3. `ICzarVault.Envelope storage e = s.envelopes[q.envelopeId];` `if (e.state != ICzarVault.EnvelopeState.Open) revert ICzarVault.EnvelopeNotOpen();`
  4. `if (block.timestamp >= e.expiresAt) revert ICzarVault.EnvelopeExpired();`
  5. `if (q.stepIndex == POCKET_STEP_INDEX || q.unitAmount == 0 || q.stepCap > e.maxStepAmount) revert ICzarVault.BadParams();`
  6. `uint256 maxCount = q.mode == ICzarVault.ReservationMode.Digest ? MAX_DIGEST_MODE_COUNT : MAX_AUTHORIZATIONS_PER_RESERVATION;` `if (q.count == 0 || q.count > maxCount) revert ICzarVault.BadCount();`
  7. `if (q.validBefore < block.timestamp + MIN_RESERVATION_TTL || q.validBefore > block.timestamp + MAX_RESERVATION_TTL || q.validBefore > e.expiresAt) revert ICzarVault.BadTtl();` (RV-056: never past the envelope's expiry)
  8. `if (!PayeeLeaf.verify(proof, e.payeeRoot, q.payee, PAYEE_KIND_X402, q.stepIndex, q.stepCap)) revert ICzarVault.PayeeNotInPlan();`
  9. `total = q.unitAmount * q.count;` `used = s.stepUsed[q.envelopeId][q.stepIndex];` `if (used + total > q.stepCap) revert ICzarVault.StepCapExceeded(q.stepIndex, used, q.stepCap, total);` (RV-002: one cap per step, shared by alternates)
  10. `if (VaultGuards.exposure(e) + total > e.cap) revert ICzarVault.CapExceeded();`
- **`_storeReservation(s, c, q, total, used) private returns (uint64 reservationId)`**, in this order:
  1. `reservationId = ++s.reservationCount;` (ids start at 1)
  2. `ICzarVault.Reservation storage r = s.reservations[reservationId];` set `envelopeId`, `stepIndex`, `payee`, `unitAmount`, `count`, `validBefore`, `mode` from `q`; `r.state = ICzarVault.ReservationState.Active;` (masks and counts stay 0)
  3. `ICzarVault.Envelope storage e = s.envelopes[q.envelopeId]; e.reserved += total; e.openReservations += 1;`
  4. `s.stepUsed[q.envelopeId][q.stepIndex] = used + total;`
  5. Digest mode only: for `uint32 i = 0; i < q.count; i++`: `s.digestSlot[VaultGuards.usdcDigest(c, q.payee, q.unitAmount, q.validBefore, reservationId, i)] = DigestSlot({reservationId: reservationId, index: i, set: true});` (the bound is `MAX_DIGEST_MODE_COUNT`, checked above)
  6. `emit ICzarVault.Reserved(reservationId, q.envelopeId, q.payee, q.stepIndex, q.unitAmount, q.count, q.validBefore, uint8(q.mode));`
  7. `emit ICzarVault.StepUsed(q.envelopeId, q.stepIndex, used + total);` (§15.4)
- `committedTotal` does not change: a reservation stays inside the envelope's commitment.

### 8.3 `settle(VaultState storage s, VaultConfig memory c, uint64 reservationId, uint32[] calldata indices) external`
(anyone; §5.3, RV-001)
1. `ICzarVault.Reservation storage r = s.reservations[reservationId];` if `r.state` is neither `Active` nor `Finalizing` → `revert ICzarVault.ReservationNotActive();`
2. `if (indices.length == 0 || indices.length > FINALIZE_CHUNK) revert ICzarVault.BadParams();`
3. For `uint256 k = 0; k < indices.length; k++`:
   1. `uint32 index = indices[k]; if (index >= r.count) revert ICzarVault.BadParams();`
   2. `uint128 bit = uint128(1) << index;` `if (r.doneMask & bit != 0) revert ICzarVault.AlreadyDone(index);`
   3. `if (!_authorizationUsed(c, reservationId, index)) revert ICzarVault.NotUsed(index);`
   4. `_bookSettled(s, r, reservationId, index, bit);`
4. `_finalizeIfDone(s, c, reservationId);`

### 8.4 `finalize(VaultState storage s, VaultConfig memory c, uint64 reservationId, uint32 fromIndex, uint32 toIndex) external`
(anyone after `validBefore`; §5.3, §15.7, RV-001)
1. Same state check as `settle` step 1.
2. `if (block.timestamp <= r.validBefore) revert ICzarVault.NotExpired();`
3. `if (fromIndex >= toIndex || toIndex > r.count || toIndex - fromIndex > FINALIZE_CHUNK) revert ICzarVault.BadParams();`
4. `if (r.state == ICzarVault.ReservationState.Active) r.state = ICzarVault.ReservationState.Finalizing;`
5. `ICzarVault.Envelope storage e = s.envelopes[r.envelopeId];` `uint256 usedBefore = s.stepUsed[r.envelopeId][r.stepIndex];`
6. For `uint32 index = fromIndex; index < toIndex; index++`:
   1. `uint128 bit = uint128(1) << index;` if `r.doneMask & bit != 0`: `continue;` (done indices are skipped, not refused)
   2. if `_authorizationUsed(c, reservationId, index)`: `_bookSettled(s, r, reservationId, index, bit);`
   3. else (release): `r.doneMask |= bit; r.releasedCount += 1; e.reserved -= r.unitAmount; s.stepUsed[r.envelopeId][r.stepIndex] -= r.unitAmount;` then `emit ICzarVault.Released(reservationId, index, r.unitAmount);`
7. `uint256 usedAfter = s.stepUsed[r.envelopeId][r.stepIndex];` `if (usedAfter != usedBefore) emit ICzarVault.StepUsed(r.envelopeId, r.stepIndex, usedAfter);` (once per call, §15.4)
8. `_finalizeIfDone(s, c, reservationId);`

### 8.5 Private helpers
1. **`_authorizationUsed(VaultConfig memory c, uint64 reservationId, uint32 index) private view returns (bool)`**
   - `return IUSDCAuthorizationState(c.usdc).authorizationState(address(this), VaultGuards.derivedNonce(reservationId, index));`
2. **`_bookSettled(VaultState storage s, ICzarVault.Reservation storage r, uint64 reservationId, uint32 index, uint128 bit) private`**
   - `r.settledMask |= bit; r.doneMask |= bit; r.settledCount += 1;`
   - `ICzarVault.Envelope storage e = s.envelopes[r.envelopeId]; e.reserved -= r.unitAmount; e.spent += r.unitAmount; s.committedTotal -= r.unitAmount;` (`stepUsed` unchanged: spent stays on the step)
   - `emit ICzarVault.Settled(reservationId, index, r.unitAmount);`
3. **`_finalizeIfDone(VaultState storage s, VaultConfig memory c, uint64 reservationId) private`** (RV-001, §15.11)
   1. `ICzarVault.Reservation storage r = s.reservations[reservationId];`
   2. if `r.state == Final` or `r.settledCount + r.releasedCount != r.count`: `return;`
   3. `r.state = ICzarVault.ReservationState.Final; s.envelopes[r.envelopeId].openReservations -= 1;`
   4. Digest mode only: for `uint32 i = 0; i < r.count; i++`: `delete s.digestSlot[VaultGuards.usdcDigest(c, r.payee, r.unitAmount, r.validBefore, reservationId, i)];`
   5. `emit ICzarVault.ReservationFinal(reservationId, r.settledCount, r.releasedCount);`

### 8.6 Order in the file
`IUSDCAuthorizationState`, then in the library: `ReserveRequest`, `reserve`, `_checkReserve`, `_storeReservation`, `settle`, `finalize`, `_authorizationUsed`, `_bookSettled`, `_finalizeIfDone`. External functions: one `/// @notice` line; private: one `/// @dev` line, each citing the spec section.

## 9. `test/ReserveTest.t.sol`
- 33 tests: the `derivedNonce` vector; `reserve` success (state, events, `StepUsed`) and the 128-count maximum; every error in check order (`NotAgent`, `FrozenVault`, `Paused`, `EnvelopeNotOpen`, `EnvelopeExpired`, `BadParams` ×3, `BadCount`, `BadTtl` ×2, `PayeeNotInPlan`, `StepCapExceeded`, `CapExceeded`); alternate payees sharing one step cap; `settle` (success, `NotUsed`, `AlreadyDone`, `BadParams`, unknown id, final after the last index and the envelope closes); `finalize` (`NotExpired`, bad ranges, release and settle mixed, done indices skipped, chunked); released indices restoring step room; digest mode (slots stored and deleted at final, count above 8); and a fuzz test of INV-2, INV-8 and INV-12 over reserve, settle and finalize.
- Named tests (`security-and-testing.md` §3.7): RV-001, RV-002, RV-056 rows.
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICzarVault} from "../src/interfaces/ICzarVault.sol";
import {CzarVault} from "../src/CzarVault.sol";
import {
    MIN_RESERVATION_TTL,
    MAX_RESERVATION_TTL,
    MAX_AUTHORIZATIONS_PER_RESERVATION,
    MAX_DIGEST_MODE_COUNT,
    FINALIZE_CHUNK
} from "../src/libraries/CzarConstants.sol";
import {CzarHashing} from "../src/libraries/CzarHashing.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";
import {CzarVaultHarness} from "./helpers/CzarVaultHarness.sol";
import {PayeeTree} from "./helpers/PayeeTree.sol";

/// @dev 07 PRD 06 (T-015). czar-vault.md §5.3, §6.5, §8.2, §15; INV-5, INV-8, INV-12, INV-13.
contract ReserveTest is VaultTestBase, PayeeTree {
    bytes32 internal constant CATEGORY = keccak256("category.research");
    uint64 internal constant LIFETIME = 1 days;
    uint64 internal constant TTL = 300; // between MIN_RESERVATION_TTL and MAX_RESERVATION_TTL

    CzarVaultHarness internal hv;
    uint64 internal env; // envelope of `vault`

    function setUp() public override {
        super.setUp();
        hv = CzarVaultHarness(
            payable(vaultFactory.deployCode(abi.encodePacked(type(CzarVaultHarness).creationCode, abi.encode(owner))))
        );
        env = _openEnvelope(vault, 2 * ONE_USDC, ONE_USDC);
    }

    // ───────────── Helpers ─────────────

    function _openEnvelope(ICzarVault v, uint256 cap, uint256 maxStep) internal returns (uint64 id) {
        usdc.mint(address(v), cap);
        ICzarVault.OpenEnvelopeParams memory p;
        p.cap = cap;
        p.maxStepAmount = maxStep;
        p.expiresAt = uint64(block.timestamp + LIFETIME);
        p.categoryId = CATEGORY;
        p.objectiveHash = keccak256("objective");
        p.planHash = keccak256("plan");
        p.payeeRoot = PAYEE_ROOT;
        vm.prank(owner);
        id = v.openEnvelope(p);
    }

    function _reserve(ICzarVault v, uint64 id, address payee, uint256 unit, uint32 count) internal returns (uint64) {
        bytes32[] memory proof = payee == PAYEE_BEEF ? _proofBeef() : _proofCafe();
        uint64 validBefore = uint64(block.timestamp + TTL);
        vm.prank(agent);
        return v.reserve(id, STEP_X402, payee, STEP_X402_CAP, proof, unit, count, validBefore);
    }

    /// @dev Simulates the payee settling index `i` through USDC (the authorization is consumed, money moves).
    function _use(ICzarVault v, uint64 rid, uint32 i) internal {
        ICzarVault.Reservation memory r = v.getReservation(rid);
        bytes32 nonce = v.derivedNonce(rid, i);
        usdc.consumeAuthorizationForTest(address(v), r.payee, r.unitAmount, nonce);
    }

    function _indices(uint32 from, uint32 to) internal pure returns (uint32[] memory a) {
        a = new uint32[](to - from);
        for (uint32 i = from; i < to; i++) {
            a[i - from] = i;
        }
    }

    function _expectReserveRevert(
        bytes memory err,
        uint64 id,
        address payee,
        uint256 cap,
        uint256 unit,
        uint32 count,
        uint64 vb
    ) internal {
        bytes32[] memory proof = _proofBeef();
        vm.prank(agent);
        vm.expectRevert(err);
        vault.reserve(id, STEP_X402, payee, cap, proof, unit, count, vb);
    }

    // ───────────── derivedNonce ─────────────

    function test_derivedNonce_vector() public {
        address v = vaultFactory.deployCodeAt(
            address(0xc2a21), abi.encodePacked(type(CzarVault).creationCode, abi.encode(owner))
        );
        assertEq(
            CzarVault(payable(v)).derivedNonce(12, 3),
            0x1f7eb762975d3148f76637d5498c320aa01d5daa71be09a5e6ca4947371fd59f
        );
    }

    // ───────────── reserve: happy path ─────────────

    function test_reserve_storesAndBooks() public {
        uint64 vb = uint64(block.timestamp + TTL);
        bytes32[] memory proof = _proofBeef();
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Reserved(1, env, PAYEE_BEEF, STEP_X402, 100_000, 4, vb, 0);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.StepUsed(env, STEP_X402, 400_000);
        vm.prank(agent);
        uint64 rid = vault.reserve(env, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, proof, 100_000, 4, vb);
        assertEq(rid, 1);
        assertEq(vault.reservationCount(), 1);
        ICzarVault.Reservation memory r = vault.getReservation(rid);
        assertEq(r.envelopeId, env);
        assertEq(r.stepIndex, STEP_X402);
        assertEq(r.payee, PAYEE_BEEF);
        assertEq(r.unitAmount, 100_000);
        assertEq(r.count, 4);
        assertEq(r.validBefore, vb);
        assertEq(uint8(r.mode), uint8(ICzarVault.ReservationMode.Envelope));
        assertEq(uint8(r.state), uint8(ICzarVault.ReservationState.Active));
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.reserved, 400_000);
        assertEq(e.openReservations, 1);
        assertEq(vault.stepUsed(env, STEP_X402), 400_000);
        assertEq(vault.committedTotal(), 2 * ONE_USDC); // reserving does not change committedTotal
    }

    function test_reserve_maxCount128() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 1, uint32(MAX_AUTHORIZATIONS_PER_RESERVATION));
        assertEq(vault.getReservation(rid).count, 128);
    }

    // ───────────── reserve: every error ─────────────

    function test_reserve_notAgent_reverts() public {
        bytes32[] memory proof = _proofBeef();
        uint64 vb = uint64(block.timestamp + TTL);
        vm.prank(owner);
        vm.expectRevert(ICzarVault.NotAgent.selector);
        vault.reserve(env, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, proof, 1, 1, vb);
    }

    function test_reserve_frozen_reverts() public {
        vm.prank(owner);
        vault.freeze();
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.FrozenVault.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
    }

    function test_reserve_paused_reverts() public {
        vaultFactory.setGuardianPaused(true);
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.Paused.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
    }

    function test_reserve_envelopeNotOpen_reverts() public {
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.EnvelopeNotOpen.selector),
            99,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
        vm.prank(owner);
        vault.closeEnvelope(env);
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.EnvelopeNotOpen.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
    }

    function test_reserve_envelopeExpired_reverts() public {
        vm.warp(block.timestamp + LIFETIME);
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.EnvelopeExpired.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
    }

    function test_reserve_pocketStepIndex_reverts() public {
        bytes32[] memory proof = _proofBeef();
        uint64 vb = uint64(block.timestamp + TTL);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.reserve(env, type(uint32).max, PAYEE_BEEF, STEP_X402_CAP, proof, 1, 1, vb);
    }

    function test_reserve_zeroUnitAmount_reverts() public {
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.BadParams.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            0,
            1,
            uint64(block.timestamp + TTL)
        );
    }

    /// @dev RV-002 named test.
    function test_reserve_stepCapAboveMaxStepAmount_reverts() public {
        uint64 small = _openEnvelope(vault, ONE_USDC, ONE_USDC - 1); // maxStepAmount below the leaf's stepCap
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.BadParams.selector),
            small,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
    }

    function test_reserve_badCount_reverts() public {
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.BadCount.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            0,
            uint64(block.timestamp + TTL)
        );
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.BadCount.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            129,
            uint64(block.timestamp + TTL)
        );
    }

    function test_reserve_ttlBounds_revertBadTtl() public {
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.BadTtl.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + MIN_RESERVATION_TTL - 1)
        );
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.BadTtl.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + MAX_RESERVATION_TTL + 1)
        );
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 1, 1); // TTL inside the bounds works
        assertEq(rid, 1);
    }

    /// @dev RV-056 named test.
    function test_reserve_validBeforeAfterEnvelopeExpiry_reverts() public {
        vm.warp(block.timestamp + LIFETIME - 100); // envelope expires in 100 s
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.BadTtl.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + 101)
        );
    }

    function test_reserve_payeeNotInPlan_reverts() public {
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.PayeeNotInPlan.selector),
            env,
            makeAddr("unknown"),
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.PayeeNotInPlan.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP - 1,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
        // the job leaf (kind 2) cannot be used for an x402 reservation
        bytes32[] memory proof = _proofD00d();
        uint64 vb = uint64(block.timestamp + TTL);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.PayeeNotInPlan.selector);
        vault.reserve(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, 1, 1, vb);
    }

    /// @dev RV-002 named test.
    function test_reserve_sameStepTwice_revertsStepCapExceeded() public {
        _reserve(vault, env, PAYEE_BEEF, 250_000, 4); // uses the whole 1,000,000 step cap
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.StepCapExceeded.selector, STEP_X402, STEP_X402_CAP, STEP_X402_CAP, 1),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
    }

    /// @dev RV-002 named test: an alternate payee of the same step shares one step cap.
    function test_reserve_alternatePayee_sharesStepCap() public {
        _reserve(vault, env, PAYEE_BEEF, 300_000, 2); // 600,000
        bytes32[] memory proof = _proofCafe();
        uint64 vb = uint64(block.timestamp + TTL);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(ICzarVault.StepCapExceeded.selector, STEP_X402, 600_000, STEP_X402_CAP, 500_000)
        );
        vault.reserve(env, STEP_X402, PAYEE_CAFE, STEP_X402_CAP, proof, 250_000, 2, vb);
        _reserve(vault, env, PAYEE_CAFE, 200_000, 2); // 400,000 fits exactly
        assertEq(vault.stepUsed(env, STEP_X402), STEP_X402_CAP);
    }

    function test_reserve_envelopeCap_revertsCapExceeded() public {
        usdc.mint(address(hv), 5 * ONE_USDC);
        uint64 id = _openEnvelope(hv, ONE_USDC, ONE_USDC);
        hv.exposed_simulateFundedPocket(id, makeAddr("pocket"), 600_000); // room left: 400,000
        bytes32[] memory proof = _proofBeef();
        uint64 vb = uint64(block.timestamp + TTL);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.CapExceeded.selector);
        hv.reserve(id, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, proof, 100_000, 5, vb);
    }

    // ───────────── settle ─────────────

    function test_settle_usedIndices_bookSpent() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 100_000, 4);
        _use(vault, rid, 0);
        _use(vault, rid, 2);
        uint32[] memory idx = new uint32[](2);
        idx[0] = 0;
        idx[1] = 2;
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Settled(rid, 0, 100_000);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Settled(rid, 2, 100_000);
        vm.prank(stranger); // anyone may settle
        vault.settle(rid, idx);
        ICzarVault.Reservation memory r = vault.getReservation(rid);
        assertEq(r.settledCount, 2);
        assertEq(r.settledMask, 5);
        assertEq(r.doneMask, 5);
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.spent, 200_000);
        assertEq(e.reserved, 200_000);
        assertEq(vault.committedTotal(), 2 * ONE_USDC - 200_000);
        assertEq(vault.stepUsed(env, STEP_X402), 400_000); // unchanged: spent on the step
        assertEq(usdc.balanceOf(PAYEE_BEEF), 200_000);
        assertEq(vault.freeBalance(), 0); // balance and committed fell together (INV-2)
    }

    function test_settle_notUsed_reverts() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 100_000, 4);
        uint32[] memory idx = _indices(1, 2);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.NotUsed.selector, 1));
        vault.settle(rid, idx);
    }

    function test_settle_twice_revertsAlreadyDone() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 100_000, 4);
        _use(vault, rid, 1);
        uint32[] memory idx = _indices(1, 2);
        vault.settle(rid, idx);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.AlreadyDone.selector, 1));
        vault.settle(rid, idx);
        uint32[] memory dup = new uint32[](2); // the same index twice in one call
        _use(vault, rid, 3);
        dup[0] = 3;
        dup[1] = 3;
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.AlreadyDone.selector, 3));
        vault.settle(rid, dup);
    }

    function test_settle_badIndices_revertBadParams() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 1_000, 40);
        uint32[] memory none = new uint32[](0);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.settle(rid, none);
        uint32[] memory tooMany = _indices(0, uint32(FINALIZE_CHUNK) + 1);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.settle(rid, tooMany);
        uint32[] memory outOfRange = _indices(40, 41);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.settle(rid, outOfRange);
    }

    function test_settle_unknownReservation_reverts() public {
        uint32[] memory idx = _indices(0, 1);
        vm.expectRevert(ICzarVault.ReservationNotActive.selector);
        vault.settle(7, idx);
    }

    /// @dev RV-001 named test.
    function test_settleAllIndices_reservationFinal_envelopeCloses() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 10_000, 10);
        for (uint32 i = 0; i < 10; i++) {
            _use(vault, rid, i);
        }
        uint32[] memory idx = _indices(0, 10);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.ReservationFinal(rid, 10, 0);
        vault.settle(rid, idx);
        assertEq(uint8(vault.getReservation(rid).state), uint8(ICzarVault.ReservationState.Final));
        assertEq(vault.getEnvelope(env).openReservations, 0);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.EnvelopeClosed(env, 100_000, 2 * ONE_USDC - 100_000);
        vm.prank(owner);
        vault.closeEnvelope(env);
        vm.expectRevert(ICzarVault.ReservationNotActive.selector);
        vault.settle(rid, _indices(0, 1)); // Final reservations refuse settle
    }

    // ───────────── finalize ─────────────

    function test_finalize_beforeValidBefore_revertsNotExpired() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 100_000, 4);
        vm.warp(vault.getReservation(rid).validBefore); // equal is still not expired
        vm.expectRevert(ICzarVault.NotExpired.selector);
        vault.finalize(rid, 0, 4);
    }

    function test_finalize_badRange_revertsBadParams() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 1_000, 40);
        vm.warp(vault.getReservation(rid).validBefore + 1);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.finalize(rid, 4, 4);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.finalize(rid, 0, 41);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.finalize(rid, 0, uint32(FINALIZE_CHUNK) + 1);
    }

    function test_finalize_releasesUnusedAndSettlesUsed() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 100_000, 4);
        _use(vault, rid, 1);
        vm.warp(vault.getReservation(rid).validBefore + 1);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Released(rid, 0, 100_000);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Settled(rid, 1, 100_000);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Released(rid, 2, 100_000);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Released(rid, 3, 100_000);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.StepUsed(env, STEP_X402, 100_000);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.ReservationFinal(rid, 1, 3);
        vm.prank(stranger);
        vault.finalize(rid, 0, 4);
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.reserved, 0);
        assertEq(e.spent, 100_000);
        assertEq(e.openReservations, 0);
        assertEq(vault.committedTotal(), 2 * ONE_USDC - 100_000); // releases stay committed to the envelope
    }

    /// @dev RV-001 named test.
    function test_finalize_skipsDoneIndices() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 10_000, 10);
        for (uint32 i = 0; i < 5; i++) {
            _use(vault, rid, i);
        }
        vault.settle(rid, _indices(0, 5));
        vm.warp(vault.getReservation(rid).validBefore + 1);
        vault.finalize(rid, 0, 10);
        ICzarVault.Reservation memory r = vault.getReservation(rid);
        assertEq(r.settledCount, 5);
        assertEq(r.releasedCount, 5);
        assertEq(uint8(r.state), uint8(ICzarVault.ReservationState.Final));
    }

    function test_finalize_chunked_finalAfterLastChunk() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 1_000, 100);
        vm.warp(vault.getReservation(rid).validBefore + 1);
        vault.finalize(rid, 0, 32);
        assertEq(uint8(vault.getReservation(rid).state), uint8(ICzarVault.ReservationState.Finalizing));
        vault.finalize(rid, 32, 64);
        vault.finalize(rid, 64, 96);
        assertEq(vault.getEnvelope(env).openReservations, 1);
        vault.finalize(rid, 96, 100);
        assertEq(uint8(vault.getReservation(rid).state), uint8(ICzarVault.ReservationState.Final));
        assertEq(vault.getEnvelope(env).openReservations, 0);
        assertEq(vault.stepUsed(env, STEP_X402), 0);
    }

    /// @dev RV-002 named test.
    function test_releasedIndices_restoreStepRoom() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 250_000, 4); // the whole step cap
        _use(vault, rid, 0);
        vm.warp(vault.getReservation(rid).validBefore + 1);
        vault.finalize(rid, 0, 4); // 1 settled, 3 released → 750,000 free on the step again
        assertEq(vault.stepUsed(env, STEP_X402), 250_000);
        _reserve(vault, env, PAYEE_CAFE, 250_000, 3);
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.StepCapExceeded.selector, STEP_X402, STEP_X402_CAP, STEP_X402_CAP, 1),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
    }

    // ───────────── digest mode ─────────────

    function test_reserveWithDigests_storesSlotsAndCleansUp() public {
        uint64 id = _openEnvelope(hv, 2 * ONE_USDC, ONE_USDC);
        bytes32[] memory proof = _proofBeef();
        uint64 vb = uint64(block.timestamp + TTL);
        vm.prank(agent);
        uint64 rid = hv.reserveWithDigests(id, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, proof, 50_000, 3, vb);
        assertEq(uint8(hv.getReservation(rid).mode), uint8(ICzarVault.ReservationMode.Digest));
        for (uint32 i = 0; i < 3; i++) {
            bytes32 expected = CzarHashing.typedDataHash(
                hv.exposed_usdcDomainSeparator(),
                CzarHashing.transferWithAuthorizationHash(
                    address(hv), PAYEE_BEEF, 50_000, 0, vb, hv.derivedNonce(rid, i)
                )
            );
            assertEq(hv.exposed_usdcDigest(rid, i), expected);
            (uint64 r, uint32 index, bool set) = hv.exposed_digestSlot(expected);
            assertEq(r, rid);
            assertEq(index, i);
            assertTrue(set);
        }
        vm.warp(vb + 1);
        hv.finalize(rid, 0, 3);
        for (uint32 i = 0; i < 3; i++) {
            (,, bool set) = hv.exposed_digestSlot(hv.exposed_usdcDigest(rid, i));
            assertFalse(set); // deleted when the reservation became Final (§15.11)
        }
    }

    function test_reserveWithDigests_countAbove8_revertsBadCount() public {
        bytes32[] memory proof = _proofBeef();
        uint64 vb = uint64(block.timestamp + TTL);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.BadCount.selector);
        vault.reserveWithDigests(
            env, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, proof, 1, uint32(MAX_DIGEST_MODE_COUNT) + 1, vb
        );
    }

    // ───────────── Fuzz: INV-8, INV-12, INV-13 and INV-2 over reserve, settle, finalize ─────────────

    function testFuzz_reserveSettleFinalize_invariants(uint8 countSeed, uint32 unitSeed, uint256 usedMask) public {
        uint32 count = uint32(bound(countSeed, 1, 64));
        uint256 unit = bound(unitSeed, 1, STEP_X402_CAP / count);
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, unit, count);
        uint256 used;
        for (uint32 i = 0; i < count; i++) {
            if ((usedMask >> i) & 1 == 1) {
                _use(vault, rid, i);
                used++;
            }
        }
        vm.warp(vault.getReservation(rid).validBefore + 1);
        for (uint32 from = 0; from < count; from += uint32(FINALIZE_CHUNK)) {
            uint32 to = from + uint32(FINALIZE_CHUNK) > count ? count : from + uint32(FINALIZE_CHUNK);
            vault.finalize(rid, from, to);
        }
        ICzarVault.Reservation memory r = vault.getReservation(rid);
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(r.settledCount, used);
        assertEq(r.settledCount + r.releasedCount, count);
        assertEq(uint8(r.state), uint8(ICzarVault.ReservationState.Final)); // INV-13
        assertEq(e.openReservations, 0);
        assertEq(e.reserved, 0); // INV-8
        assertEq(e.spent, used * unit);
        assertEq(vault.stepUsed(env, STEP_X402), used * unit); // INV-12
        assertEq(vault.committedTotal(), e.cap - e.spent); // INV-2
        assertEq(usdc.balanceOf(address(vault)), vault.committedTotal()); // nothing free, nothing lost
    }
}
```

## 10. Build steps (tests first)
1. Do §7 (replace `MockArcUSDC.sol` and `CzarVaultHarness.sol`, create `PayeeTree.sol`) and create `test/ReserveTest.t.sol` (§9).
2. Run `FOUNDRY_PROFILE=arc arc-forge test --match-path test/ReserveTest.t.sol`. Expected: `1 passed; 32 failed`. `test_derivedNonce_vector` passes (PRD 03 built `derivedNonce`); every failure mentions `NotBuilt()`. Paste the summary line into your report.
3. Write `src/vault/logic/ReservationLogic.sol` from §8.
4. Do §5 (delete the 4 stubs) and §6 (replace `CzarVault.sol`).
5. Run the test file again: 33 passed.
6. `arc-forge fmt src/vault/logic/ReservationLogic.sol src/vault/VaultStubs.sol`, then `arc-forge fmt --check` on those two files and every other file in §4: nothing printed apart from the flag notice.
7. Run the clean gate build and the full suite (00-conventions §2.2).

## 11. Definition of done
- `FOUNDRY_PROFILE=arc arc-forge test --match-contract ReserveTest` → 33 passed, 0 failed (T-015 acceptance command; it includes `PayeeNotInPlan`, `StepCapExceeded`, `CapExceeded`, `BadTtl`, `BadCount`, `NotUsed`, `AlreadyDone`, `NotExpired`).
- `FOUNDRY_PROFILE=arc arc-forge test` → 204 passed, 0 failed.
- `rm -rf out cache && FOUNDRY_PROFILE=arc arc-forge build --deny-warnings --sizes` → no warnings; `CzarVault` runtime about 11,657 B and `ReservationLogic` about 6,595 B (more than 300 B off means your code differs from §6 or §8).
- `grep -c "revert NotBuilt" src/vault/VaultStubs.sol` → 17.
- `diff -r src/interfaces ../docs/specs/03-smart-contracts/interfaces` → nothing.

## 12. Stop conditions
- A test fails after you have compared the function with its numbered steps in §8: stop and report the test name and failure line. Never change a test, the mock or the harness.
- "Stack too deep" in `ReservationLogic`: check that `reserve` only calls `_checkReserve` and `_storeReservation` with the `ReserveRequest` struct (§8.2). If it still fails, stop and report the line.

## Change log
| Date | Change |
|---|---|
| 2026-10-20 | First version (D89 library layout), verified on Arc Foundry v0.8.0-2 against a reference implementation. |
