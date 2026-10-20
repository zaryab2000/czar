# 00 — Conventions for every contract PRD

- **Read this file before any other PRD in this folder.** Every PRD assumes it.
- **Applies to:** all Solidity work under `contracts/` for Phase 1 (tasks T-012 to T-027, T-105).
- **Status:** 2026-10-20. Changes to this file are logged at the end.

---

## 1. How to use a PRD

### 1.1 What a PRD is
- A PRD turns one part of the contract spec (`docs/specs/03-smart-contracts/`) into exact build steps.
- The spec is the authority. The PRD quotes it and cites the section for every rule (for example "spec: `czar-vault.md` §5.3").
- The PRD never adds behaviour the spec does not have. If you see a rule in a PRD with no spec citation, treat it as a mistake and stop (§1.4).

### 1.2 Order of work inside a PRD
1. Read the PRD's **Scope** and **Dependencies**. If a dependency is not done, stop and say so.
2. Read every file listed under **Sources**. Read nothing else unless a step tells you to.
3. Do the **Build steps** in order. Never skip a step or reorder steps.
4. In each step: write the listed tests first, run them and see them fail, then write the code, then run them and see them pass.
5. Run the **Definition of done** commands. Paste their output into your task report.

### 1.3 Precedence when two sources disagree
1. `docs/specs/03-smart-contracts/interfaces/*.sol` (canonical ABI: names, argument order, events, errors; RV-060).
2. The spec text in `docs/specs/03-smart-contracts/*.md`.
3. Shared types and hashes in `docs/specs/02-data-and-protocol/data-and-protocol.md` §5–§7 and `vectors/eip712-vectors.json`.
4. The PRD.
- If any two of these disagree, **stop** and file a spec change request (§1.4). Do not pick one yourself.

### 1.4 When to stop and file a spec change request (SCR)
Stop work on the affected item and file an SCR when:
- a PRD step and the spec disagree;
- a function, field, event, error, constant or value you need is missing from the spec and the PRD;
- a test listed in the PRD cannot pass without changing behaviour the spec defines;
- the contract would exceed a size or gas limit in a way the PRD does not cover;
- an external contract (USDC, Gateway, ERC-8183) behaves differently from the spec or the mock.

How to file:
- Copy the template in `docs/specs/05-build-plan/spec-change-request-template.md`.
- Save it as `docs/specs/06-review/change-requests/SCR-<next number>-<short-slug>.md` (this is where SCR-101 onward already live).
- Continue only with work the problem does not touch. Never edit anything under `docs/`.

---

## 2. Toolchain and commands

### 2.1 Tools (already installed by T-003)
- Arc Foundry only: `arc-forge`, `arc-cast`, `arc-anvil` from the checksummed release (`scripts/install-arc-foundry.sh`).
- **Never** use standard `forge`, `anvil`, `foundryup` or `foundry-toolchain`.
- Solidity `0.8.30`, `evm_version = "prague"`, optimizer on (`contracts/foundry.toml`). Do not change these.
- Libraries (git submodules under `contracts/lib/`): `openzeppelin-contracts` v5.7.0, `forge-std`. Do not add other libraries.

### 2.2 Commands (run from `contracts/`)

| Purpose | Command | Must show |
|---|---|---|
| Build with size report | `FOUNDRY_PROFILE=arc arc-forge build --deny-warnings --sizes` | no warnings; every contract's runtime size under 24,576 bytes and initcode under 49,152 bytes |
| All tests | `FOUNDRY_PROFILE=arc arc-forge test -vvv` | `0 failed` |
| One test file | `FOUNDRY_PROFILE=arc arc-forge test -vvv --match-path test/<File>.t.sol` | `0 failed` |
| One test | `FOUNDRY_PROFILE=arc arc-forge test -vvv --match-test <testName>` | `[PASS]` |
| Format your files | `arc-forge fmt <each file you created or changed>` | rewrites layout only; run after pasting PRD code (PRD code blocks are not pre-formatted to 120 columns) |
| Format check | `arc-forge fmt --check <each file you created or changed>` | no output |
| Gas report | `FOUNDRY_PROFILE=arc arc-forge test --gas-report --match-path test/<File>.t.sol` | a table (used in PRD 12) |
| Interface copies match spec | `diff -r src/interfaces ../docs/specs/03-smart-contracts/interfaces` (from `contracts/`) | no output (CI runs this) |

