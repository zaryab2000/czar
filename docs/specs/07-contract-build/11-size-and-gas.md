# 11 — Size and gas gate

## 1. Scope
- **Task:** T-020 (size build and the D42 library split; the split itself is already in place from PRD 03, D89).
- **You build:**
  - `contracts/test/SizeTest.t.sol` (§6): the EIP-170 and EIP-3860 limits as a test, so CI fails the day a change pushes the vault or the factory over.
  - `contracts/SIZE.md` (§7): the measured sizes of the vault, the factory and the eight logic libraries, the limit from G0-08, and the measured gas per vault function (the "measured gas table" `czar-vault.md` §13 asks for).
- **You change no contract.** If a number is off, the code differs from an earlier PRD: find the difference, do not trim code here.
- **Dependencies:**
  - PRD 10 done (402 tests; `grep -rn NotBuilt src/` prints nothing).
  - Gate check **G0-08** recorded in `docs/specs/05-build-plan/gate-0-results/G0-08.md` (`gate-0-checks.md` §G0-08; read-only). It records Arc's real contract size limit. If it is not recorded, run it first.

## 2. This PRD is already verified
- `SizeTest` passed on **Arc Foundry v0.8.0-2** with `FOUNDRY_PROFILE=arc` against the reference vault (404 tests in total), and the numbers in §7 come from that reference's clean build and gas report.

## 3. Sources (read these, nothing else)
- `07-contract-build/00-conventions.md` §2.2 (clean gate build, gas report).
- `docs/specs/03-smart-contracts/czar-vault.md` §13 (gas table and routing inputs), §15.12 (size rule).
- `docs/specs/03-smart-contracts/czar-vault-factory.md` §11 (factory size rule, measured sizes).
- `docs/specs/05-build-plan/gate-0-checks.md` §G0-08 and its recorded result.
- `docs/product/decisions-log.md` D42, D88 item 10, D89.

## 4. Files
| File | Action | Section |
|---|---|---|
| `contracts/test/SizeTest.t.sol` | create | §6 |
| `contracts/SIZE.md` | create | §7 |

## 5. The rule
- Runtime size of `CzarVault`, `CzarVaultFactory` and each of the eight logic libraries ≤ the limit G0-08 recorded (24,576 bytes on a standard EVM, EIP-170).
- Initcode of `CzarVault` and `CzarVaultFactory` ≤ 49,152 bytes (EIP-3860). The factory's initcode holds the vault's creation code twice (its runtime and the `VAULT_CREATION_CODE_HASH` computation), so it is the largest initcode.
- If G0-08 recorded a limit **below** 24,576 bytes and any number in §7.1 is above it: stop and file an SCR (00-conventions §1.4); do not trim code.

## 6. `test/SizeTest.t.sol`
- Two tests: the vault's runtime (deployed by `VaultTestBase`) and creation code, and a factory deployed in the test (runtime and creation code), each against the EIP-170 and EIP-3860 limits as named constants.
- Library sizes are not in the test (forge does not expose a linked library's deployed address to the test); the clean build's `--sizes` table checks them, and CI fails the build if one is over.
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CzarVault} from "../src/CzarVault.sol";
import {CzarVaultFactory} from "../src/CzarVaultFactory.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";

