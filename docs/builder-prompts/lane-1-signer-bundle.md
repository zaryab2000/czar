# Lane 1 — Signer bundle builder prompt

> **Tasks:** T-036 (signer policies on the local chain, rate limits, relayer gas key, gas refill) and T-037 (pocket key lifecycle). One branch, one PR, one review.
> Local chain only (D92). The testnet repeat is T-121, later.

---

## Preamble

You are a Czar builder on LANE 1 (Contracts and chain). Other builders work in parallel on other lanes.

- Worktree: `../czar-1`. Branch: `codex/lane1-signer-bundle` from the latest `origin/build-v1`.
- You own: `contracts/`, `packages/vault-client/`, `apps/signer/`, `deployments/`, `env/`. Do not edit other lanes' folders. Edit shared packages (`schemas`, `hashing`, `config`, `api-contract`) only where a task requires it, in its own small commit.
- Config registry: append keys only. Migrations: rebase on `origin/build-v1` before the PR and take the next free number.
- Local `arc-anvil --network arc` on port **8545** (pinned `arc-foundry` release, never standard `anvil`). Postgres `127.0.0.1:15432`.
- No testnet, no funds, no accounts, no hosted model calls. Never read, print or commit key material, the keystore passphrase, `*.key*` or `.env*` files. Keys stay in the T-105 local keystore and are used only through the signer.
- Never edit `docs/specs`, `docs/product`, `docs/architecture`. Spec gap → write it as an SCR **in your task report only** (no files under `docs/`), continue with the rest.
- Finish = every acceptance test below passes locally + one PR into `build-v1` + task report. Do not merge.

**Path note.** The tasks say `apps/server/src/signer/`. The signer actually lives in `apps/signer/` (T-035). Work there.

---

## Spec files to read first
1. `docs/specs/05-build-plan/phase-1-tasks.md`: T-036 (line 585) and T-037 (line 600), including every D92, RV and review-fix note.
2. `docs/specs/04-components/server/server-autonomy-roi-keys.md`: CZ-27 in full, especially §5.1 (key/kind table), §5.2 (signer policy), §5.3 (pocket keys and the zero-balance retire rule), §5.5 (gas balances and refill), §14 (tests).
3. `docs/specs/03-smart-contracts/czar-vault.md`: §5.4 (pockets).
4. `docs/specs/02-data-and-protocol/data-and-protocol.md`: §6.3 signature envelopes.
5. `contracts/script/deploy.sh`: produces `deployments/arc-local.json`.

---

## Part 1 — T-036: Policies on the local chain, rate limits, gas refill

### Build
- **Local deployment.** A test helper runs `contracts/script/deploy.sh` against local `arc-anvil` and writes `deployments/arc-local.json`. Gas for K3, K7, K8 comes from `anvil_setBalance` through the test client, not from any real funds.
- **K10.** Load the T-105 keystore and add the K10 merchant keys the same way T-105 creates keys.
- **Rate limits.** Add the per-key rate limits from CZ-27 §5.2, each as a `signer.*` config key with its spec default and reason.
- **Relayer gas key.** It lives in the `local-keystore` backend (D62, D70).
- **Gas refill job (RV-017).** Keep K3, K7 and K8 between `signer.gas.<key>.minAtomic` and `maxAtomic`, refilling to `targetAtomic` from the relayer. Alert when the relayer cannot.
- **Audit table.** A denied request is written as `kms_denied` and never reaches the backend sign call (RV-028).

### Acceptance (local chain)
- K8 sends one `OpenEvidenceLog.commit` with a zero test root from its own address and pays its own gas. The receipt has status 1.
- A wrong-selector request never reaches the keystore: the audit row is `kms_denied` and there is no backend sign call.
- `gasRefill_keepsK3K7K8WithinBounds`: with K3 drained below `minAtomic`, the job refills it to target and never above `maxAtomic`. An alert fires when the relayer is empty.

---

## Part 2 — T-037: Pocket key (K4) lifecycle

**Tests first.** This key moves USDC.

### Build
- **`createPocketKey(planId)`.** Create the key at planning time (D71).
- **Allowed K4 kinds only:**
  - `gateway-nano`
  - `pocket-delegate`
  - `pocket-return`: a USDC transfer and a native send, to the owning vault only
  - `pocket-slow-withdraw`
- **Denied.** Every other USDC call is refused: `approve`, `permit`, and `transfer` to anyone else (RV-055).
- **Retire.** A key is retired only under CZ-27 §5.3's zero-balance rule. A `PocketClosed` event alone does not retire it (RV-004). After retirement, any sign request fails.

### Acceptance
- A pocket key cannot sign a burn intent (K3 signs those, as the vault) or any transfer to a non-Gateway address.
- `signer_k4_usdcApproveOrTransferElsewhere_denied`
- `signer_k4_returnToOwningVault_allowed`
- `signer_retirePocketKey_nonZeroBalance_refused`
- Retiring a key at zero balance succeeds, and a later sign request fails.

---

## Final checks
```bash
pnpm --filter @czar/signer test
pnpm -r typecheck
pnpm lint
```

## Task report
Cover both tasks: files changed, every command with its pasted result, SCRs needed (as text), and open items (the T-121 testnet repeat).

## PR
- **Title:** `feat(signer): Lane 1 signer bundle — local-chain policies, gas refill, pocket keys (T-036, T-037)`
- **Base:** `build-v1` · **Branch:** `codex/lane1-signer-bundle`