- CI (`.github/workflows/ci.yml`) runs three of these: the interface diff, the build with sizes, and all tests. Run the rest yourself. A task is not done until CI is green and your own runs pass.
- Never run `arc-forge fmt` with no path. It would reformat `src/interfaces/*.sol`, which must stay byte-identical to the spec copies, and the CI diff would fail.

### 2.3 Interface files
- `contracts/src/interfaces/*.sol` must be **byte-identical** copies of `docs/specs/03-smart-contracts/interfaces/*.sol`. CI fails on any difference.
- Never edit an interface file in `contracts/src/interfaces/`. If an interface must change, file an SCR.

---

## 3. File layout

```
contracts/
  src/
    interfaces/                 copies of the spec interfaces (never edited)
    libraries/                  pure / view libraries (PRD 01)
      CzarConstants.sol
      SatMath.sol
      CzarHashing.sol
      PayeeLeaf.sol
      CzarNonces.sol
      PasskeyVerifier.sol
      JobEscrowAdapter.sol        (PRD 09)
    vault/                      the vault, split by topic into abstract contracts (PRDs 04–10)
      VaultStorage.sol
      VaultCore.sol
      VaultEnvelopes.sol
      VaultReservations.sol
      VaultSignatures.sol
      VaultPockets.sol
      VaultJobs.sol
      VaultAutonomy.sol
      VaultOwnerActions.sol
      CzarVault.sol               the only concrete vault contract
    CzarVaultFactory.sol         (PRD 03)
    OpenEvidenceLog.sol          (already built, T-011; PRD 02 checks it)
  test/
    mocks/                      already built (T-010); extend only where a PRD says so
    helpers/                    shared test setup (PRD 04 creates VaultTestBase.sol)
    unit/                       one file per vault module: Vault<Topic>.t.sol
    invariant/                  handlers and invariant suites (PRD 12)
    fork/                       fork tests against Arc testnet (PRD 12)
  script/                       deployment scripts (PRD 13)
```

- **Why the vault is split into abstract contracts:** each PRD builds one file; the concrete `CzarVault` inherits them all. Inheritance does not change the deployed bytecode size. If the size is too big, PRD 11 moves selected `library` code to linked external libraries.
- Each abstract vault file inherits `VaultStorage` (directly or through another module), never declares storage of its own, and never has a constructor.

---

## 4. Solidity style

### 4.1 Header of every file
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
```
- Pragma is exact (`0.8.30`), never `^0.8.30`.

### 4.2 Imports
- Named imports only: `import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";`.
- Relative paths for project files: `import {SatMath} from "../libraries/SatMath.sol";`.

### 4.3 Naming

| Item | Style | Example |
|---|---|---|
| Contracts, libraries, structs, enums, events, errors | PascalCase | `VaultEnvelopes`, `EnvelopeOpened`, `StepCapExceeded` |
| Functions, variables, parameters | camelCase | `openEnvelope`, `stepUsed`, `envelopeId` |
| Constants and immutables | UPPER_SNAKE_CASE | `MAX_AUTHORIZATIONS_PER_RESERVATION`, `USDC` |
| Internal / private functions | leading underscore | `_finalizeIfDone`, `_requireAgent` |
| Storage mappings whose names the spec gives | exactly the spec name | `envelopes`, `reservations`, `pockets`, `pullbacks`, `jobs`, `limits`, `stepUsed`, `digestSlot` |

- Use the spec's names for every function, event, error, constant, struct field and storage variable. Never rename.