/// @dev 07 PRD 11 (T-020). The EIP-170 and EIP-3860 limits as a test, so CI fails the moment a change pushes the
///      vault or the factory over (czar-vault.md §15.12, czar-vault-factory.md §11, D89). The logic libraries are
///      checked by `arc-forge build --sizes`.
contract SizeTest is VaultTestBase {
    uint256 internal constant MAX_RUNTIME_SIZE = 24_576; // EIP-170
    uint256 internal constant MAX_INITCODE_SIZE = 49_152; // EIP-3860

    function test_vault_runtimeAndInitcodeUnderLimits() public view {
        assertLe(address(vault).code.length, MAX_RUNTIME_SIZE);
        assertLe(type(CzarVault).creationCode.length, MAX_INITCODE_SIZE);
    }

    function test_factory_runtimeAndInitcodeUnderLimits() public {
        CzarVaultFactory f =
            new CzarVaultFactory(_networkConfig(), _defaults(), makeAddr("guardian"), makeAddr("admin"));
        assertLe(address(f).code.length, MAX_RUNTIME_SIZE);
        assertLe(type(CzarVaultFactory).creationCode.length, MAX_INITCODE_SIZE);
    }
}
```

## 7. `contracts/SIZE.md`
- Create the file with the structure below. Fill every number from **your** runs (the clean build's `--sizes` table and the gas report of §8 step 3); the reference numbers are printed so you can compare. Any size more than 300 B away from the reference means a code difference in an earlier PRD: stop and report it.

### 7.1 Size table (reference values)
| Contract | Runtime (B) | Initcode (B) | Runtime headroom to 24,576 B |
|---|---|---|---|
| `CzarVault` | 14,540 | 16,233 | 10,036 |
| `CzarVaultFactory` | 20,747 | 38,225 | 3,829 |
| `CoreLogic` | 2,921 | 2,973 | 21,655 |
| `EnvelopeLogic` | 3,985 | 4,037 | 20,591 |
| `ReservationLogic` | 6,595 | 6,647 | 17,981 |
| `SignatureLogic` | 6,300 | 6,352 | 18,276 |
| `PocketLogic` | 9,353 | 9,405 | 15,223 |
| `JobLogic` | 11,867 | 11,919 | 12,709 |
| `AutonomyLogic` | 2,727 | 2,779 | 21,849 |
| `OwnerActionLogic` | 9,405 | 9,457 | 15,171 |

- The factory has the least headroom (3,829 B). Every byte added to the vault's runtime adds about one byte to the factory's runtime; a vault change that adds more than about 3.8 KB to `CzarVault` itself (not to a library) breaks the factory.

### 7.2 Gas table (reference values, median from the unit-test gas report, cold storage)
| Function | Median gas | `czar-vault.md` §13 estimate |
|---|---|---|
| `openEnvelope` | 210,966 | 160,000 |
| `closeEnvelope` | 48,182 | 40,000 |
| `reserve` | 223,986 | 132,000 |
| `reserveWithDigests` | 179,168 | 324,000 (n = 8) |
| `settle` | 54,611 | 30,000 + 6,000k |
| `finalize` | 185,638 | 30,000 + 7,000k |
| `isValidSignature` | 21,053 | — |
| `registerPocket` | 97,485 | 62,000 |
| `grantPocketGas` | 43,474 | 40,000 |
| `fundPocket` | 201,235 | 130,000 |
| `requestPullback` | 224,275 | 120,000 |
| `confirmPullback` | 69,838 | 50,000 |
| `writeOffPocket` | 62,226 | 35,000 |
| `openJob` | 448,797 | 252,000 |
| `fundJob` | 196,516 | 150,000 |
| `syncJob` | 88,687 | 55,000 |
| `executeOwnerAction` | 84,610 | 40,000 + 6,900 + action |
| `createVault` (factory) | 3,120,732 | ≈ 2,500,000 |

- **Why measured gas is above the estimates:** every first write to a record is a cold `SSTORE` (22,100 gas each in these tests), and each vault call pays about 6,000 gas for the `DELEGATECALL` into its library and the copied arguments (D89). `openJob` includes the escrow's own `createJob`, which stores the 69-character description. The §13 estimates predate D89 and were never measured; the server's routing uses the measured table (§13: "measured values replace them").
- Write one line under the table: "Routing inputs (`G_reserve`, `G_settleBase`, `G_settleIdx`, `G_finalize`) come from this table, not from the §13 estimates." The server task that reads them is outside M1.

### 7.3 Limit and decision
- The G0-08 limit, with the path of its record.
- One line: "D89: the vault's logic is in eight linked libraries from 07 PRD 03 on; no further split is needed."

## 8. Build steps
1. Create `test/SizeTest.t.sol` (§6). Run `FOUNDRY_PROFILE=arc arc-forge test --match-contract SizeTest`: 2 passed.
2. Run the clean gate build: `rm -rf out cache && FOUNDRY_PROFILE=arc arc-forge build --deny-warnings --sizes`. Copy the rows for the ten contracts of §7.1.
3. Run the gas report: `FOUNDRY_PROFILE=arc arc-forge test --gas-report --no-match-contract "Invariant|MockSelf|Libraries|OpenEvidence"`. Copy the median of each function in §7.2 from the `CzarVault` and `CzarVaultFactory` tables.
4. Write `contracts/SIZE.md` (§7) with your numbers.
5. `arc-forge fmt --check test/SizeTest.t.sol`: nothing printed apart from the flag notice.
6. Run the full suite.

## 9. Definition of done
- `FOUNDRY_PROFILE=arc arc-forge test --match-contract SizeTest` → 2 passed.
- `FOUNDRY_PROFILE=arc arc-forge test` → 404 passed, 0 failed.
- `rm -rf out cache && FOUNDRY_PROFILE=arc arc-forge build --deny-warnings --sizes` → no warnings, exit code 0, and every row of §7.1 within 300 B of the reference.
- `contracts/SIZE.md` exists with the three parts of §7.
- T-020 acceptance: both runtimes and every library ≤ the G0-08 limit; both initcodes ≤ 49,152 B; all tests from T-011 to T-019 pass.

## 10. Stop conditions
- Any size more than 300 B from the reference, or any size over the G0-08 limit: stop and report the row. Never edit a contract in this PRD.
- G0-08 is not recorded and you cannot run it (it needs the testnet RPC): stop and report it.

## Change log
| Date | Change |
|---|---|
| 2026-10-20 | First version. The split it was planned for is already done (D89); this PRD is now the size and gas record and its regression test. |
