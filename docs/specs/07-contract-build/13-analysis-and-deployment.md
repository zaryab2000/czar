# 13 — Static analysis and deployment

## 1. Scope
- **Tasks:**
  - **T-025:** Slither, the banned-construct grep, the triage file and the CI commands.
  - **T-027:** the CREATE2 deployment script for the eight logic libraries, `OpenEvidenceLog` and `CzarVaultFactory`, run and checked on a local `arc-anvil`.
- **Not in this PRD (each needs Zaryab's written approval, CLAUDE.md):**
  - **T-105, the server keys.** Created on Zaryab's Mac into the signer keystore; the passphrase comes from the macOS keychain. This PRD only fixes the shape of the file T-105 writes (§7.1), because the deploy script reads it.
  - **The testnet broadcast.** It spends testnet funds. §8 gives the exact command for when the approval exists.
- **You change no contract.** If Slither reports a High or Medium finding that is not in §5's allowlist, stop and report it (§11).
- **Dependencies:**
  - PRD 12 is done: 419 tests pass.
  - `pip install slither-analyzer==0.11.3` works on the machine (this needs PyPI access).

## 2. This PRD is already verified
- **Slither 0.11.3** ran on the reference build. It reported 42 findings: 2 High, 10 Medium and 30 Low. All 42 are false positives or orders the spec requires, and each has a reason in §5. The gate printed `slither gate: 42 findings, all triaged`.
- **The deployment ran on a local `arc-anvil --network arc` (chain 31337).**
  - The three passes linked all eight libraries.
  - Ten contracts were deployed through the Arachnid deployer.
  - `factoryRuntimeHash` equals `keccak256` of the deployed code.
  - `guardianPaused()` is `false`, and `defaults()` equals the keys file.
  - `createVault` gave a vault whose `freeze()` (a `CoreLogic` call through the linked library) worked.
  - A second run printed `exists` ten times and `No transactions to broadcast`.
  - Against a chain with id 5042, the script reverted `Deploy: Arc testnet or local arc-anvil only`.

## 3. Sources (read these, nothing else)
- `07-contract-build/00-conventions.md` §2 (commands), §2.4 (lint).
- `docs/specs/03-smart-contracts/security-and-testing.md` §3.6 (static analysis), §4 steps 1–4 (deployment).
- `docs/specs/03-smart-contracts/czar-vault-factory.md` §3 (`FACTORY_SALT`, `CREATE2_DEPLOYER`), §11 (linked libraries, reproducible profile).
- `docs/specs/03-smart-contracts/czar-vault.md` §14 (testnet immutables).
- `docs/specs/05-build-plan/phase-1-tasks.md` T-025, T-027, T-105.
- `CLAUDE.md` "Keys, secrets and networks".

## 4. Files
| File | Action | Section |
|---|---|---|
| `contracts/slither.config.json` | create | §5 |
| `contracts/slither-allowlist.json` | create | §5 |
| `contracts/SLITHER-TRIAGE.md` | create | §5 |
| `contracts/script/slither_gate.py` | create | §5 |
| `contracts/foundry.toml` | edit: add `[profile.deploy]` | §6 |
| `contracts/script/Deploy.s.sol` | create | §6 |
| `contracts/script/deploy.sh` | create (executable) | §6 |
| `deployments/local-keys.json` | create | §7 |
| `.gitignore` (repository root) | add three lines | §7 |

## 5. Static analysis (T-025)

### 5.1 How it runs
- **Slither reads the compiled artifacts and does not run the compiler itself** (`foundry_ignore_compile`). So the binary may be called `arc-forge`, and no `forge` needs to be on `PATH`.
- Commands, from `contracts/`:
```bash
rm -rf out cache && FOUNDRY_PROFILE=arc arc-forge build --build-info --skip test
slither . --config-file slither.config.json --json slither-out.json   # exits non-zero when it finds anything; that is expected
python3 script/slither_gate.py slither-out.json slither-allowlist.json
grep -rnE 'tx\.origin|prevrandao|block\.difficulty' src && exit 1 || true
```
- **The gate** fails when a finding is not in the allowlist, or is listed without a reason. A finding that is no longer reported prints as `stale allowlist entry`; remove that entry.
- **CI:** add the four lines above to the contracts job of the CI workflow (T-002), after the test step. Install Slither first: `pip install slither-analyzer==0.11.3`.

### 5.2 `slither.config.json`
```json
{
  "filter_paths": "test/|lib/|script/",
  "exclude_informational": true,
  "exclude_optimization": true,
  "foundry_ignore_compile": true
}
```

### 5.3 `script/slither_gate.py`
- It identifies each finding by its detector and by the first function or variable it names (`Contract.function`), so line moves do not break the list.
```python
#!/usr/bin/env python3
"""T-025 gate (07 PRD 13): every Slither finding must be listed, with a reason, in slither-allowlist.json.

Usage (from contracts/): python3 script/slither_gate.py slither-out.json slither-allowlist.json
Exit 0 when every finding is listed; exit 1 and print the unlisted ones otherwise. Stale allowlist
entries (no longer reported) are printed as a warning so the list can be pruned.
"""
import json
import sys


def identity(result):
    """check + Contract.function (or variable) of the first function or variable element."""
    for element in result["elements"]:
        if element["type"] in ("function", "variable"):
            parent = element.get("type_specific_fields", {}).get("parent", {}).get("name", "")
            return f'{result["check"]}:{parent}.{element["name"]}'
    return f'{result["check"]}:?'


def main(out_path, allow_path):
    with open(out_path) as f:
        findings = json.load(f)["results"].get("detectors", [])
    with open(allow_path) as f:
        allowed = {f'{e["check"]}:{e["element"]}': e for e in json.load(f)["findings"]}
    seen = set()
    unlisted = []
    for result in findings:
        key = identity(result)
        seen.add(key)
        if key not in allowed or not allowed[key].get("reason"):
            unlisted.append(f'{result["impact"]:13} {key}')
    for key in sorted(set(allowed) - seen):
        print(f"stale allowlist entry (not reported any more): {key}")
    if unlisted:
        print("Slither findings without a triage reason:")
        print("\n".join(sorted(set(unlisted))))
        return 1
    print(f"slither gate: {len(findings)} findings, all triaged")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
```

### 5.4 `slither-allowlist.json`
- **42 findings in 39 entries**, because some functions are reported more than once.
- **Every reason cites the spec rule that makes the code correct.** None of them is "accepted risk": the High and Medium entries are all false positives or required orders.
  - `arbitrary-send-eth` on `grantPocketGas`: the recipient is a proven pocket leaf.
  - `uninitialized-state` on a mapping: false positive.
  - `divide-before-multiply` on the ABI word padding: intended rounding.
  - The strict equality: it compares period numbers, not balances.
  - The `false` default of `ok`: intended.
  - `unused-return`: unused tuple fields.
  - `reentrancy-events`: these are the §15.5 order (event after the external call) behind `nonReentrant`.
```json
{
  "slither": "0.11.3",
  "findings": [
    {
      "check": "arbitrary-send-eth",
      "element": "PocketLogic.grantPocketGas",
      "impact": "High",
      "reason": "Not arbitrary: the recipient is a registered pocket (proven as a kind-4 leaf of the envelope's payeeRoot, INV-14), the caller is the agent, the amount is capped by MAX_GAS_GRANT_PER_POCKET and the envelope cap, and the send is the native gas grant the spec requires (czar-vault.md §5.4, RV-004)."
    },
    {
      "check": "uninitialized-state",
      "element": "OpenEvidenceLog._log",
      "impact": "High",
      "reason": "False positive: `_log` is a mapping; mappings need no initialisation, and every slot starts empty by design (open-evidence-log.md §6)."
    },
    {
      "check": "divide-before-multiply",
      "element": "SignatureLogic._slLayoutOk",
      "impact": "Medium",
      "reason": "Intended rounding: `(l + 31) / 32 * 32` pads the string length to a whole ABI word, exactly as the czar-vault.md §6 layout table defines (672 + 32 × ⌈L / 32⌉)."
    },
    {
      "check": "incorrect-equality",
      "element": "EnvelopeLogic.openEnvelope",
      "impact": "Medium",
      "reason": "`l.periodId == periodId` compares two period numbers (block.timestamp / PERIOD_LENGTH), not balances; equality is the intended test of whether the allowance belongs to the current period (czar-vault.md §5.6)."
    },
    {
      "check": "uninitialized-local",
      "element": "isValidSignature.ok",
      "impact": "Medium",
      "reason": "Intended default: `ok` starts false, so an unknown kind or a short signature returns EIP1271_INVALID (czar-vault.md §6, never revert)."
    },
    {
      "check": "unused-return",
      "element": "AutonomyLogic.raiseAutoLimit",
      "impact": "Medium",
      "reason": "The ignored values are fields this function does not need from a multi-value return (escrow tuple fields, tryRecover's error value checked through the recovered address, or a dispatched function's id the owner action does not use); every value that drives a decision is read and checked."
    },
    {
      "check": "unused-return",
      "element": "JobEscrowAdapter.readBudget",
      "impact": "Medium",
      "reason": "The ignored values are fields this function does not need from a multi-value return (escrow tuple fields, tryRecover's error value checked through the recovered address, or a dispatched function's id the owner action does not use); every value that drives a decision is read and checked."
    },
    {
      "check": "unused-return",
      "element": "JobEscrowAdapter.readOutcome",
      "impact": "Medium",
      "reason": "The ignored values are fields this function does not need from a multi-value return (escrow tuple fields, tryRecover's error value checked through the recovered address, or a dispatched function's id the owner action does not use); every value that drives a decision is read and checked."
    },
    {
      "check": "unused-return",
      "element": "JobLogic.cancelJob",
      "impact": "Medium",
      "reason": "The ignored values are fields this function does not need from a multi-value return (escrow tuple fields, tryRecover's error value checked through the recovered address, or a dispatched function's id the owner action does not use); every value that drives a decision is read and checked."
    },
    {
      "check": "unused-return",
      "element": "JobLogic.claimJobRefund",
      "impact": "Medium",
      "reason": "The ignored values are fields this function does not need from a multi-value return (escrow tuple fields, tryRecover's error value checked through the recovered address, or a dispatched function's id the owner action does not use); every value that drives a decision is read and checked."
    },
    {
      "check": "unused-return",
      "element": "JobLogic.syncJob",
      "impact": "Medium",
      "reason": "The ignored values are fields this function does not need from a multi-value return (escrow tuple fields, tryRecover's error value checked through the recovered address, or a dispatched function's id the owner action does not use); every value that drives a decision is read and checked."
    },
    {
      "check": "unused-return",
      "element": "OwnerActionLogic._dispatch",
      "impact": "Medium",
      "reason": "The ignored values are fields this function does not need from a multi-value return (escrow tuple fields, tryRecover's error value checked through the recovered address, or a dispatched function's id the owner action does not use); every value that drives a decision is read and checked."
    },
    {
      "check": "unused-return",
      "element": "VaultGuards.agentSigned",
      "impact": "Medium",
      "reason": "The ignored values are fields this function does not need from a multi-value return (escrow tuple fields, tryRecover's error value checked through the recovered address, or a dispatched function's id the owner action does not use); every value that drives a decision is read and checked."
    },
    {
      "check": "calls-loop",
      "element": "ReservationLogic._authorizationUsed",
      "impact": "Low",
      "reason": "Bounded: settle and finalize take at most FINALIZE_CHUNK (32) indices per call, and the call is a view read of USDC's authorizationState (czar-vault.md §5.3)."
    },
    {
      "check": "missing-zero-check",
      "element": "grantPocketGas.pocket",
      "impact": "Low",
      "reason": "A pocket must be registered first, and registerPocket rejects address(0) (ZeroAddress); the same reason as the forge-lint comment on grantPocketGas (07 PRD 08 §7.3)."
    },
    {
      "check": "reentrancy-events",
      "element": "JobLogic._storeJob",
      "impact": "Low",
      "reason": "The event comes after the external call on purpose: czar-vault.md §15.5 fixes the order checks, effects, external call, event. The wrapper is nonReentrant (§15.5), all state is written before the call, and the escrow, Gateway and USDC addresses are immutables."
    },
    {
      "check": "reentrancy-events",
      "element": "JobLogic.cancelJob",
      "impact": "Low",
      "reason": "The event comes after the external call on purpose: czar-vault.md §15.5 fixes the order checks, effects, external call, event. The wrapper is nonReentrant (§15.5), all state is written before the call, and the escrow, Gateway and USDC addresses are immutables."
    },
    {
      "check": "reentrancy-events",
      "element": "JobLogic.claimJobRefund",
      "impact": "Low",
      "reason": "The event comes after the external call on purpose: czar-vault.md §15.5 fixes the order checks, effects, external call, event. The wrapper is nonReentrant (§15.5), all state is written before the call, and the escrow, Gateway and USDC addresses are immutables."
    },
    {
      "check": "reentrancy-events",
      "element": "JobLogic.fundJob",
      "impact": "Low",
      "reason": "The event comes after the external call on purpose: czar-vault.md §15.5 fixes the order checks, effects, external call, event. The wrapper is nonReentrant (§15.5), all state is written before the call, and the escrow, Gateway and USDC addresses are immutables."
    },
    {
      "check": "reentrancy-events",
      "element": "OwnerActionLogic.executeOwnerAction",
      "impact": "Low",
      "reason": "The event comes after the external call on purpose: czar-vault.md §15.5 fixes the order checks, effects, external call, event. The wrapper is nonReentrant (§15.5), all state is written before the call, and the escrow, Gateway and USDC addresses are immutables."
    },
    {
      "check": "reentrancy-events",
      "element": "PocketLogic.fundPocket",
      "impact": "Low",
      "reason": "The event comes after the external call on purpose: czar-vault.md §15.5 fixes the order checks, effects, external call, event. The wrapper is nonReentrant (§15.5), all state is written before the call, and the escrow, Gateway and USDC addresses are immutables."
    },
    {
      "check": "reentrancy-events",
      "element": "PocketLogic.grantPocketGas",
      "impact": "Low",
      "reason": "The event comes after the external call on purpose: czar-vault.md §15.5 fixes the order checks, effects, external call, event. The wrapper is nonReentrant (§15.5), all state is written before the call, and the escrow, Gateway and USDC addresses are immutables."
    },
    {
      "check": "timestamp",
      "element": "AutonomyLogic.raiseAutoLimit",
      "impact": "Low",
      "reason": "Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded)."
    },
    {
      "check": "timestamp",
      "element": "CzarVaultFactory._consume",
      "impact": "Low",
      "reason": "Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded)."
    },
    {
      "check": "timestamp",
      "element": "EnvelopeLogic.closeEnvelope",
      "impact": "Low",
      "reason": "Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded)."
    },
    {
      "check": "timestamp",
      "element": "EnvelopeLogic.forceCloseEnvelope",
      "impact": "Low",
      "reason": "Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded)."
    },
    {
      "check": "timestamp",
      "element": "EnvelopeLogic.openEnvelope",
      "impact": "Low",
      "reason": "Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded)."
    },
    {
      "check": "timestamp",
      "element": "JobLogic._checkFundJob",
      "impact": "Low",
      "reason": "Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded)."
    },
    {
      "check": "timestamp",
      "element": "JobLogic._checkOpenJob",
      "impact": "Low",
      "reason": "Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded)."
    },
    {
      "check": "timestamp",
      "element": "JobLogic._syncOpened",
      "impact": "Low",
      "reason": "Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded)."
    },
    {
      "check": "timestamp",
      "element": "JobLogic.claimJobRefund",
      "impact": "Low",
      "reason": "Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded)."
    },
    {
      "check": "timestamp",
      "element": "OwnerActionLogic.executeOwnerAction",
      "impact": "Low",
      "reason": "Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded)."
    },
    {
      "check": "timestamp",
      "element": "PocketLogic.fundPocket",
      "impact": "Low",
      "reason": "Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded)."
    },
    {
      "check": "timestamp",
      "element": "PocketLogic.grantPocketGas",
      "impact": "Low",
      "reason": "Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded)."
    },
    {
      "check": "timestamp",
      "element": "PocketLogic.registerPocket",
      "impact": "Low",
      "reason": "Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded)."
    },
    {
      "check": "timestamp",
      "element": "ReservationLogic._checkReserve",
      "impact": "Low",
      "reason": "Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded)."
    },
    {
      "check": "timestamp",
      "element": "ReservationLogic.finalize",
      "impact": "Low",
      "reason": "Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded)."
    },
    {
      "check": "timestamp",
      "element": "SignatureLogic._checkFallback",
      "impact": "Low",
      "reason": "Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded)."
    },
    {
      "check": "timestamp",
      "element": "SignatureLogic._checkUsdc3009",
      "impact": "Low",
      "reason": "Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded)."
    }
  ]
}
```

### 5.5 `SLITHER-TRIAGE.md`
- The same entries as a table, for people reading the repository.
```markdown
# Slither triage (T-025)

- Tool: Slither 0.11.3 (pinned), run on the `arc-forge build --build-info` output (`slither.config.json`).
- Gate: `python3 script/slither_gate.py slither-out.json slither-allowlist.json` fails on any finding not listed below with a reason.
- High and Medium: 0 unresolved. Every entry below is a false positive or an order the spec requires; no code change is pending.

| Impact | Detector | Where | Reason |
|---|---|---|---|
| High | `arbitrary-send-eth` | `PocketLogic.grantPocketGas` | Not arbitrary: the recipient is a registered pocket (proven as a kind-4 leaf of the envelope's payeeRoot, INV-14), the caller is the agent, the amount is capped by MAX_GAS_GRANT_PER_POCKET and the envelope cap, and the send is the native gas grant the spec requires (czar-vault.md §5.4, RV-004). |
| High | `uninitialized-state` | `OpenEvidenceLog._log` | False positive: `_log` is a mapping; mappings need no initialisation, and every slot starts empty by design (open-evidence-log.md §6). |
| Medium | `divide-before-multiply` | `SignatureLogic._slLayoutOk` | Intended rounding: `(l + 31) / 32 * 32` pads the string length to a whole ABI word, exactly as the czar-vault.md §6 layout table defines (672 + 32 × ⌈L / 32⌉). |
| Medium | `incorrect-equality` | `EnvelopeLogic.openEnvelope` | `l.periodId == periodId` compares two period numbers (block.timestamp / PERIOD_LENGTH), not balances; equality is the intended test of whether the allowance belongs to the current period (czar-vault.md §5.6). |
| Medium | `uninitialized-local` | `isValidSignature.ok` | Intended default: `ok` starts false, so an unknown kind or a short signature returns EIP1271_INVALID (czar-vault.md §6, never revert). |
| Medium | `unused-return` | `AutonomyLogic.raiseAutoLimit` | The ignored values are fields this function does not need from a multi-value return (escrow tuple fields, tryRecover's error value checked through the recovered address, or a dispatched function's id the owner action does not use); every value that drives a decision is read and checked. |
| Medium | `unused-return` | `JobEscrowAdapter.readBudget` | The ignored values are fields this function does not need from a multi-value return (escrow tuple fields, tryRecover's error value checked through the recovered address, or a dispatched function's id the owner action does not use); every value that drives a decision is read and checked. |
| Medium | `unused-return` | `JobEscrowAdapter.readOutcome` | The ignored values are fields this function does not need from a multi-value return (escrow tuple fields, tryRecover's error value checked through the recovered address, or a dispatched function's id the owner action does not use); every value that drives a decision is read and checked. |
| Medium | `unused-return` | `JobLogic.cancelJob` | The ignored values are fields this function does not need from a multi-value return (escrow tuple fields, tryRecover's error value checked through the recovered address, or a dispatched function's id the owner action does not use); every value that drives a decision is read and checked. |
| Medium | `unused-return` | `JobLogic.claimJobRefund` | The ignored values are fields this function does not need from a multi-value return (escrow tuple fields, tryRecover's error value checked through the recovered address, or a dispatched function's id the owner action does not use); every value that drives a decision is read and checked. |
| Medium | `unused-return` | `JobLogic.syncJob` | The ignored values are fields this function does not need from a multi-value return (escrow tuple fields, tryRecover's error value checked through the recovered address, or a dispatched function's id the owner action does not use); every value that drives a decision is read and checked. |
| Medium | `unused-return` | `OwnerActionLogic._dispatch` | The ignored values are fields this function does not need from a multi-value return (escrow tuple fields, tryRecover's error value checked through the recovered address, or a dispatched function's id the owner action does not use); every value that drives a decision is read and checked. |
| Medium | `unused-return` | `VaultGuards.agentSigned` | The ignored values are fields this function does not need from a multi-value return (escrow tuple fields, tryRecover's error value checked through the recovered address, or a dispatched function's id the owner action does not use); every value that drives a decision is read and checked. |
| Low | `calls-loop` | `ReservationLogic._authorizationUsed` | Bounded: settle and finalize take at most FINALIZE_CHUNK (32) indices per call, and the call is a view read of USDC's authorizationState (czar-vault.md §5.3). |
| Low | `missing-zero-check` | `grantPocketGas.pocket` | A pocket must be registered first, and registerPocket rejects address(0) (ZeroAddress); the same reason as the forge-lint comment on grantPocketGas (07 PRD 08 §7.3). |
| Low | `reentrancy-events` | `JobLogic._storeJob` | The event comes after the external call on purpose: czar-vault.md §15.5 fixes the order checks, effects, external call, event. The wrapper is nonReentrant (§15.5), all state is written before the call, and the escrow, Gateway and USDC addresses are immutables. |
| Low | `reentrancy-events` | `JobLogic.cancelJob` | The event comes after the external call on purpose: czar-vault.md §15.5 fixes the order checks, effects, external call, event. The wrapper is nonReentrant (§15.5), all state is written before the call, and the escrow, Gateway and USDC addresses are immutables. |
| Low | `reentrancy-events` | `JobLogic.claimJobRefund` | The event comes after the external call on purpose: czar-vault.md §15.5 fixes the order checks, effects, external call, event. The wrapper is nonReentrant (§15.5), all state is written before the call, and the escrow, Gateway and USDC addresses are immutables. |
| Low | `reentrancy-events` | `JobLogic.fundJob` | The event comes after the external call on purpose: czar-vault.md §15.5 fixes the order checks, effects, external call, event. The wrapper is nonReentrant (§15.5), all state is written before the call, and the escrow, Gateway and USDC addresses are immutables. |
| Low | `reentrancy-events` | `OwnerActionLogic.executeOwnerAction` | The event comes after the external call on purpose: czar-vault.md §15.5 fixes the order checks, effects, external call, event. The wrapper is nonReentrant (§15.5), all state is written before the call, and the escrow, Gateway and USDC addresses are immutables. |
| Low | `reentrancy-events` | `PocketLogic.fundPocket` | The event comes after the external call on purpose: czar-vault.md §15.5 fixes the order checks, effects, external call, event. The wrapper is nonReentrant (§15.5), all state is written before the call, and the escrow, Gateway and USDC addresses are immutables. |
| Low | `reentrancy-events` | `PocketLogic.grantPocketGas` | The event comes after the external call on purpose: czar-vault.md §15.5 fixes the order checks, effects, external call, event. The wrapper is nonReentrant (§15.5), all state is written before the call, and the escrow, Gateway and USDC addresses are immutables. |
| Low | `timestamp` | `AutonomyLogic.raiseAutoLimit` | Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded). |
| Low | `timestamp` | `CzarVaultFactory._consume` | Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded). |
| Low | `timestamp` | `EnvelopeLogic.closeEnvelope` | Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded). |
| Low | `timestamp` | `EnvelopeLogic.forceCloseEnvelope` | Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded). |
| Low | `timestamp` | `EnvelopeLogic.openEnvelope` | Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded). |
| Low | `timestamp` | `JobLogic._checkFundJob` | Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded). |
| Low | `timestamp` | `JobLogic._checkOpenJob` | Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded). |
| Low | `timestamp` | `JobLogic._syncOpened` | Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded). |
| Low | `timestamp` | `JobLogic.claimJobRefund` | Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded). |
| Low | `timestamp` | `OwnerActionLogic.executeOwnerAction` | Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded). |
| Low | `timestamp` | `PocketLogic.fundPocket` | Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded). |
| Low | `timestamp` | `PocketLogic.grantPocketGas` | Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded). |
| Low | `timestamp` | `PocketLogic.registerPocket` | Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded). |
| Low | `timestamp` | `ReservationLogic._checkReserve` | Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded). |
| Low | `timestamp` | `ReservationLogic.finalize` | Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded). |
| Low | `timestamp` | `SignatureLogic._checkFallback` | Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded). |
| Low | `timestamp` | `SignatureLogic._checkUsdc3009` | Every time comparison is a spec rule on windows of seconds to days (czar-vault.md §15.7, czar-vault-factory.md §5); validator timestamp skew on Arc cannot change an outcome (D88; the same reason forge-lint's block-timestamp is excluded). |

## Banned constructs (`security-and-testing.md` §3.6)
- `grep -rnE 'tx\.origin|prevrandao|block\.difficulty' src` prints nothing.
```

## 6. Deployment (T-027)

### 6.1 Why three passes
- **The vault and the factory bytecode contain the eight library addresses (D89).** Each library is deployed with CREATE2 and the salt `keccak256("czar.lib.<Name>.v1")`, so its address depends on its own code.
  - Seven libraries link nothing.
  - `OwnerActionLogic` links five of them, so its code, and therefore its address, is known only after those five are linked.
- **`script/deploy.sh` runs:**
  1. **Pass 1:** `predictLibraries(0, 7)` prints the seven addresses as `--libraries` entries.
  2. **Pass 2:** the same call, with those seven linked, prints `OwnerActionLogic`'s address.
  3. **Pass 3:** with all eight linked, `run` deploys the libraries, then `OpenEvidenceLog`, then the factory, checks it and writes the record.
- This is the one place in the project where `--libraries` is passed by hand. 00-conventions §2.2 forbids it for builds and tests, where forge links by itself.
- **Reproducible profile:** `bytecode_hash = "none"` and `cbor_metadata = false` (czar-vault-factory.md §11). The same sources give the same addresses on every machine.

### 6.2 `foundry.toml` (append at the end)
```toml
# T-027 (07 PRD 13): the reproducible deploy profile (czar-vault-factory.md §11, D88 G-49). The same sources give the
# same bytecode, so the same CREATE2 addresses, on every build. Libraries are passed by script/deploy.sh.
[profile.deploy]
network = "arc"
bytecode_hash = "none"
cbor_metadata = false
fs_permissions = [{ access = "read", path = "../deployments" }, { access = "write", path = "../deployments" }]
```

### 6.3 `script/Deploy.s.sol`
- **Network guard:** it refuses every chain except Arc testnet (5042002) and a local `arc-anvil` (31337). Mainnet needs its own reviewed PRD (CLAUDE.md).
- **Inputs:** it reads the constructor's `defaults` (K3, K5, K7), the guardian (K6) and the admin (K20) from the keys file; never placeholders (RV-016).
- **Testnet immutables** (czar-vault.md §14):
  - USDC `0x3600…0000`
  - GatewayWallet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`
  - GatewayMinter `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`
  - domain 26
  - Circle's escrow `0x0747EEf0706327138c69792bF28Cd525089e4583`, kind 0
- **Idempotent:** an address that already has code is logged as `exists` and skipped.
- **Record:** the T-027 checks run before the record is written. The record holds every address, the chain id, the factory constructor arguments, the initcode hash, the runtime hash and `VAULT_CREATION_CODE_HASH`.
```solidity
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
```

### 6.4 `script/deploy.sh`
```bash
#!/usr/bin/env bash
# T-027 (07 PRD 13): three-pass CREATE2 deployment of the vault logic libraries, OpenEvidenceLog and CzarVaultFactory.
# Usage (from contracts/):
#   script/deploy.sh <rpc-url> <keys-file> <out-file> [extra forge args: sender and, for a dry run, nothing else]
# Local:   script/deploy.sh http://127.0.0.1:8545 ../deployments/local-keys.json ../deployments/local.json \
#            --broadcast --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
# Testnet: only after T-105 and Zaryab's written funds approval:
#          script/deploy.sh https://rpc.testnet.arc.io ../deployments/arc-testnet-keys.json \
#            ../deployments/arc-testnet.json --broadcast --account czar-deployer
# Never put a private key, passphrase or mnemonic on this command line or in the environment (D70, D78).
set -euo pipefail
FORGE="${ARC_FORGE:-arc-forge}"
RPC="$1"; KEYS="$2"; OUT="$3"; shift 3
export FOUNDRY_PROFILE=deploy

# Every library entry printed by Deploy.predictLibraries becomes a --libraries flag.
link_flags() { "$FORGE" script script/Deploy.s.sol --sig "predictLibraries(uint256,uint256)" "$1" "$2" "${LINK[@]}" "${COMPILE[@]}" \
  | sed -n 's/^ *\(src\/vault\/logic\/[A-Za-z]*\.sol:[A-Za-z]*:0x[0-9a-fA-F]\{40\}\)$/--libraries \1/p'; }

COMPILE=()
# Compiler flags (for example --use <solc> --offline) are passed through to every pass; broadcast flags only to pass 3.
while [ $# -gt 0 ]; do
  case "$1" in
    --use) COMPILE+=("$1" "$2"); shift 2 ;;
    --offline) COMPILE+=("$1"); shift ;;
    *) break ;;
  esac