### 4.4 NatSpec
- Every external or public function in a concrete or abstract contract: `/// @inheritdoc ICzarVault` (or the matching interface).
- Every internal function: one `/// @dev` line saying what it does and citing the spec section.
- Every storage variable and constant: one `/// @dev` line with the spec citation.

### 4.5 Errors and reverts
- Use custom errors only. Never `require(cond, "string")`, never `revert("string")`.
- Use the exact error and argument order from the interface.
- Pattern:
  ```solidity
  if (amount > free) revert InsufficientFree(free, amount);
  ```
- Check order inside a function is binding: the PRD numbers the checks; implement them in that order, so the first failing check decides the error. Tests assert the specific error.

### 4.6 Events
- Emit the exact event from the interface with arguments in interface order.
- Emit after the state change it reports and before any external call, unless the PRD says otherwise.
- Tests check every event with `vm.expectEmit(true, true, true, true, address(vault))`.

### 4.7 Checks, effects, interactions
- Order inside every function: checks → state changes → external calls → event (unless the PRD gives a different order with a reason).
- Every function that calls USDC, the GatewayWallet, the GatewayMinter, the job escrow, or sends native value is `nonReentrant` (OpenZeppelin `ReentrancyGuardTransient`; spec: `czar-vault.md` §4).
- `view` functions never use `nonReentrant`.

### 4.8 Arithmetic
- All amounts are USDC 6-decimal integers (`uint256`). Never 18-decimal values, except the single native send in `grantPocketGas`, which multiplies by `GAS_GRANT_UNIT_WEI` (PRD 08).
- No floating point, no division before multiplication. Basis points use `BPS = 10_000`; round down unless the PRD says otherwise.
- Use `SatMath.sat(a, b)` (returns `a > b ? a - b : 0`) only where the PRD says "saturating". Everywhere else use plain `-` and let Solidity 0.8 revert on underflow: that revert is a bug signal and must never be reachable in tests.
- Use `unchecked` only where the PRD says so, with a comment proving it cannot overflow.

### 4.9 Storage
- All vault storage lives in `VaultStorage.sol` (PRD 04), in the order the PRD gives. Do not reorder variables or struct fields; slot order is fixed so the storage layout test (PRD 04) stays stable.
- Struct field types are exactly as the PRD gives (`uint64`, `uint32`, `uint128`, …). Do not widen or narrow them.
- Mappings are `internal` in storage and exposed only through the interface's view functions.

### 4.10 Things you must never do
- No `tx.origin`, no `block.prevrandao` (always 0 on Arc), no `selfdestruct`, no `delegatecall` except through a linked library (PRD 11), no assembly except where a PRD gives the exact code.
- No `payable` functions except `receive()` in the vault.
- No loops whose bound is not a named constant (`FINALIZE_CHUNK`, `MAX_AUTHORIZATIONS_PER_RESERVATION`, `MAX_DIGEST_MODE_COUNT`).
- No owner-less admin functions, no upgrade hooks, no proxy patterns in the vault (D33).
- No new public or external function that is not in the interface.

### 4.11 Compiler traps (each one was hit while checking these PRDs with solc 0.8.30)
| Trap | Wrong | Right |
|---|---|---|
| Address literals must be checksummed | `0x00000000000000000000000000000000000c2a21` (compile error) | `address(0xc2a21)` for short test addresses; copy long addresses with their mixed case exactly as the PRD prints them |
| Division of an odd literal is a fraction | `0xFF…4141 / 2` (compile error: fixed-point type) | `uint256(0xFF…4141) / 2` |
| More than about 12 values in one `abi.encode`, `abi.encodePacked` or `bytes.concat` | "Stack too deep" (the repo does not use `via_ir`; do not turn it on) | split into two calls and concatenate: `bytes.concat(abi.encode(a, …, f), abi.encode(g, …, n))`. For static 32-byte values this gives the same bytes as one call. PRD code already does this |
| NatSpec on a file-level constant | `/// text` (an implicit `@notice`: compile error) | `/// @dev text` or `// text` |

