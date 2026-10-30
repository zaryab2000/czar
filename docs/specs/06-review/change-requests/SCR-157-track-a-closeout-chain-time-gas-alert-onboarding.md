# SCR-157: Track A close-out: chain time for every on-chain deadline, the gas-low signal, vault onboarding from server config

| Field | Value |
|---|---|
| ID | SCR-157 |
| Filed by | chief architect, 2026-10-30, from the builder's open items in PR #157 (exit report), #163 and #164, and items BF-3 and BF-4 |
| Spec and section | CZ-15 §5.2 steps 2, 4 and 8 (`server-planning-and-payment.md`); CZ-27 §5.5 alerts (`server-autonomy-roi-keys.md:477`); SCR-140 `AppWalletConfig` (`openapi.yaml`); CZ-22 onboarding (`app-and-notifications.md:208`, FAC-1); SCR-156 `app.origin`; cross-cutting §4 |
| Status | Accepted (Zaryab's delegation for Track A closure; recorded by his merge) |

## Why now
- Zaryab moved all manual testing to Arc testnet (SCR-155 §5). Each item below would surface as a defect in the first testnet run.
- Track B builds on these paths, so they are closed in Track A.

## 1. Chain time for every on-chain deadline (extends SCR-155 §2)
- **Rule:** every comparison CZ-15 makes against a deadline the chain enforces uses the latest block timestamp from a fresh read, never the server clock.
- **Covers:**
  - `validBefore` (already done in #163 for a new reserve)
  - the wait before `finalize` (`vault-direct.ts` `waitUntilValidBefore`)
  - the reconcile loop's expiry checks
  - call retries "within `validBefore`" (02 §7.5)
  - `envelope.expiresAt` checks made by CZ-15
- **Waiting:** a wait loop sleeps `payer.reconcileSeconds` between reads and re-reads the block timestamp each time. It never computes a sleep from the server clock alone.
- **Unchanged:** block-number deadlines (`withdrawalBlock`) already use block numbers.
- **Tests:**
  - With the chain clock 400 s **behind** the server, `finalize` is not sent until a block with `timestamp ≥ validBefore` exists.
  - With the chain clock 400 s ahead, there is no early `reserve-failed`.

## 2. Gas-low signal (CZ-27 §5.5)
- **Metric:** the signer exposes the counter `czar_signer_gas_low{key}` (key ∈ `K3`, `K7`, `K8`, `relayer`) under the cross-cutting metrics rules. Each increment also sends the existing text alert, which carries the key id and a reason code only.
- **When it increments:**
  - A refill transaction is mined, and the key's balance **read at that receipt's block** (`getBalance({blockNumber})`) is below `minAtomic`. Reading at the receipt block cannot race the key's later spending, which was the false failure #164 removed.
  - A refill attempt fails (`key-unavailable`, `balance-read-failed`, `sign-failed`, `send-failed`).
  - At the start of each pass, the relayer's balance is below the sum of every key's `targetAtomic`.
- **The refill result reports** the balance read at the receipt block, not a computed sum.
- **Alert failures never stop a pass:** a failing alert channel is caught, logged as outcome `alert-failed` with the key id, and the pass continues.
- **Interval:** the 5-minute refill interval becomes the config key `signer.gasRefillIntervalSeconds`, default 300, reason "CZ-27 §5.5 refill cadence". This replaces the literal in `gas-refill.ts`.

## 3. Vault onboarding (BF-3, BF-4)
- **BF-3, the factory address comes from the server.**
  - `AppWalletConfig` (SCR-140) gains two required public fields:
    - `vaultFactory` (address): from the server's deployment manifest (`CzarVaultFactory`), which the server already loads.
    - `webauthnRpId` (string): the host name of `app.origin` (SCR-156).
  - The web app reads both from `GET /v1/app/wallet-config`.
  - `NEXT_PUBLIC_CZAR_VAULT_FACTORY_ADDRESS`, the literal fallback address and the literal `"localhost"` RP ID in `apps/web/app/onboarding/vault/page.tsx` are removed.
  - When the server has no factory for the configured network it refuses to start (`invalidConfig`). The app never guesses.
- **BF-4, idempotent vault creation (FAC-1).**
  - Before sending `createVault`, the app reads `factory.vaultOf(msca)`. When it is non-zero, the vault exists: the app skips creation and continues. It does not depend on matching a revert string, because bundlers return encoded revert data, which is why `VaultExists` showed as "network is busy".
  - Before sending `setPasskey`, the app reads the vault's passkey state and skips the call when the same key is already set.
  - A `VaultExists` revert that still occurs, decoded by selector through `@czar/vault-client`, is treated as success.
- **No gas, no button.**
  - When `Me.balances.mscaBalance` is `"0"`, "Create vault" is disabled and the page shows "Add a small amount to your MSCA for network fees, then try again."
  - The existing insufficient-gas catch stays for balances above zero but too low.
- **Tests:**
  - The page never contains a literal factory address.
  - The wallet-config contract test includes both new fields.
  - A second "Create vault" after a vault exists sends no `createVault` operation.
  - A zero MSCA balance disables the button.

## 4. Not changed
- #164's removal of the after-refill balance check is accepted. The receipt-block read in §2 replaces it.
- The BadTtl attempt bound in #163 is accepted as built. The count is BadTtl-specific (`currentAttempt` follows only stale-reserve attempts).

## Owner and exit impact
- **Owner:** the builder, test first, as two build-v1 PRs:
  - §1 (server)
  - §2 (signer) and §3 (web, server wallet-config)
- **Exit gate:** these two PRs join the SCR-155 §5 gate list. BF-3 and BF-4 move from M8 items to fixed in the exit report.

## Decision
- Architect rulings under Zaryab's delegation. Recorded by his merge.