done

LINK=()
read -r -a LINK <<< "$(link_flags 0 7 | tr '\n' ' ')"   # pass 1: the seven libraries that link nothing
[ "${#LINK[@]}" -eq 14 ] || { echo "deploy.sh: expected 7 library addresses" >&2; exit 1; }
read -r -a EXTRA <<< "$(link_flags 7 8 | tr '\n' ' ')"  # pass 2: OwnerActionLogic, linked to the five it calls
[ "${#EXTRA[@]}" -eq 2 ] || { echo "deploy.sh: expected the OwnerActionLogic address" >&2; exit 1; }
LINK+=("${EXTRA[@]}")

# Pass 3: everything linked; deploy (or simulate when no --broadcast is given).
"$FORGE" script script/Deploy.s.sol --sig "run(string,string)" "$KEYS" "$OUT" --rpc-url "$RPC" \
  "${LINK[@]}" "${COMPILE[@]}" "$@"
```

## 7. Keys file and ignore rules

### 7.1 The keys file shape (T-105 writes the testnet one)
- **Top level:** one object per key id (`K3`, `K5`, `K6`, `K7`, `K8`, `relayer`, `K20`, and the D83 and H7 entries).
  - Each object holds `address` (checksummed) and `ref` (the keystore's name for the key).
  - **Nothing else:** never a field named `key`, `secret`, `private` or `mnemonic` (T-105 acceptance).
- **The deploy script reads only `K3`, `K5`, `K6`, `K7` and `K20` `.address`.**
- `deployments/local-keys.json` (create it) uses anvil's well-known test accounts. They exist only on a local node and never on Arc:
```json
{
  "network": "local arc-anvil (31337); anvil's well-known test accounts, never used on Arc",
  "K3": { "address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "ref": "anvil-1" },
  "K5": { "address": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "ref": "anvil-2" },
  "K6": { "address": "0x90F79bf6EB2c4f870365E785982E1f101E93b906", "ref": "anvil-3" },
  "K7": { "address": "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", "ref": "anvil-4" },
  "K20": { "address": "0x9965507D1a55bcC2695C58ba16a1aDd5Ff1B3A8F", "ref": "anvil-5" }
}
```

### 7.2 `.gitignore` (repository root; add the lines that are missing)
```gitignore
contracts/broadcast/*/31337/
contracts/slither-out.json
deployments/local.json
```
- `contracts/broadcast/` for chain 5042002 is kept. It records the testnet transactions and holds no secrets. forge writes anything sensitive to `cache/`, which is already ignored.

## 8. Build steps
1. Install Slither 0.11.3. Create the §5 files.
2. Run the §5.1 commands. Expected: `slither gate: 42 findings, all triaged`, and the grep prints nothing.
3. Append §6.2 to `foundry.toml`; create `script/Deploy.s.sol` and `script/deploy.sh` (`chmod +x`).
4. Run `FOUNDRY_PROFILE=arc arc-forge build --deny-warnings` (the script must compile with no warnings), then the full suite: still 419 passed.
5. Create §7.1 and §7.2.
6. **Local deployment.** In a second terminal: `arc-anvil --network arc --port 8545`. Then, from `contracts/`:
```bash
script/deploy.sh http://127.0.0.1:8545 ../deployments/local-keys.json ../deployments/local.json \
  --broadcast --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```
   Expected: ten `deployed` lines, then `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`.
7. **Check the local deployment.** `F` is `CzarVaultFactory` from `../deployments/local.json`:
   - `arc-cast keccak $(arc-cast code $F --rpc-url http://127.0.0.1:8545)` equals `factoryRuntimeHash` in the record.
   - `arc-cast call $F "guardianPaused()(bool)"` → `false`.
   - `arc-cast call $F "defaults()((address,address,address))"` → the K3, K5 and K7 addresses of the keys file.
   - Create a vault and use it:
     - `arc-cast send $F "createVault(address)" 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955 --from 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --unlocked`
     - Read `V` with `arc-cast call $F "vaultOf(address)(address)" 0x14dC…9955`.
     - `arc-cast send $V "freeze()" --from 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955 --unlocked`, then `arc-cast call $V "frozen()(bool)"` → `true`.
   - Add `--rpc-url http://127.0.0.1:8545` to every command.
8. **Run step 6 again.** Expected: ten `exists` lines and `No transactions to broadcast` (idempotent).
9. **Testnet: do not run this step without Zaryab's written approval** (it spends testnet funds), and only after T-105 wrote `deployments/arc-testnet-keys.json`:
```bash
script/deploy.sh https://rpc.testnet.arc.io ../deployments/arc-testnet-keys.json ../deployments/arc-testnet.json \
  --broadcast --account czar-deployer
```
   - `--account` uses a foundry encrypted keystore and asks for its password at the prompt.
   - Never use `--private-key`, `--mnemonic` or an environment variable for the key or the password (D70, D78).
   - Then run the T-027 acceptance checks against `https://rpc.testnet.arc.io`. Verify the sources on the explorer per T-027 (keyless API, A9-10).

## 9. Definition of done
- `python3 script/slither_gate.py slither-out.json slither-allowlist.json` → `slither gate: 42 findings, all triaged` (T-025: 0 unresolved High or Medium).
- `grep -rnE 'tx\.origin|prevrandao|block\.difficulty' src` → nothing (T-025).
- `FOUNDRY_PROFILE=arc arc-forge test` → 419 passed, 0 failed.
- The local deployment, its checks and the idempotent rerun (§8 steps 6–8) pass. Paste the outputs into the report.
- `git ls-files | grep -iE 'keystore|\.key$|\.env|local\.json'` → nothing.
- The testnet step is reported as "waiting for approval" unless Zaryab approved it in writing.

## 10. Notes
- **Library addresses** on the reference build:
  - `CoreLogic` `0xfceDFC218ff0EE093c3A1ecD5C0e9714C7170A09`
  - `OwnerActionLogic` `0x604e444a1Bf0899F7C9eE844d5db155264E68302`
  - factory `0x8a3da61248D5bbA729CdC9E293E6efe7D8A16B6a`
  - Your addresses are the same only when your sources are byte-identical to the PRDs. A different address is not an error, but it means a byte differs somewhere: compare `factoryInitcodeHash` with `0x5b9264b4e17a84295fce6d4d58a21942875549ef89a48182ef24329f999e9303` and report it.
- **The factory address also depends on the keys file** (constructor arguments). The testnet factory address therefore differs from the local one.

## 11. Stop conditions
- **Slither reports a finding that is not in the allowlist.** Stop and report the finding. Never add an entry without a spec-backed reason, and never change a contract to silence Slither in this PRD.
- **Pass 1 or 2 prints fewer addresses than expected** (`deploy.sh: expected …`). Check that `out/` is from the `deploy` profile and that no library source changed, then report.
- **`run` reverts with `defaults differ from the keys file` or `CREATE2 failed`.** Report it, with the anvil log.
- **Any step would need a private key, passphrase or mnemonic on the command line or in the environment.** Stop.

## Change log
| Date | Change |
|---|---|
| 2026-10-20 | First version: Slither gate verified (42 findings triaged); three-pass CREATE2 deployment verified on a local arc-anvil. T-105 and the testnet broadcast wait for Zaryab's approval. |
