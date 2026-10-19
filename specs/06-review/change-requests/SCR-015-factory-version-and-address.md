# SCR-015: The factory's version register cannot work as described, its caller rules disagree, and predicted vault addresses change when untimelocked defaults change.

| Field | Value |
|---|---|
| ID | SCR-015 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `specs/03-smart-contracts/czar-vault-factory.md` §2 (line 14), §5 (lines 48, 51, 53); `security-and-testing.md` (lines 33, 95); FAC-3; specs/03-smart-contracts/czar-vault.md (line 486) |
| Status | Open |
| Review finding | RV-015 (High) in `specs/06-review/2026-10-19-spec-review.md` |

## Problem
- `new CzarVault{…}` deploys bytecode compiled into the factory. A factory cannot deploy code it only knows by hash, so registering a `creationCodeHash` protects nothing and a "new registered bytecode" route cannot be built.
- §5 has no voucher; §2 and §5 disagree on who may call.
- `defaults` are constructor arguments, so they are part of the CREATE2 init code. `setDefaults` has no timelock, so `predictVault` changes whenever it runs. The app shows the predicted address before deployment.
- "no timelock for the first version" contradicts FAC-3 ("no earlier than `queuedAt + ADMIN_TIMELOCK`").
- `czar-vault.md` line 486 claims the same vault address on both networks, but the constructor arguments differ per network.

## Evidence
- `createVault`: "deploy `new CzarVault{salt: keccak256(abi.encode(ownerAccount, salt))}(ownerAccount, defaults, network immutables, address(this))`".
- `queueVersion(bytes32 creationCodeHash)` / `applyVersion(changeId)` … timelock.
- §2 line 14: "only `owner == msg.sender` or a Czar-signed onboarding voucher (§5)"; §5 line 48: "`ownerAccount` itself …, or Czar's onboarding relayer".
- `security-and-testing.md` line 95: "registers `creationCodeHash` of `CzarVault` version 1 (no timelock for the first version)".
- `setDefaults` row (line 53): admin, "none zero", no timelock. K20's blast radius in spec 01 does not list it.
- Failure scenario:
  1. A K20 compromise calls `setDefaults` with attacker K3/K5. Every vault created after that gets attacker signers, with no 48 h warning.
  2. A user funds the predicted address shown during onboarding; `setDefaults` runs before `createVault`; the deployed vault lands elsewhere and the funded address has no code.
  3. A coding agent cannot satisfy FAC-3 and deployment step 3 at once.

## Proposed change
- Either pass creation code to `createVault` and check its hash against `currentVersion`, or drop the version register and say upgrades need a new factory.
- Specify one caller rule (owner or relayer) and remove the voucher wording, or define the voucher.
- Keep `defaults` out of the init code (set them in an initializer) so the address depends only on owner and version; timelock `setDefaults` and list it in K20's blast radius.
- State the first-version exception in FAC-3; drop the same-address claim or move network values to an initializer.

## Affected tasks
- T-012, T-027, T-082 (M1, M6)

## Decision
- <filled in by Zaryab: accepted or rejected, and why>
