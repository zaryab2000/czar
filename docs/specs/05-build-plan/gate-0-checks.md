# Gate 0 checks (spec 05)

- **Date:** 2026-10-18. **Status:** ready to run. Gate 0 must pass before any production code (milestone M0 may start only on the repo baseline, check G0-12).
- **Rule:** a result that changes a spec choice produces a spec change request (`spec-change-request-template.md`) **before** any milestone task that depends on it starts.
- **Funds rule:** no check spends anything without Zaryab's written approval in the check's record. Testnet only. Test keys are created with `cast wallet new`, imported into an encrypted keystore (`cast wallet import`, which writes to `~/.foundry/keystores/`, outside the repository), never printed, and their passphrase is typed at the prompt, never passed on the command line or in an environment variable (D78). **Superseded by D78:** "kept in gitignored folders (the pattern used in experiments A1 and A2)".
- **Test funds:** Circle's CLI faucet drips 20 testnet USDC per request but only to Zaryab's own Circle wallets (p1-A11, A6-26). So Zaryab funds his agent wallet from the faucet and transfers small amounts to test addresses with `circle wallet transfer` (as in A1 and A2 experiment READMEs).
- **D69 (2026-10-19):** G0-02 (iPhone passkeys) and G0-15 (web push) are moved to stage 2 and are not part of Gate 0. Phase 1 approvals run in a desktop browser; the desktop passkey check is part of task T-082. The procedures below are kept for stage 2.
- **Records:** every check writes `docs/specs/05-build-plan/gate-0-results/G0-<nn>.md` with date, commands, outputs (no keys, no secrets), result and any SCR filed.

## Summary