---

## 5. Tests

### 5.1 Framework and layout
- `forge-std` `Test`. Unit tests in `test/unit/`, invariant suites in `test/invariant/`, fork tests in `test/fork/`.
- Every test file starts with a `/// @notice` line naming the task and the PRD section it covers.
- Shared setup for the vault lives in `test/helpers/VaultTestBase.sol` (built in PRD 04 and extended by later PRDs). It deploys the mocks, a factory and one vault, and exposes helpers such as `_openEnvelopeAsOwner(...)` and `_payeeProof(...)`.

### 5.2 Test names
- `test_<function>_<condition>_<expectedResult>`, for example `test_withdraw_aboveFree_revertsInsufficientFree`.
- Named regression tests in `docs/specs/03-smart-contracts/security-and-testing.md` §3.7 and §3.7a keep **exactly** that name.
- Fuzz tests: `testFuzz_<function>_<property>`. Invariants: `invariant_<name>` in a contract named `<Topic>Invariants`.

### 5.3 What every function needs
For every external function the PRD lists:
- one happy-path test that checks every state change and every event;
- one test per error the function can raise, asserting the exact error with arguments: `vm.expectRevert(abi.encodeWithSelector(ICzarVault.InsufficientFree.selector, free, amount));`;
- one access test per role that must be refused (`NotOwner`, `NotAgent`, `NotAuthorized`);
- where the function is gated by freeze or pause: one test frozen and one test paused.

### 5.4 Time, blocks and chain id in tests
- Start every test at `vm.warp(1_792_000_000)` and `vm.roll(68_000_000)` unless the PRD gives other values, so times are after the vectors' dates.
- Chain id: `vm.chainId(5042002)` in `VaultTestBase.setUp()` so domain separators match the testnet vectors in `eip712-vectors.json`.

### 5.5 Mocks
- Use the existing mocks in `test/mocks/`: `MockUSDC3009`, `MockGatewayWallet`, `MockGatewayMinter`, `MockCircleAgenticCommerce`, `MockCzarJobEscrow`.
- Place a mock at a fixed real address with forge-std's `deployCodeTo`, never `vm.etch`. `deployCodeTo` runs the constructor at that address, so storage the constructor sets (the mock's `controller`) exists there. `vm.etch` copies runtime code only; `controller` would stay `address(0)` and every `mint` would revert.
  - USDC: `deployCodeTo("MockUSDC3009.sol:MockUSDC3009", USDC_ADDRESS);` then `MockUSDC3009(USDC_ADDRESS).mint(...)`. The test contract is the controller.
  - Gateway Wallet, Gateway Minter and the job escrows reach the vault as constructor values (through the factory's `networkConfig()`), not as constants, so deploy them with `new` at any address. PRD 04 gives the exact setup code.
- `test/MockSelfTest.t.sol` uses `vm.etch` for a view-only check; that is fine there and must not be copied into vault tests.
- Extend a mock only when a PRD step says so, and only with the function named.

---

## 6. Task report (end of every task)
Copy this block into your report and fill it in:

```
Task: T-0xx <title>  (PRD: 07-contract-build/<file> §<n>)
Files changed: <list>
Commands run and results:
  FOUNDRY_PROFILE=arc arc-forge build --deny-warnings --sizes   → <paste the size lines for changed contracts>
  FOUNDRY_PROFILE=arc arc-forge test -vvv                        → <N passed, 0 failed>
  arc-forge fmt --check <files you changed>                      → <no output>
  diff -r src/interfaces ../docs/specs/03-smart-contracts/interfaces → <no output>
Named tests added: <list>
SCRs filed: <none | SCR-1xx …>
Open issues / could not verify: <list>
```

---

## Change log

| Date | Change |
|---|---|
| 2026-10-20 | First version. |
| 2026-10-20 | §2.2: format only your own files; say which commands CI runs. §4.11 compiler traps. §5.5: `deployCodeTo` instead of `vm.etch` for the USDC mock. |