| ID | Check | Owner | Funds | Pass rule | Spec updated on failure |
|---|---|---|---|---|---|
| G0-01 | Independent review of specs 01–05 | reviewer agent (fresh, did not write the specs) | none | no blocking findings left open | the spec each finding names |
| G0-02 | ~~Passkey ceremony inside the installed iPhone Home Screen web app~~ — **moved to stage 2 (D69)**; see `stage-2-backlog.md` §2 (M-1) | — | — | not part of Gate 0 | — |
| G0-03 | AR-2: Circle MSCA UserOp calls an arbitrary contract | agent, after Zaryab supplies a Modular Wallets client key (K2) and approves ≤ 0.1 testnet USDC | ≤ 0.1 USDC | UserOp mines and the target contract records `msg.sender == msca` | spec 01 §7.1 via SCR; D30 fallback (P-256 `executeOwnerAction`) becomes the Phase 1 path |
| G0-04 | AR-3: keyless Facilitator `/verify` with a long ERC-1271 signature | agent, after Zaryab approves ≤ 0.1 testnet USDC for one deployment | ≤ 0.1 USDC (`/verify` itself is free, A1-15) | `isValid: true` for the 416-byte envelope signature | none if it fails: set `vaultSignatureMode = digest` (spec 02 §6.3.4); record it |
| G0-05 | AR-5 / AR-14: Gateway pullback through a vault-style `isValidSignature`, including a **full-balance drain** (RV-012) | agent, **after Zaryab approves about 1 testnet USDC** | ≈ 1 USDC | attestation `201`, mint lands, `isTransferSpecHashUsed == true`; a drain of `availableBalance − maxFee` leaves the pocket at `≤ maxFee − fee`, and the response to a request for the whole balance is recorded | spec 03 `czar-vault.md` §5.4 via SCR (pocket key's own 7-day withdrawal becomes the drain path) |
| G0-06 | AR-6: faucet or transfer to an MSCA address | agent with Zaryab (transfer from his wallet) | ≤ 0.1 USDC | MSCA balance increases | spec 04 `app-and-notifications.md` onboarding funding step |
| G0-07 | AR-7: a pocket EOA can hold gas and call `addDelegate` | agent, after Zaryab approves ≤ 0.6 testnet USDC | ≤ 0.6 USDC (0.5 for a `depositFor`) | `DelegateAdded`, `isAuthorizedForBalance(USDC, pocket, testContract) == true` | spec 03 §5.4 / spec 04 CZ-15 §5.3 via SCR |
| G0-08 | Arc block gas limit and contract size limit | agent (read-only RPC, local `arc-anvil`) | none | values recorded; vault plan fits (`finalize` chunk, `createVault` gas, size ≤ limit) | spec 03 constants (`FINALIZE_CHUNK`) or D42 library split |
| G0-09 | AR-15 / AR-25: `isTransferSpecHashUsed` and `AttestationUsed` exist on the testnet GatewayMinter | agent (read-only) | none | `cast call` returns a bool; event present in past logs | spec 03 §5.4 confirm path via SCR |
| G0-10 | Toolchain: `arc-forge` builds with solc 0.8.30 `evm_version = prague` | agent (local) | none | the seven interface files compile, 0 warnings | spec 03 header via SCR |
| G0-11 | Hosts and protocols: `claude plugin validate --strict` on a skeleton plugin; `http` hook to `127.0.0.1` (AR-18, D46); `.mcp.json` env substitution (AR-20); MCP revision each host negotiates | agent (local Claude Code) | none | validation passes; hook payload reaches a local listener; env reaches the MCP child; revision logged | spec 04 `local-observers-and-daemon.md`, `local-agent-surfaces.md` via SCR |
| G0-12 | Repo security baseline | agent | none | `.gitignore` present; secret scan in CI passes; no key files tracked | — (blocks M0) |
| G0-13 | Local signer backend (D70, D78): `local-keystore` signs raw digests under per-key policies; keystore outside the repository; passphrase only from the macOS keychain (RV-028). The cloud KMS form of this check is stage 2 | agent (local; no account, no funds) | none | a signature over a known digest recovers to the key's address; a denied selector never reaches the backend; the keystore path is outside every git working tree; the passphrase is read from the keychain and never appears in `ps` output or the process environment | spec 04 `server-autonomy-roi-keys.md` CZ-27 §3 via SCR |
| G0-14 | Bundlers and paymaster on Arc testnet: Circle's endpoint, one secondary bundler (AR-26), gas sponsorship (A6-08, A6-19 GAP), MSCA factory EntryPoint (A6-07) | agent (read-only `eth_supportedEntryPoints`; one UserOp shared with G0-03) | shared with G0-03 | entry points recorded; sponsorship yes/no recorded | spec 04 CZ-22 gas-reserve text (D52 stays until sponsorship confirmed) |
| G0-15 | ~~Declarative Web Push to the installed app~~ — **moved to stage 2 (D69)**; see `stage-2-backlog.md` §2 (M-4) | — | — | not part of Gate 0 | — |
| G0-16 | AR-8: the chosen model provider's published data-retention and training terms (RV-062) | agent (read-only: public terms pages), then Zaryab approves opening the K18 account | none | the terms are recorded with date and URL; the D31 disclosure wording in CZ-04 and CZ-22 matches them; Zaryab's written approval of the account is recorded before T-046 | spec 04 D31 disclosure wording via SCR |
| G0-17 | Live re-checks the review could not run (network blocked): B3-10 (Cursor runs Claude Code hooks from `~/.claude/settings.json`) and A9-06 (`eth_getLogs` range cap on `rpc.testnet.arc.io`) | agent (read-only: cursor.com docs, one Cursor run if installed; read-only RPC) | none | each fact recorded as confirmed or changed, with date and source; **B3-10 must pass before T-062 starts** | spec 02 §8.1, §8.4 and spec 04 `local-observers-and-daemon.md` (B3-10); CZ-19 paging (A9-06) via SCR |
| G0-18 | Core-value walk-through (D84): trace the subject of each Phase 1 detector from its source to the merchant call and back, using spec 01 §11.0's lineage table, and confirm no rule drops it | agent (read-only: specs), then Zaryab | none | every row of §11.0 holds in the current specs; the scenario's 7.2a outcome check exists; **(D90)** every soul-input class has a written trace to its Phase 1 consumer and none reaches a payee, amount, limit or objective by itself; repeated on every spec change that touches CZ-02 §5.6, CZ-04 §5.11, CZ-06, CZ-07 `constraints`, CZ-13, CZ-15, P-03, P-05, P-07, spec 02 §4.3–§4.6, §4.23–§4.26 or a privacy rule | the spec that broke the lineage, via SCR |

## Procedures

### G0-01 Independent spec review
- **Steps:**
  1. Start a fresh agent session that has not seen this conversation.
  2. Give it `README.md`, `docs/product/decisions-log.md`, specs 00–05.
  3. Ask for: contradictions between specs, invented facts without a fact ID, money paths without crash recovery, missing invariants, unsafe defaults, tasks that depend on later tasks.
  4. Each finding gets a severity (blocking / major / minor) and a file:section.
- **Record:** the findings list.
- **Pass:** zero blocking findings open. Majors have an SCR or an accepted reason.
- **On failure:** SCR per finding; re-run the review on the changed sections.

### G0-02 Passkeys in the installed iPhone web app (Zaryab) — moved to stage 2 (D69)
- **Status:** not part of Gate 0. Kept for stage 2 (`stage-2-backlog.md` §2, M-1). The "only code allowed before Gate 0" exception in step 1 no longer applies to Phase 1.
- **Steps:**
  1. Deploy the M6 onboarding skeleton page (passkey create + get only, no money) to a test HTTPS origin. This is the only code allowed before Gate 0 passes, and it holds no funds.
  2. On a real iPhone (iOS 18 or later), open it in Safari and add it to the Home Screen. Open it from the Home Screen icon.
  3. Create a passkey (Face ID). Close the app. Reopen it from the icon and sign in with the passkey.
  4. Repeat sign-in once after a phone restart.
- **Record:** iOS version, each ceremony's result, screenshots without personal data.
- **Pass:** create and both sign-ins succeed inside the installed app.
- **On failure:** D28 applies: switch the approval surface to a native app. SCR on spec 04 `app-and-notifications.md` and the M6 tasks; M6 is re-planned before it starts.

### G0-03 AR-2: MSCA calls an arbitrary contract
- **Steps:**
  1. Zaryab creates a Circle Modular Wallets client key in the Circle Console (a sign-up he does himself) and stores it in the secret store; the agent reads only the reference.
  2. Deploy a tiny `CallRecorder` test contract on testnet (records `msg.sender` and calldata in an event).
  3. With `@circle-fin/modular-wallets-core` 1.0.16 (A6-06), a virtual WebAuthn authenticator and transport `<clientUrl>/arcTestnet` (A6-19), create an MSCA and send a UserOp that calls `CallRecorder.record(bytes)`.
- **Record:** UserOp hash, tx hash, event fields, EntryPoint address used.
- **Pass:** the event shows `msg.sender == msca` and the exact calldata.
- **On failure:** SCR: the D30 fallback (`executeOwnerAction` with a P-256 passkey assertion, spec 03 `czar-vault.md` §7) becomes the Phase 1 approval path; M6 tasks change.

### G0-04 AR-3: long ERC-1271 signature at the Facilitator
- **Steps:**
  1. Write a test contract whose `isValidSignature` accepts a 416-byte payload laid out like spec 02 §6.3.1 (kind tag, fields, 65-byte inner signature) and returns `0x1626ba7e` when the inner signature recovers to its owner.
  2. Deploy it on testnet (Zaryab-approved funds) and give it 1 atomic unit of USDC.
  3. Run a local x402 v2 seller at 1 atomic unit (the `x402-flow.mjs` shape from experiment A1) and send a `PaymentPayload` with that signature.
  4. Call `POST https://api.circle.com/v1/facilitator/x402/verify` with `network: "eip155:5042002"` (A1-15). Do **not** call `/settle`.
- **Record:** HTTP status, body (`isValid`, `invalidReason`).
- **Pass:** `isValid: true`.
- **On failure:** set server setting `vaultSignatureMode = digest` (spec 02 §6.3.4; the vault accepts both). Record it in `amendment-verification.md`'s follow-up list. No SCR needed; the spec already covers both outcomes.

### G0-05 AR-5: pullback through a vault-style signer (needs about 1 testnet USDC and Zaryab's approval)
- **Steps:**
  1. Deploy a test contract whose `isValidSignature` accepts the spec 02 §6.3.2 `GATEWAY_BURN` layout and rebuilds the burn-intent digest exactly as spec 03 `czar-vault.md` §6.2 describes, with a fixed pocket and recipient = itself.
  2. Create a pocket EOA; fund it with 0.6 USDC (approved); the pocket calls `GatewayWallet.addDelegate(USDC, testContract)` and `deposit` 0.5 USDC.
  3. Build the burn intent (same-chain, domains 26/26, recipient = test contract) and sign the envelope; `POST https://gateway-api-testnet.circle.com/v1/transfer` with `contractSigner: true` (A2-19c).
  4. Call `GatewayMinter.gatewayMint(attestation, signature)` from a funded relayer (`0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`).
  5. **Full-balance drain (RV-012):** read the pocket's balance from the Gateway API (`/v1/balances`); request a second burn with `value = availableBalance − maxFee`; then, separately, request one with `value = availableBalance` (the whole balance) and record whether the API refuses to attest or the burn reverts.
- **Record:** the request, the `201` response fields (not the attestation bytes), mint tx, `AttestationUsed` event, `isTransferSpecHashUsed(transferSpecHash)`, and step 5's two outcomes.
- **Pass:** steps 1–4 succeed and the test contract's balance rises by `value`; the `availableBalance − maxFee` drain mints; step 5's whole-balance outcome is recorded (it decides nothing, but documents why CZ-15 leaves fee headroom).
- **On failure:** SCR on spec 03 §5.4 and spec 04 CZ-15 §5.3: the drain path becomes the pocket key's own transfer or 7-day withdrawal (A2-13 to A2-16), and the pocket cap may need lowering.

### G0-06 AR-6: funding an MSCA address
- **Steps:** try the Circle CLI faucet with the MSCA address (`circle wallet fund --address <msca> --chain ARC-TESTNET`); expect `NOT_FOUND` (A6-26). Then Zaryab transfers 0.1 USDC from his wallet.
- **Record:** both outcomes.
- **Pass:** the transfer arrives (the faucet result is recorded either way).
- **On failure:** onboarding wording in spec 04 CZ-22 names the manual funding step.

### G0-07 AR-7: pocket EOA with gas calls `addDelegate`
- Covered by G0-05 step 2 when G0-05 runs. If G0-05 is not approved, run only steps 2 with 0.01 USDC gas and no deposit.
- **Pass:** `DelegateAdded` and `isAuthorizedForBalance == true`.

### G0-08 Block gas limit and contract size limit (read-only)
- **Commands:**
  - `cast block latest --rpc-url https://rpc.testnet.arc.io --json | jq -r .gasLimit`
  - same against `https://rpc.mainnet.arc.io` (read-only; no transaction)
  - on local `arc-anvil --network arc`: try deploying a contract with runtime size 24,576 bytes and 24,577 bytes; record which succeed
  - `cast estimate --create <24,577-byte init code> --rpc-url https://rpc.testnet.arc.io` (an estimate is read-only)
- **Record:** gas limits, size results.
- **Pass:** values recorded; the M1 size build (D42) uses the real limit.
- **On failure:** none; results feed D42 and `FINALIZE_CHUNK`.

### G0-09 GatewayMinter replay view and event (read-only)
- `cast call 0x0022222ABE238Cc2C7Bb1f21003F0a260052475B "isTransferSpecHashUsed(bytes32)(bool)" 0x00…00 --rpc-url https://rpc.testnet.arc.io`
- `cast logs` for `AttestationUsed(address,address,bytes32,uint32,bytes32,bytes32,uint256)` over the last 9,999 blocks (A9-06).
- **Pass:** call returns `false`; at least one log decodes.
- **On failure:** SCR on spec 03 `confirmPullback` (credit via indexed `AttestationUsed` plus owner confirmation, spec 02 AR-15).

### G0-10 Toolchain
- Download `arc-foundry` v0.8.0-2 for the platform, check the `.sha256`, rename binaries to `arc-forge`, `arc-cast`, `arc-anvil` (A9-12, A9-13).
- `arc-forge build` on `docs/specs/03-smart-contracts/interfaces/*.sol` with `solc_version = "0.8.30"`, `evm_version = "prague"`.
- **Pass:** 7 files compiled, 0 errors, 0 warnings.

### G0-11 Host checks
- `claude plugin validate --strict` on a skeleton `czar-observer` plugin (B1-39).
- Configure an `http` hook to `http://127.0.0.1:<port>/v1/hooks` (D46); confirm a payload arrives; repeat with a `command` hook with `async: true`.
- Configure `.mcp.json` with the `env` substitution from spec 02 mcp §5; confirm the child sees the variable (AR-20).
- Log the MCP protocol revision Claude Code sends (D3 GAP); repeat for Codex if installed.
- **Pass:** all four observed.
- **On failure:** SCR on spec 04 CZ-01 / CZ-09 (for example the token passed through `${CLAUDE_PLUGIN_DATA}` instead).

### G0-12 Repo security baseline
- Root `.gitignore` contains `*.key`, `*.key.json`, `.env*`, `keystore/`, `node_modules/`, `out/`, `cache/`.
- CI runs a secret scanner (gitleaks with the pinned rule set, C2-06) on every push and pull request, with GitHub Actions pinned to SHAs and `persist-credentials: false`; `zizmor` on workflows.
- `git ls-files | grep -E '\.key$|\.key\.json$|\.env'` returns nothing.
- **Pass:** all three.

### G0-13 Local signer backend (D70, D78); the KMS form is stage 2
- **Phase 1 check (RV-028):** the agent checks the `local-keystore` signer backend: create one testnet secp256k1 key in an encrypted keystore at `signer.keystorePath` (outside the repository), with the passphrase stored in the macOS keychain item `signer.keychainService`; sign a known digest; recover the address; confirm a denied selector never reaches the backend; confirm the keystore path is outside every git working tree and that the passphrase never appears in `ps` output or the environment. **Superseded by D78:** "confirm the keystore path is gitignored".
- **Stage 2 (original check, kept):** Zaryab creates the Google Cloud account and KMS (his action).
- The agent creates one secp256k1 signing key, signs a known 32-byte digest, recovers the address with `cast wallet verify`/viem, and checks a second principal is denied.
- **Pass:** recovery matches; denial observed.
- **On failure:** CZ-27 software signer in an isolated segment (spec 04 `server-autonomy-roi-keys.md`), recorded for the pre-mainnet HSM decision.

### G0-16 AR-8: model provider retention terms (RV-062)
- **Steps:** read the chosen provider's public data-retention, zero-retention and training-use terms for API traffic (read-only, no account needed); record URL, date and the relevant wording; compare with the D31 disclosure text the user sees (CZ-04, CZ-22). Then Zaryab approves, in writing, opening the K18 model account (AGENTS.md: account creation needs approval).
- **Pass:** terms recorded; wording matches or an SCR changes it; approval recorded before T-046.

### G0-17 Live re-checks the review could not run (RV review flags B3-10, A9-06)
- **Why:** the G0-01 review and the review-fix pass both ran where `cursor.com`, `docs.arc.io` and `rpc.testnet.arc.io` were refused by the network policy, so these two facts rest on captures only.
- **Steps:** (1) read Cursor's current hooks documentation and, if Cursor is installed, run one session with a Claude Code `PreToolUse` hook in `~/.claude/settings.json` and record whether Cursor runs it and with which payload shape (B3-10); (2) `eth_getLogs` against `https://rpc.testnet.arc.io` over 10,000 and 10,001 blocks and record the error code (A9-06).
- **Pass:** both facts recorded. B3-10 gates T-062: if Cursor no longer runs Claude Code hooks, spec 02 §8.1 rule 1 and §8.4's de-duplication change through an SCR before T-062 starts. A9-06 changes only CZ-19's page size.

### G0-18 Core-value walk-through (D84)
- **Why:** the G0-01 review checked money safety and consistency but not whether the flagship task could succeed; three privacy rules together removed the task's subject (D84).
- **Steps:** (1) for each detector in spec 01 §11.0, follow the subject through CZ-06 §5.1a, spec 02 §4.3.1, CZ-13 step 4a, CZ-15 §5.2 step 4 and the CZ-11 assembler; (2) list every rule on that path that filters, redacts or drops text; (3) confirm none removes an approved subject.
- **D90 extension (soul inputs):** (4) for each source class (`declared` interview, `local-file` agent file and git, `imported` paste and agent summary), follow it from intake (CZ-02 §5.6) through redaction, P-01, P-07, the proposal queue and acceptance (CZ-04 §5.11) to its only Phase 1 consumers: `ObjectiveSubmission.constraints` (typed answers), `Objective.deadline` (matching project root) and `hourlyBand` / ROI; (5) confirm that no source creates an objective, increments a detector, or reaches a payee, an amount, a vault setting or the planner except through those three fields; (6) confirm the paid-task subject lineage of §11.0 is unchanged: the subject still comes from `TaskSpec` built by code from the current file. When SCR-030 lands, add the user-confirmed route: the subject still comes from the current file at the moment of **Do this**, and no rule on the path drops it.
- **Pass:** written record per detector and per soul-input class. Re-run on every spec change listed in the summary row, separately from the security review.

### G0-14 Bundlers and sponsorship
- `eth_supportedEntryPoints` on Circle's Modular Wallets endpoint and one secondary bundler (Pimlico, Alchemy or ZeroDev support Arc testnet, A6-15 to A6-17).
- From the G0-03 UserOp: was gas paid by the MSCA or sponsored?
- **Pass:** recorded. D52's "Network fee reserve" stays unless sponsorship is confirmed.

### G0-15 Declarative Web Push (Zaryab) — moved to stage 2 (D69)
- **Status:** not part of Gate 0. Kept for stage 2 (`stage-2-backlog.md` §2, M-4).
- On the installed app from G0-02, tap "Enable notifications", then send one `approval-needed`-shaped test push (spec 02 mcp §7) with the app closed.
- **Pass:** visible notification; tapping opens the app.
- **On failure:** add a web app manifest and retry; SCR if it still fails.

## Change log

| Date | ID | Change |
|---|---|---|
| 2026-10-19 | D69 | G0-02 (iPhone passkeys) and G0-15 (web push) moved out of Gate 0 to stage 2; procedures kept and marked; header note added. |
| 2026-10-19 | D70 | Phase 1 runs on Zaryab's Mac with a local software signer (encrypted keystore); Google Cloud (KMS, Cloud Run, e2-micro VM) moves to stage 2. |
| 2026-10-19 | RV-012 | G0-05 adds a full-balance drain step. |
| 2026-10-19 | RV-028 / D78 | Funds rule and G0-13 rewritten for the local keystore (outside the repository, passphrase only in the keychain); the KMS form is stage 2. |
| 2026-10-19 | RV-062 | G0-16 checks the model provider's retention terms and records approval for the K18 account. |
| 2026-10-19 | review flags | G0-17 re-checks B3-10 (gates T-062) and A9-06 live. |
| 2026-10-20 | D84 | New G0-18 core-value walk-through, repeated on every spec change on the subject's path. |
| 2026-10-20 | D90 | G0-18 extended with the soul-input trace (steps 4–6) and the new trigger sections. |
