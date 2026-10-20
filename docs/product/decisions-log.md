# Czar decisions log

- **Purpose:** every product decision made so far, with the reasoning. Specs follow these decisions unless a later entry changes them.
- **Format:** each decision states what was decided and why. Open items are listed at the end.
- **Last updated:** 2026-10-20 (D90, soul inputs beyond observation)

---

## 1. What Czar is

### D1. Payment is the core, not recommendations
- **Decided:** Czar lets a person pay for a better version of their work. It pays x402 merchants, ERC-8183 specialist agents and builders, in USDC on Arc.
- **Not:** a recommendation engine, a discovery-only tool, or a paid-placement system.
- **Reference model:** Onda, a browser extension that pays artists per listen in USDC on Arc, with escrow that unclaimed artists can claim later. Czar is far more complex than Onda in observation, discovery, evidence and contracts.

### D2. x402 merchants and the discovery layer are the primary beneficiaries
- **Decided:** the observing and recommending agent is the front of the product. Behind it, Czar is also a marketplace of its own, with evidence-based discovery.
- **The marketplace uses multi-input ranking,** specified in `docs/architecture/selection-layer-architecture.md`.
- **Evidence loop:** every time a merchant serves a user, the user provides evidence that the merchant delivered what it promised. That evidence improves the merchant's ranking and future recommendations.
- **Why:** merchants and specialist agents earn very little today. Czar brings them new buyers who would never have searched for them, and fairer discovery.

### D3. Builders are a supporting part
- **Decided:** open-source builders, skill makers and plugin makers are included, but they are a supporting part of the product, not its core.
- **Why it's kept:** it shows that agents using x402 on Arc can pay open-source builders, who usually earn nothing from use.
- **How they're paid:** through recipes with on-chain revenue splits (feature roadmap 2.5), with escrow for builders who haven't claimed their identity yet.

### D4. The feature roadmap is adopted in order
- **Decided:** every feature in `docs/product/feature-roadmap.md` is part of Czar, in the exact order and priority given there.

---

## 2. Users and surfaces

### D5. The user is a white-collar professional who has never heard of x402
- **Decided:** the main users are everyday white-collar professionals who work on screens, inside or outside crypto.
- **Supersedes:** an earlier framing that targeted crypto-native users.

### D6. A mobile and web app for the user, observers in the background
- **Decided:** the user-facing part is a mobile and web app. The observer plugins run in the background inside the person's work tools.

### D7. Observers per tool, one shared memory
- **Decided:** separate observers for Claude Code, Codex, Cursor and Chrome.
- **All of them feed one shared memory,** where everything learned about how the person works is collected and organized. Recommendations and objectives are created from that shared memory on a schedule.

---

## 3. Money and pricing

### D8. Merchants and providers set their own prices
- **Decided:** x402 and ERC-8183 prices are set entirely by the merchants and providers.

### D9. Builder payments are tip-like for now
- **Decided:** payments for skills and open-source tools are treated as tips for now, not a priced decision. One payment per tool, regardless of how often it's used.
- **Later direction:** recipes with revenue splits (roadmap 2.5) give builders a per-run model.

### D10. Small payments use batching or another payment abstraction
- **Amended by D22:** batching is used only on the pocket wallet path.
- **Decided:** Czar will batch payments, or use another abstraction, so the cost of sending stays below the payment itself.

### D11. Spending limits live in Czar's own contract
- **Amended by D22:** fully enforced on the vault-direct path; on the pocket wallet path the hard limit is the wallet's balance.
- **Decided:** Czar writes its own spending limits into its vault or escrow contract on Arc, visible on-chain.
- **Not:** Circle Agent Wallet spending policies, which work on mainnet only and are enforced on Circle's servers.

### D12. Business model is undecided
- **Decided:** not discussed yet. It will be decided later.

### D22. Two payment paths: vault-direct first, a small pocket wallet second
- **Amended by D71:** a pocket exists only for plans with a Gateway step, and its address is part of what the user approves. **Amended by D72:** freeze also stops pocket spending, through the signer.
- **Decided (2026-10-18):** Czar pays merchants in one of two ways, chosen per merchant.
  - **Vault-direct (default):** if the merchant accepts vanilla x402, the vault itself pays. Every payment is checked against the vault's rules (envelope, per-category limits, freeze).
  - **Pocket wallet (fallback):** if the merchant accepts only Circle's batched nanopayments, the vault funds a small executor wallet, and the agent pays from it.
- **Pocket wallet cap:** at most 25% of an objective's envelope at a time (default; adjustable later). Funded per objective; unspent balance is pulled back to the vault when the objective ends.
- **Why:** nanopayments accept only a regular wallet as payer, never a contract (ground truth part 2, A2-09, A2-10). Vault-direct keeps on-chain limits wherever possible; the pocket wallet keeps every merchant reachable, while limiting the loss from a hijacked agent to what the pocket holds.
- **Known costs:**
  - two payment paths to build and test
  - vault-direct needs separate spending bookkeeping, because the vault's signature check can't record spending (A1-09)
  - pulling back pocket funds quickly depends on Circle's API being up (A2-16, A2-19)
- **Amends:** D10 (batching applies only to the pocket wallet path) and D11 (on-chain limits apply fully to vault-direct; for the pocket wallet, the hard limit is its balance).

---

## 4. Network, merchants and discovery

### D13. Development runs on Arc testnet
- **Decided:** Czar runs on Arc testnet for now.

### D14. Czar runs its own x402 merchant services on testnet
- **Decided:** Zaryab creates x402 merchant services on Arc testnet, built with Circle's seller SDK.
- **Details:** each service charges testnet USDC per call, with payout wallets he controls, funded from the faucet.
- **Discovery:** recommendations can still draw on the real Discovery API catalog.

### D15. Circle's catalog terms are not treated as a blocker
- **Decided:** Circle's Agent Platform terms (§15, no mirroring or derivative works) are noted but not considered a blocker.
- **Ground truth:** `docs/specs/00-ground-truth/circle-arc.md` fact D8 records the terms and the "query live, don't mirror" approach.

---

## 5. Trust, identity and attribution

### D16. Free tools and skills are admitted using hard-to-fake signals
- **Amended by D24:** on hold; builder admission is deferred.
- **Decided:** before a free tool or skill enters the recommendation engine, an agent vets it against signals that are hard to fake, such as GitHub stars and reviews.
- **Why:** copying a popular skill under someone else's wallet then can't earn anything.
- **Known trade-off:** this favours established builders. Fairness for new builders will be solved later.

### D17. Czar runs the claim-verification server
- **Decided:** Czar runs the server that verifies builder claims. Every server can be attacked; this isn't specific to Czar.

### D18. Builder identity: one claimable ID per builder
- **Replaced by D23.**
- **Decided:** to be designed. One option is an ENS name or another identity per builder, so only that person can claim.

### D19. Unclaimed payments stay claimable
- **Decided:** payments for builders who haven't joined stay in escrow for them to claim.

### D20. No shared sponsor pool
- **Decided:** Czar has no shared pool of sponsor money, so pool-farming incentives don't apply.

### D23. Builder claims: GitHub login by default, a committed file as fallback
- **Decided (2026-10-18):** a builder proves a repo is theirs in one of two ways.
  - **Default:** sign in with GitHub; Czar checks the account has admin rights on the repo.
  - **Fallback:** commit a small file (for example `FUNDING.json`) holding their wallet address and a one-time code from Czar; Czar's server reads it through the GitHub API.
- **Storage:** tips for a repo wait in one escrow contract keyed by the repo ID. Czar's claim server (D17) approves the claim and its relayer releases the funds to the builder's wallet.
- **Replaces** the ENS-style ID in D18. No ENS, EAS or ERC-8004 is needed for this (ground truth part 2, A8-01, A8-07).
- **Reference:** the same pattern Onda uses (public ID → escrow → server-verified claim).

### D24. Builder admission and tipping are low priority
- **Decided (2026-10-18):** how free open-source and skill builders are vetted and onboarded (including GitHub-star checks) is deferred.
- **Why:** builder tipping is a supporting feature. x402 merchants and ERC-8183 specialist agents come first.
- **Amends:** D16 (star-based admission is on hold; GitHub no longer exposes stargazer identities, ground truth part 2, E1-01).

---

## 6. Security and privacy

### D21. Security was initially deprioritized; revisit for white-collar users
- **Decided (initially):** security wasn't treated as a primary concern, on the view that many users adopt untested AI tools anyway.
- **Revisit:** D5 changed the main user to white-collar professionals, many on company-managed machines. Context minimization and local-first storage are already in the product doc. Security will be revisited in the architecture spec.

---

## 7. Architecture choices (2026-10-18)

### D25. The paying agent runs on Czar's server
- **Amended by D74:** the planner never sees merchant output; re-planning gets only step index, error code and flags.
- **Relaxed by D70 for testnet:** in Phase 1 the server runs on Zaryab's Mac, so it is always-on only while the Mac is awake.
- **Decided:** planning and paying run on Czar's server, so objectives keep moving when the user's computer is off.
- **Privacy split:** the work soul and raw observations stay on the user's machine; only cleaned-up objectives go to the server.
- **Spending:** the server signs with a key that can spend only inside envelopes the user approved (enforced by the vault, D11, D22).

### D26. Users get a passkey smart account through Circle Modular Wallets
- **Decided:** Face ID or fingerprint instead of a seed phrase. Live on Arc mainnet and testnet (ground truth part 2, A6-05).
- **Why:** the main user has never heard of x402 (D5).

### D27. Phase 1 uses Circle's ERC-8183 testnet instance; Czar's own instance comes before mainnet
- **Decided:** specialist-agent jobs run on Circle's testnet instance, where existing agents already are. Czar acts as the evaluator that accepts or rejects work; no hooks needed (A4-07, A4-09).
- **Before mainnet:** deploy a Czar-owned instance, since no official mainnet instance exists (A4-13).

### D28. Web app first, native app if passkeys fail on iPhone
- **Amended by D78:** Phase 1 app origin is `http://localhost` with passkey RP ID `localhost`.
- **Amended by D69:** Phase 1 runs the approval app in a desktop browser; the Home Screen web app and iPhone checks move to stage 2.
- **Decided:** the user app ships first as a web app installed to the Home Screen.
- **Early check:** test passkeys inside the installed web app on a real iPhone (gap D1-11). If they fail, switch to a native app.

---

## 8. Architecture follow-ups (2026-10-18, from `docs/specs/01-system-architecture/system-architecture.md` §21)

### D29. Phase 1 pays merchants and specialist agents only (OD-1)
- **Decided:** `RecipeSplits` and `BuilderEscrow` move to Phase 2. Phase 1 plans pay x402 merchants and ERC-8183 agents only.
- **Amends:** product §11.1 and roadmap §3 ("one recipe with on-chain splits" moves to Phase 2). Follows D24.

### D30. Owner approvals go through a UserOp from the user's smart account (OD-2)
- **Amended by D78:** the fallback passkey's RP ID is `localhost` in Phase 1; moving origin in stage 2 means registering a new passkey.
- **Decided:** in Phase 1 the owner acts on the vault as `msg.sender` through a UserOp sent via Circle's bundler.
- **Fallback:** an EIP-712 approval signed by the passkey and checked with the P-256 precompile, relayed by Czar (assumption AR-2).

### D31. Soul compiler uses a hosted model over redacted excerpts, with disclosure (OD-3)
- **Decided:** Phase 1 calls a hosted model from the daemon, through a Czar proxy that stores nothing, over redacted excerpts only. The user is told this clearly at setup.
- **Later:** a local model as a Phase 2 option.
- **Wording rule:** don't claim "raw work data never leaves your machine". Say raw data stays local and only redacted excerpts are sent for compilation.

### D32. The Czar-owned ERC-8183 instance is based on `erc-8183/base-contracts` (OD-4)
- **Decided:** hidden behind the vault's `IJobEscrow` adapter, so the vault supports both Circle's testnet ABI and Czar's instance.

### D33. Vaults are immutable (OD-5)
- **Decided:** no proxy. Migration means the owner withdraws and moves funds to a new vault.

### D34. The soul is viewed on desktop only in Phase 1 (OD-6)
- **Decided:** the phone app has no soul view in Phase 1. End-to-end encrypted sync to the phone is a Phase 2 option.

### D35. No Czar-paid credits for failed third-party steps (OD-7)
- **Decided:** failures produce evidence and lower rankings; Czar pays nothing back until the business model (D12) exists.

### D36. Envelope payee lists include up to two ranked alternates per step (OD-8)
- **Decided:** `payeeRoot` holds plan payees plus at most two ranked alternates per step, under the same per-step cap.

### D37. Tiny payments must not cost more to send than they are worth (OD-9)
- **Problem:** reserve-then-settle adds two on-chain transactions per vault-direct payment (about $0.001 each), which can exceed a sub-cent payment (breaks D10).
- **Decided:**
  - **Batch reservations:** one reservation can cover many authorizations within a step, and settlement can be batched. Exact mechanism is set in the contracts spec.
  - **Amount threshold:** payments below a set amount go through the pocket wallet, even when the merchant accepts vanilla x402. The threshold is set in the contracts spec from measured gas cost.
- **Amends:** D22 routing.

---

## 9. Contract and protocol follow-ups (2026-10-18, from `docs/specs/02-data-and-protocol/` and `docs/specs/03-smart-contracts/`)

### D38. Routing fee ratio target is 10% (OD-10)
- **Decided:** the on-chain cost of sending a payment should not exceed 10% of its value (routing policy parameter `maxFeeRatioBps = 1000`). D37's hard limit (cost never above the payment) still applies.

### D39. At most 128 authorizations per reservation (OD-11)
- **Decided:** `MAX_AUTHORIZATIONS_PER_RESERVATION = 128`.

### D40. Earned-autonomy raise step: 20% of `userMax`, at most once per week (OD-12)
- **Decided:** a starting value, to be tuned later.

### D41. Owner-only manual credit for pocket funds returned through the 7-day withdrawal (OD-13)
- **Clarified by RV-010 (no decision change):** the credit is bounded by `min(amount, outstanding − pendingPullback, freeBalance())`; the caller is the owner only.
- **Decided:** only the owner can credit back funds returned through Gateway's slow withdrawal path.

### D42. Single vault contract vs external library decided after a size build (OD-14)
- **Decided:** the build measures contract size first; the split is chosen then.

### D43. Per-step caps live inside each payee leaf (OD-15)
- **Decided:** alternates share the step's cap because the cap is part of the leaf.

### D44. Builder escrow: 48-hour delay, 0.01 USDC minimum tip (OD-16, Phase 2)
- **Decided:** starting values for Phase 2.

---

## 10. Component follow-ups (2026-10-18, from `docs/specs/04-components/shared/amendments-and-open-decisions.md`)

### D45. Layer-2 redaction runs in a bundled Python Presidio helper (OD-17)
- **Decided:** The helper ships inside the daemon installer (packaged with `uv`); users never install Python. Node regex is the forced-review fallback when the helper is down.

### D46. Claude Code hooks use `http` by default (OD-18)
- **Decided:** `http` handler with `onFailure: continue`; automatic fallback to `command` with `async: true` where managed `allowedHttpHookUrls` policies block it (B1-18).

### D47. Outbound objectives: first five reviewed, then automatic (OD-19)
- **Decided:** The user reviews the first five objectives before they leave the machine; after that they go automatically, with review still available.

### D48. Pocket-worthiness volume is measured per objective (OD-20)
- **Amended by D71:** the one pocket per envelope is named in the plan's `payeeRoot`.
- **Decided:** One pocket per envelope (spec 03 §5.4).

### D49. Phase 1 Czar merchants: `czar-spot`, `czar-extract`, `czar-search` (OD-21)
- **Decided:** `czar-spot` uses a public price source with a cache and a synthetic fallback, always with a `source` field.

### D50. Czar refunds its own sales automatically, with a daily cap (OD-22)
- **Decided:** Parameter `merchants.refundDailyAtomic`. This is not a D35 credit: it covers only Czar's own merchant sales.

### D51. Phase 1 shows amounts in USD only (OD-23, changed)
- **Decided:** No exchange-rate provider in Phase 1. USDC amounts display as USD. Local currency is a later option.

### D52. The smart account's gas reserve is shown to the user (OD-24)
- **Decided:** Shown as a separate "Network fee reserve" balance until Circle gas sponsorship on Arc is confirmed (A6-08, A6-19 GAP).

### D53. ERC-8183 deliverables use a `.well-known` path on the provider host (OD-25)
- **Replaced by D87:** deliverables are pushed to Czar's server and matched by content hash; the `.well-known` path survives only as the stage-2 signed-pull fallback.
- **Amended by D77:** fetched bytes that do not hash to the on-chain deliverable are a reject.
- **Decided:** Defines amendment AM-08.

### D54. Evidence archives stay on Czar's server in Phase 1; IPFS pinning is Phase 2 (OD-26, changed)
- **Amended by D78:** in Phase 1 "Czar's server" is the local server; the anchored URI is host-free so it stays valid when the public host arrives in stage 2.
- **Decided:** Hashes are anchored on-chain, so archives remain verifiable. Pin providers are chosen in Phase 2.

### D55. A structural check with no schema and no history records `inconclusive` (OD-27)
- **Amended by D76:** a result whose content screen is unavailable is quarantined, not delivered.
- **Decided:** Never counted as a pass.

### D56. Minutes-saved defaults per detector ship as 20 / 15 / 30 min (OD-28)
- **Decided:** Per-objective override; tuned from `report_outcome.minutesSavedActual` in Phase 2.

### D57. `drives.roiMultiple` = 5 (OD-29)
- **Decided:** Matches product §6.4.

### D58. Soul compile falls back to rules-only when the helper or proxy is down (OD-30)
- **Decided:** as stated.

### D59. Earned-autonomy constants as proposed (OD-31)
- **Decided:** `autonomy.baseAtomic` 0.50 USDC per score unit, `autonomy.minScore` 3, diversity weight `1/sqrt(k)` per payee. Starting values, to be tuned.

### D60. Freeze lowers every category's `autoLimit` to 0 on-chain (OD-32)
- **Amended by D72:** freeze also stops off-vault spending (pocket nanopayments, evaluator payouts) through the signer, and starts pocket pullbacks.
- **Decided:** as stated.

### D61. Key management: cloud KMS with a signer service; vendor chosen at build time (OD-33)
- **Amended by D78 and D80:** the Phase 1 keystore lives outside the repo with its passphrase never on argv or env; single-Mac custody is an accepted testnet exception.
- **Amended by D70:** Phase 1 uses a local software signer; Google Cloud KMS comes in stage 2.
- **Decided:** Testnet uses cloud KMS. Whether an HSM is required is decided at the pre-mainnet audit (AR-1).

### D62. The relayer gas key is held in KMS (OD-34)
- **Amended by D70:** in Phase 1 the relayer gas key sits in the local keystore.
- **Decided:** Not a hot wallet.

---

## 11. Build-plan follow-ups (2026-10-19, from `docs/specs/05-build-plan/build-plan.md`)

### D63. Freeze lowers limits in a follow-up agent step, not atomically (OD-35)
- **Decided:** the `frozen` flag already blocks all spending; the agent then calls `lowerAutoLimit(category, 0)` per category (D60). An atomic contract version is in the stage-2 backlog.

### D64. A test-keystore vault owner is allowed on testnet for M3–M4 (OD-36)
- **Decided:** testnet only, until the app exists; removed in M6 and listed in the pre-mainnet checklist.

### D65. Docs lagging D51 are fixed before the Gate 0 review (OD-37)
- **Decided:** spec 01 §4.3 and §8.2, product §4.1 and §9.2 updated to USD-only wording.

### D66. One cloud provider for server, indexer and KMS, chosen before M2 (OD-38)
- **Amended by D78:** the stable public archive host and app origin arrive with Google Cloud in stage 2.
- **Amended by D70:** provider chosen: Google Cloud, in stage 2. Phase 1 runs locally.
- **Decided:** provider still open; must offer a key-management service and managed Postgres.

### D67. The Phase 1 daemon supports macOS only (OD-39)
- **Decided:** Linux and Windows are in the stage-2 backlog.

### D68. Model prices are read during task T-046 (OD-40)
- **Decided:** cost budgets stay in tokens and request counts until then.

### D69. Phase 1 approvals run in a desktop browser; mobile work moves to stage 2
- **Amended by D78:** the desktop browser loads the app from `http://localhost`.
- **Decided (2026-10-19):** the approval app runs in a desktop browser in Phase 1 (passkeys work in desktop Safari and Chrome on macOS). The in-app pending-approvals list is the source of truth.
- **Moves to stage 2:** iPhone Home Screen install, iPhone passkey test (G0-02), web push (G0-15, CZ-23), mobile layouts, native-app fallback. See `docs/specs/05-build-plan/stage-2-backlog.md` §2.
- **Amends:** D6 and D28 (the Home Screen web app comes in stage 2).

---

### D70. Phase 1 runs locally on Zaryab's Mac for $0; Google Cloud comes later
- **Amended by D78** (origin, RP ID, archives, keystore location and passphrase handling) **and D80** (single-Mac custody is a documented testnet exception).
- **Decided (2026-10-19):**
  - **Phase 1 (testnet):** the server, paying agent, indexer, Czar's merchants, Postgres (Docker) and the signer service run as local processes on Zaryab's Mac, against Arc testnet. No cloud cost.
  - **Keys:** a **local software signer** with an encrypted keystore. Its passphrase is held in the macOS keychain. Testnet keys only; never committed; never real funds.
  - **Same interface:** the signer service keeps one backend interface (`signer.backend = local-keystore | gcp-kms`), so moving to cloud KMS is a configuration change plus key re-registration on the vaults.
  - **Later (stage 2, before outside testers join):** Google Cloud. Cloud KMS for server keys, Cloud Run for the API, an always-free e2-micro VM for the indexer, and a free external or VM-hosted Postgres. See `docs/specs/05-build-plan/stage-2-backlog.md` §6.
- **Trade-off accepted:** in Phase 1 the paying agent runs only while the Mac is awake (relaxes the always-on aim of D25 for testnet).
- **Amends:** D61 (cloud KMS deferred to stage 2), D62 (relayer gas key in the local keystore in Phase 1), D66 (provider chosen: Google Cloud, for stage 2).

---

## 12. G0-01 review follow-ups (2026-10-19, from `docs/specs/06-review/2026-10-19-spec-review.md`)

Approved by Zaryab. Each entry cites the review finding it resolves.

### D71. Pockets are named in the approved plan (RV-003)
- **Decided:** each pocket address is committed in the approved plan's `payeeRoot` as a "pocket" leaf (kind 4). `pocketCapBps = 0` unless the plan has a `gateway-nano` step.
- **Why:** the agent key alone could register an address it controls as a pocket and move 25–50% of every open envelope there.
- **Amends:** D22, D48.

### D72. Freeze is enforced off-vault too (RV-007)
- **Amended by D87:** the signer always allows the evaluator's `reject` (it only refunds); on freeze, funded jobs not yet submitted are rejected at once and submitted jobs are held (M3, N8).
- **Decided:** the signer refuses pocket nanopayments and evaluator payouts while the vault is frozen or the guardian has paused, and the agent starts pocket pullbacks immediately on freeze.
- **Why:** pocket money is already outside the vault, so the vault's freeze cannot stop it; the product promises that freeze stops spending.
- **Amends:** D22, D60.

### D73. No factory version register (RV-015)
- **Decided:** a new vault version means a new factory. The factory has no version register.
- **Why:** a factory can only deploy bytecode compiled into it, so a registered code hash protected nothing.

### D74. The planner never receives merchant or seller output (RV-018)
- **Decided:** P-03 never receives `StepResult` or any merchant-derived text. Re-planning gets only `{stepIndex, errorCode, flags}`.
- **Amends:** D25 (split of planner and reader).

### D75. MCP pay runs only approved plan steps; the HTTP API shape is canonical (RV-019, RV-020)
- **Decided:** MCP `pay` may only execute steps of an approved plan. The HTTP API (`createPayRequest`) shape is canonical, and the MCP tool mirrors it.

### D76. An unavailable content screen quarantines the result (RV-023)
- **Decided:** if the P-01 content screen is unavailable, results are quarantined, not delivered.
- **Amends:** D55 (applies to screening, not to structural checks).

### D77. A deliverable hash mismatch is a reject (RV-024)
- **Amended by D87:** under the push model a hash mismatch cannot occur (the hash is checked at upload); a deliverable still missing at `decisionCutoff` is a reject.
- **Decided:** in ERC-8183 jobs, a deliverable whose fetched bytes do not hash to the on-chain deliverable is rejected, not recorded as inconclusive.
- **Amends:** D53.

### D78. Phase 1 origin, passkey RP ID, archives and keystore (RV-028)
- **Decided:**
  - Phase 1 app origin is `http://localhost`; the passkey RP ID is `localhost`.
  - Evidence archives are served by the local server in Phase 1; the stable public archive host arrives with Google Cloud (stage 2).
  - The keystore lives outside the repository; its passphrase is never passed through argv or environment variables.
- **Amends:** D28, D30, D54, D61, D66, D69, D70.

### D79. Acceptance-scenario numbers obey the real routing rules (RV-029)
- **Decided:** the Phase 1 acceptance scenario's numbers are recomputed so it passes under the real D37/D38 routing rules. There is no test-only routing override.

### D80. Single-Mac key custody is an accepted testnet exception (RV-045)
- **Decided:** in Phase 1 every server key, including guardian (K6) and admin (K20), lives on Zaryab's Mac. This is an accepted, documented testnet exception. Real dual control arrives with Google Cloud KMS (stage-2 backlog §6).
- **Amends:** D61, D70.

### D81. The pullback fee cap is owner-adjustable under a hard contract bound (RV-037)
- **Decided:** the vault's pullback fee cap (`maxPullbackFee`) is set by the owner, starting at 0.01 USDC, and can never exceed the contract constant `MAX_PULLBACK_FEE_CEILING` = 0.50 USDC.
- **Why the bound:** the Gateway fee tracks Arc gas (measured 0.0035 USDC at 20 Gwei). 0.50 USDC is about 143× that, covering gas up to roughly 2,850 Gwei. Above that, instantly pulling back a pocket (at most 25% of an envelope, typically a few USDC) costs more than it saves, and the slow path is the right one. A higher ceiling would only widen what a hijacked agent key can waste on fees per pullback.
- **Consistent with D33:** vaults stay immutable; the bound is in the code and only the value is owner state.

## 12a. Local-step execution (2026-10-20)

### D82. Unpaid steps run on the Mac as plain code; richer work goes to the person's agent
- **Context:** a plan can contain unpaid steps that shape earlier paid outputs into what the person asked for (for example `table-build` after `web-search` and `page-extract`). No spec said where they run or what runs them.
- **Decided:**
  1. **Kind `local` runs on the Mac, inside CZ-11, as plain code.** The daemon's assembler fills a fixed template per capability from the paid steps' structured fields. No model, no prompt, no network call. Phase 1 capabilities: `table-build`, `list-build`, `merge-dedupe`.
  2. **Redaction markers are restored only on the Mac.** The daemon keeps a `local-only` marker map per objective and swaps markers back to real values when it assembles. The server never sees the map.
  3. **New kind `agent-assist`** for shaping that needs judgement (`summarize`, `chart-build`, `translate`, `compare`). Czar does not run it. The assembler writes the structured inputs to `.czar/results/` and the `SessionStart` pointer tells the person's own agent (Claude Code in Phase 1) the step is waiting.
  4. **No agent, no `agent-assist`.** The planner adds an `agent-assist` step only when the device reports an agent host (`IngestReport.hosts` non-empty); otherwise it drops the step and says so in the plan. Phase 1 devices always have Claude Code, so this rule matters from Phase 2.
  5. **Cost:** both kinds cost $0, have no payee, no payee leaf and no `stepCap` above `"0"`, and are outside the envelope. Model use by the person's agent is the person's own cost and is never counted by Czar.
  6. **Acceptance:** a `local` step gets the structural profile `local-template-v1` (columns and rows match the plan), checked on the Mac and reported as counts only. An `agent-assist` step is not checked; Czar's claims end at the structured inputs it wrote.
  7. **Shadow mode and ROI:** quotes and the ROI ledger cover paid steps only. Wording says "assembled on your Mac" for `local` and "finished by your agent" for `agent-assist`.
  8. **Manual task entry** (typing a task into the web app without an observer) is not in Phase 1. It is a Phase 2 item (`stage-2-backlog.md` P2-16).
- **Why:** the server only holds redacted values, so it cannot build a usable table; a model on the server would put merchant text in front of a model (against D74) and add cost the envelope cannot see; plain code on the Mac is cheap, private and testable.
- **Amends:** CZ-11 (gains the assembler), CZ-13 step 1 and step 8, CZ-15 `local_running`, P-03 rule 4, spec 02 §4.6.

## 12b. Merchant supply on testnet (2026-10-20)

### D83. Two lanes: the real market is ranked but never paid; the test market is paid for real
- **Context:** Circle's catalog on 2026-10-18 lists 2,195 endpoints payable on Arc mainnet and 134 on Arc testnet, 132 of them Quicknode RPC (ground truth p1-D6). Phase 1 pays only on testnet (D13). So the testnet catalog has about two real merchants to rank, and real merchants cannot be paid with testnet USDC. The specs filtered every Selection Layer query by the plan's network, which would leave the ranking almost empty, and said nothing about mainnet listings.
- **Decided:**
  1. **Two networks, kept apart.** `selection.paymentNetwork` = `eip155:5042002` (Arc testnet) in Phase 1; `selection.marketNetwork` = `eip155:5042` (Arc mainnet). Every plan, payee leaf, reservation, pocket and job uses the payment network only.
  2. **Lane A, the market view (rank-only).** CZ-18 queries Circle's live catalog for the market network (D15, no mirroring, p1-D8), probes each candidate's 402 without paying, and returns a `MarketView`: real services, their live price and payee, and what the unpaid probe showed (reachable, well-formed 402, live price and payee match the listing, response time). It is ordered by readiness tier, then price. It is **not a quality ranking** and says so, because quality needs paid calls.
  3. **Lane A is never payable in Phase 1.** Three independent guards: (a) CZ-18 never puts a market-network service in `RankingDecision.ranked[]` or `unverified[]` for a plan; (b) CZ-13 drops any candidate whose live 402 `network` is not the payment network before a payee leaf exists; (c) `@czar/x402`'s buyer refuses to build a payment for an `accepts[]` entry on any network other than the payment network. Even if all three failed, the vault and USDC on testnet cannot move mainnet funds.
  4. **Lane B, the test market (paid for real).** The real loop (reserve, pay, check, evidence, reputation) runs against: Czar's three merchants (CZ-20, D14); the non-RPC testnet catalog entries that pass a live probe; and the **Czar test-merchant lab**, 6 to 10 Czar-run services that wrap free public data sources and have deliberately different, configured behaviour (reliable, flaky, slow, price-drifting, schema-breaking, payee-changing). The lab exists so the Selection Layer's evidence and ranking show real differences between sellers on testnet.
  5. **Honest labels everywhere.** Lab services carry `extensions.czar.source = "czar-test-merchant"` and `testMerchant: true`; every surface shows "Czar test merchant". Market-view rows show "Real market (Arc mainnet). Listed and reachable; not paid, quality not checked." Lab and Czar-run merchants are one operator for every independence rule (SL operator cluster), so their evidence never counts as independent of each other.
  6. **Evidence is scoped by network.** Reputation rows are keyed by network. Testnet evidence never appears as mainnet quality, and market-view probe results never enter quality posteriors (`delivery`, `structural`, `requirement`); they feed only the readiness fields of `MarketView`.
  7. **Shadow mode uses the real market for prices.** A shadow plan carries `marketReference` (per capability: ready count, lowest and median live price on the market network), so "Czar would have paid about $X" uses real prices. Paid testnet amounts are shown separately.
  8. **Probing is polite and bounded.** Unpaid 402 probes identify Czar in `User-Agent`, are capped per origin per day and globally, use only GET or a body-less POST, never follow a payment, and back off on 429 or 5xx.
  9. **Mainnet quality evidence is a mainnet-gate item.** Paying real merchants with a small real budget to build mainnet posteriors waits for the mainnet gate and Zaryab's explicit multi-step confirmation (`stage-2-backlog.md` MN-8).
- **Why:** it shows discovery and ranking on the real market with real signals, proves payments and evidence end to end on testnet, never pays a real merchant with test money, and never presents test data as real.
- **Open:** AR-11 (legal reading of Circle's terms for live querying and probing) stays open; persisted data is limited to Czar's own probe outcomes keyed by `(resource, payTo, network)`.
- **Amends:** CZ-13 steps 2–3, CZ-18 §5.3, CZ-20 (adds the lab), CZ-08 shadow wording, product §8.5.

## 12c. The task must carry its subject (2026-10-20)

### D84. Function first: every objective carries its real subject from Sam's files to the merchant call
- **Context:** for the flagship objective (fill a competitor price table), the specs removed the task's subject before any payment. Three rules, each added for safety, combined to do this: (1) the Claude Code mapping kept only `tool_response` for file writes and marked it untrusted, so the placeholder detector could never fire; (2) the detector record dropped the surrounding text, so the competitor names were lost; (3) "`inputTemplate` is never user text" left no way for real values to reach a merchant. Czar would charge for searches that could not know what to look up. Root-cause review: the specs were written threat-first, component by component, with no end-to-end data trace for the core task and no acceptance check of the outcome.
- **Decided:**
  1. **Priority order for Phase 1 (the core-value rule).** (a) The task delivers what the person needs. (b) Money guards stay: payees only from the approved `payeeRoot`, amounts bounded by cap, `stepCap` and the vault, envelopes only with approval or earned allowance. (c) Data minimisation and injection hardening come after (a). A class (c) rule that removes an input the task needs is changed, not kept. Class (b) guards are kept because they cost the task nothing.
  2. **Detection reads the user's file.** The placeholder detector is triggered by any file event in a project and reads the **current file from disk** through a local `file_paths` map (`local-only`). Text in the person's own project file is `user-file` trust. `tool_response` stays untrusted and is no longer needed for detection. Files edited outside Claude Code are rescanned daily once they are known.
  3. **New `TaskSpec` object carries the subject.** Built by code (no model) at detection: `kind`, `topic`, `fileName`, `subjects[]` (for a table, the row labels of rows with placeholders), `fields[]` (the placeholder column headers), `context` (surrounding text), `sourceTrust`. It travels in `ObjectiveSubmission` and `Plan` and is part of `objectiveHash` and `planHash`. Layer 1 (secrets) runs on it; layer 2 (PII) does **not** remove values that are in `TaskSpec`, because they are the task.
  4. **All three Phase 1 detectors carry a subject.** `placeholder` → the table rows, list lines or comment text; `repeated-error` → the error text, tool and file name; `agent-refusal` → the person's last prompt before the refusal (`user-prompt` trust).
  5. **Plans bind real inputs.** Steps can fan out per subject (`fanOut: "subjects"`); CZ-13 renders `inputTemplate` with `{{subject}}`, `{{topic}}`, `{{field}}` into concrete `callInputs[]` at plan time, committed in `planHash`. Values a step needs from an earlier step (for example the URL a search returned) use `{{dep.<stepIndex>.<fieldName>}}` and are filled by CZ-15 at run time from that dependency's accepted `StepResult` for the same subject.
  6. **Approval shows and edits the subjects.** The approval screen lists "Czar will look up: …". The person can remove or add subjects; the server re-plans (new `planHash`) and the old plan is `superseded`. Approval is the trust step for subjects.
  7. **Merchants must be able to do the job.** `czar-extract` fetches any public https page through `safeFetch` (the domain allowlist is removed). `czar-search` gets a live backend (`merchants.searchBackend = live`, source chosen in the build plan) with the fixed index kept only for CI fixtures.
  8. **Outcome checks.** The Phase 1 acceptance scenario uses a realistic file with named rows and passes only if the delivered table has those rows filled. Spec 01 gains a data-lineage table per detector. Every spec change gets a "does it still do the job" review, separate from the security review (Gate check G0-18).
- **What still holds for money:** text in a file can now choose *what* Czar looks up. It still cannot choose *who* is paid, *how much*, or open an envelope; those come only from ranked candidates, the approved `payeeRoot`, caps and the vault.
- **Accepted risk:** an injected file edit could make Czar look up the wrong things. Bounded by approval (the subjects are shown) and the money guards above.
- **Amends:** spec 01 §11.2 layer 3 and §13 ASI06 row; spec 02 §4.3, §4.4, §4.5, §4.6, §5.2, §8.2, §9.7; CZ-02, CZ-06, CZ-11, CZ-12, CZ-13, CZ-15, CZ-20, CZ-22; P-03, P-05. Does not amend D74: merchant text still never reaches the planner.

### D85. Czar fills the person's own file in place, with four guards
- **Context:** under D82/D84 the finished table went only to `.czar/results/`, leaving the person to copy values into their own file and merge their own notes by hand. The objective is "fill the table", so that left the core task unfinished.
- **Decided:**
  1. **Fill in place.** For `table-fill`, `list-fill` and `line-fill` objectives, the CZ-11 write-back adapter writes the found values into the person's file, replacing **only** the exact placeholder spans the detector recorded (row `sourceLine`, column, token). No other cell, line or file is changed.
  2. **Clash check.** Before writing, the adapter re-reads the file and fills a placeholder only if that exact token is still at that row and column. Anything that moved or was already filled is skipped and reported. The write is atomic (temp file, then rename).
  3. **Receipt and undo.** The result file in `.czar/results/` stays as the receipt, with the source of each value. The daemon keeps a local undo record; "Undo fill" in the local viewer, or `czar undo-fill <objectiveId>`, restores the placeholders if those cells still hold Czar's values.
  4. **The person chooses.** The approval screen has "Fill {fileName} when done", ticked by default (`Plan.fillInPlace`). Unticked, the person gets the result file only.
  - A value Czar could not find leaves its placeholder in place, so the gap stays visible and the detector can try again.
- **Why:** the task is complete only when the person's own file is filled; their notes and formatting are kept.
- **Amends:** CZ-11 "Does not: modify user files" (now: only the recorded placeholder spans, under these guards); D82 point 6; spec 02 `Plan`, `Result`, `ResultAck`, `createApprovalIntent`.

### D86. No file sharing in Phase 1; the job path and brief stay type-agnostic; Phase 1 job types for the acceptance run decided later
- **Decided:**
  1. **No file sharing in Phase 1.** Approved file attachments for jobs (C1-b) are a stage-2 item, specified in full in `stage-2-backlog.md` (P2-17) so they can be built without redesign.
  2. **C1-a.** The job brief carries the approved `TaskSpec` (topic, subjects, fields, columns, context). `JobBrief.inputs` come from the step's `callInputs`; "never free user text" is removed from spec 02 §4.21.
  3. **Type-agnostic.** There is no job-kind allowlist in `JobBrief`, CZ-13, CZ-14, CZ-15 or CZ-16. The capability taxonomy and `TaskSpec.kind` say what a job is about. A job is planned only when a listed provider claims the capability. Nothing in the specs limits the job path to research, report, summary or non-code work.
  4. **The limit is shown, not enforced by type.** Each Phase 1 job step carries `contextNotice = task-description-only`, and the approval screen says "This job gets only the task description and up to 2,000 characters of context, no files." The person decides.
  5. **Ready for attachments.** `JobBrief` is version 2, with an optional `attachments[]` field reserved and absent in Phase 1; providers ignore optional fields they don't use, so adding it later is backward-compatible.
  6. **Phase 1 acceptance-run job types are open (OD-41).** The Czar test provider (T-108, CZ-20 §5.11) implements whichever modes are chosen; the acceptance scenario names modes, not job types.
- **Referenced from:** CZ-20 §5.11, CZ-13 step 6b, spec 02 §4.21.

## 12d. ERC-8183 job path (2026-10-20, from the Flow 6 review)

### D87. ERC-8183 job-path fixes
- **Context:** a review of the job flow against Circle's verified contract on Arc testnet (implementation `0xA316…351a`, read at block 68,130,229) found edge states the vault could not recover from and gaps in how work is delivered and judged. The contract facts are recorded in the review answers R1–R7 and R14.
- **Decided (vault, applied in spec PR 1):**
  1. **H1.** `syncJob` releases an `Opened` job whose escrow reached `Submitted` or `Completed` without funding (Circle's `submit` accepts `Open` with budget 0). The evaluator never completes an unfunded job and rejects it (N6: it decides only for vault jobs `Funded` or `Submitted` with a matching budget).
  2. **H2.** New `cancelJob`: the vault, as client, rejects an unfunded job while the escrow is `Open`, so the step's cap is freed for an alternate provider. Budget wait 2 h. If a provider front-runs the cancel with a submit, the agent falls back to H1 (N7).
  3. **M1-b.** `fundJob(jobKey, expectedBudget)` reverts `BudgetChanged` if the provider moved the budget; the vault still refuses a budget of 0.
  4. New invariant INV-16 / JOB-5: every unfunded job can be released without a force-close.
- **Decided (job path, applied in spec PR 2):**
  5. **H3, M6, L1 (replaces D53, amends D77).** Deliverables are **pushed**: the provider uploads the bytes to Czar's server with a signed `DeliverableUpload`, then submits their hash. Uploads are append-only by content hash (N4). One cutoff: a deliverable still missing at `decisionCutoff = expiredAt − decisionMarginSeconds − txMarginSeconds` is rejected (N5). In Phase 1 only a provider on the same Mac can reach the server (N3).
  6. **M2, N9.** The evaluator re-reads fees and the escrow implementation right before `complete` and rejects if fees are non-zero. Not atomic; before mainnet an evaluator contract or Czar-owned escrow must make it atomic (MN-10).
  7. **M3, N8.** On freeze, funded-but-unsubmitted jobs are rejected (refund now); submitted jobs are held until unfreeze or the cutoff. The signer always allows the evaluator's `reject`.
  8. **M4, M5.** The brief states `submitBy = expiredAt − evaluationWindowSeconds`; the agent never claims a refund while a decision is pending; job duration is one default with per-capability overrides (no type list).
  9. **H5.** Wording: Czar checked the form of the work, not its correctness.
  10. **N11.** Czar's results folder gets its own `.czar/.gitignore`.
- **Decided (applied in spec PR 3):**
  11. **N1.** Job providers are ranked on `delivery` only in Phase 1; an unverified provider may be used only with explicit approval; the scenario seeds each test provider.
  12. **N2, H6.** Job deliverables can be artifacts, delivered whole; flagged artifacts are held outside the project until the person releases them.
  13. **H7, N12.** Czar runs two instances of a labelled test provider; its modes are whatever it implements, not a limit on job types (D86).
- **Phase 2 (recorded, not built):** H4 reject-and-keep and provider recourse; candidate Czar-owned escrow on `base-contracts` (its claim flow, A4-11; a dispute interface is unconfirmed, N10); revisit D27 when outside providers arrive.
- **Amends:** D53 (replaced), D77, D72 (signer rule for `reject`), D27 (noted for Phase 2).

## 12e. Contract build readiness (2026-10-20, from the contract gap audit)

### D88. Contract build readiness
- **Source:** contract gap audit of `docs/specs/03-smart-contracts/` (74 findings, ids G-01 to G-74) run before the builder PRDs in `docs/specs/07-contract-build/` were written.
- **Decided (vault):**
  1. **Callers.** One binding caller list (`czar-vault.md` §2, §15.1). `reserve`, `reserveWithDigests`, `registerPocket`, `grantPocketGas`, `fundPocket`, `openJob` and `fundJob` are agent-only; the owner never needs them for recovery. `settle` is open to anyone.
  2. **Typed records and getters.** `ICzarVault.sol` declares `Envelope`, `Reservation`, `Pocket`, `Pullback`, `Job`, `CategoryLimits` and `Passkey` in storage packing order, plus a getter for each and `factory()`, `jobEscrow()`, `jobEscrowKind()`. With the two masks in the last slot, `reserve` still writes three new slots.
  3. **Build rules.** New `czar-vault.md` §15 fixes the error for every failed check, the check order, which call emits which event, the guarded functions and the effects order, ids and `jobKey`, the job description format (69 characters, no `0x`), time boundaries, the constructor, owner-action dispatch, autonomy signatures, digest cleanup and repeat pocket funding.
  4. **`isValidSignature` never reverts.** Exact-length and offset checks before `abi.decode` for every kind; `_agentSigned` uses a non-reverting recover; the 65-byte fallback checks `validBefore`.
  5. **Autonomy.** `setCategoryLimits` bumps `autonomyNonce`. The owner's own `openEnvelope` is not bound by `userMax`.
  6. **Invariants.** INV-7 allows a `Closed` pocket to keep `pendingPullback` for records left `Pending` by a force-close; INV-12 holds for open envelopes; JOB-4 holds per envelope.
  7. **Both escrow kinds in Phase 1 bytecode**, selected by the immutable `jobEscrowKind`.
- **Decided (factory):**
  8. `applyGuardian(changeId, newGuardian)` checks the address against the queued hash, as `applyDefaults` does; `changeNonce` makes ids unique; admin `cancelChange`; `guardian()` getter; idempotent pause.
  9. Constructor `(cfg, initialDefaults, guardian_, admin_)` with `Ownable(admin_)`, because under the CREATE2 deployer `msg.sender` is the deployer contract.
  10. The factory embeds the vault creation code, so its runtime hits the 24,576-byte limit first; T-020 measures both, and the size-split PRD moves vault code into linked libraries until both fit.
  11. Deploy salts `keccak256("czar.vault-factory.v1")` and `keccak256("czar.open-evidence-log.v1")`; reproducible build profile.
- **Decided (adapter and tests):**
  12. `library JobEscrowAdapter` has binding internal signatures; `IJobEscrowAdapter` is a type source only; `ICzarJobEscrowClient` gains `reject`.
  13. Vault tests use a one-ledger USDC mock (`MockArcUSDC`: native balance is the USDC balance, as on Arc), a `MockVaultFactory`, and a `CzarVaultHarness` for vectors the public API cannot produce.
- **Independent review (same day):** a fresh reviewer found 16 defects in the first D88 draft; all are fixed. The two high ones: `abi.decode` also reverts on out-of-range narrow head words, so `isValidSignature` range-checks them; and spec 01 §7.1 still gave the owner the agent-only calls. Also: factory `BadParams` for a job-escrow kind above 1 or an agent signer equal to the evaluator; `Job.expiredAt` stored; `raiseAutoLimit` check order.
- **Left to Zaryab:** Gate 0 checks G0-08 and G0-09 (need testnet RPC) and SCR-101 (Arc hardfork name).
- **Amends:** D42 (the size rule now covers the factory), D73 (factory constructor and change lifecycle), RV-030 (adds `setCategoryLimits`).

## 12f. Vault code split into linked libraries (2026-10-20, from the contract build)

### D89. The vault's logic runs in linked external libraries
- **Source:** the reference build behind `docs/specs/07-contract-build/` PRDs 06–10. With every module inside one contract the vault measured 46,505 B runtime and the factory, which embeds the vault's creation code, 52,957 B (limit 24,576 B each, EIP-170). `via_ir` alone gave 38,178 B. D88 item 10 had already said the split would be into linked libraries.
- **Decided:**
  1. All vault storage is one struct, `VaultState`, held by the single variable `_s` at slot 0. Its fields are the `czar-vault.md` §4 variables, grouped so that small fields share a slot; the field order printed in `07-contract-build/03-factory-and-vault-skeleton.md` §7.1 is binding.
  2. The vault's logic is in eight linked external libraries (`CoreLogic`, `EnvelopeLogic`, `ReservationLogic`, `SignatureLogic`, `PocketLogic`, `JobLogic`, `AutonomyLogic`, `OwnerActionLogic`). Each external library function takes `VaultState storage`, a memory copy of the vault's immutables (`VaultConfig`) and, where a caller rule applies, the caller. The vault calls them by `DELEGATECALL`, so they act on the vault's storage and balance and their events are the vault's.
  3. `CzarVault` keeps the immutables, the getters and one thin wrapper per state-changing function; the `nonReentrant` guard stays on the wrapper (`czar-vault.md` §15.5). The passkey path calls the same library functions with `caller = owner`.
  4. Measured (Arc Foundry v0.8.0-2, legacy pipeline, no `via_ir`): vault 14,540 B runtime and 16,233 B initcode; factory 20,747 B and 38,225 B; largest library `JobLogic` 11,867 B. All four limits hold.
  5. The library addresses are fixed in the vault bytecode; there is no way to change them, so this is not a proxy and D33 holds. Each library is deployed through the Arachnid CREATE2 deployer with salt `keccak256("czar.lib.<LibraryName>.v1")` before the factory (`security-and-testing.md` §4 step 1a).
- **Cost:** about 6,000 gas more per vault call (the `DELEGATECALL` and the copied arguments), about 0.00012 USDC at 20 Gwei. The x402 path pays it in `reserve`, in `isValidSignature` and in `settle`.
- **Amends:** D42 and D88 item 10 (the split is now decided, not conditional); 07 PRDs 03–05 rewritten to this layout before any later PRD.

## 12g. Soul inputs beyond observation (2026-10-20, I-F-1)

### D90. Optional, source-labelled soul inputs and user-confirmed open loops
- **Source:** requirement `docs-internal/imperative-features/1_soul-inputs-beyond-observation.md` and plan `docs-internal/technical-plans/I-F-1_soul-inputs-technical-plan.md` (based on build-v1 at f8763b94). Problem: a new user has no soul on day one, because the soul comes only from observed events (product §6.3, CZ-04).
- **Decided:**
  1. **Four source classes.** Every belief records the class that created it: `observed` (today's path, unchanged), `declared` (the person's own answer or edit in the local viewer), `local-file` (instruction files or tracked git work the person selected) and `imported` (pasted text or an agent-written summary). A supporting receipt never upgrades the creator's class.
  2. **Proposals are not beliefs.** File, git, paste and agent-summary inputs become `ProposedBelief`s. They stay out of `soul.json`, the drives engine, model excerpts of the current soul and exports until the person accepts them in the local viewer (CZ-05), an authenticated action that no model, MCP call or prompt can perform.
  3. **Confirmed beliefs.** A declared belief, or an accepted proposal, has `confidenceBasis = user-confirmed` and `confidence = 1`. The 1 means "the person attested this", not statistical certainty; the viewer says "Confirmed by you", never "100%". These beliefs skip `soul.minReceipts` and `soul.activeConfidence`, do not fade, and are reviewed (not changed) when a deadline passes or observation contradicts them. Observed beliefs keep CZ-04 §5.2 unchanged.
  4. **Interview.** A five-minute, optional interview in the local viewer covers `place`, `mission`, `constraints`, `taste`, `spendingPosture` and `hourlyValue`. Deterministic templates map each answered question to one belief (`hourlyValue` sets the hourly value and makes no belief); no model call is needed. Skipping keeps observation-only behaviour.
  5. **Interview bundle as a declaration (open decision 3, accepted).** An interview run by the Czar skill inside an agent host arrives as pending proposals that carry the exact questions and answers. One authenticated bundle confirmation in the viewer may promote them to `declared` only when every answer is shown in full, word for word, against a fixed interview question id, with edit and undo. The receipt keeps the agent-mediated origin. A model paraphrase is never `declared`; it stays an `imported` proposal even after acceptance.
  6. **Display-only sections (open decision 4, accepted).** In Phase 1 only three soul inputs change Czar's behaviour: confirmed `constraints` (into `ObjectiveSubmission.constraints`), a mission deadline that matches the objective's project (into `Objective.deadline`), and `hourlyValue` (into ROI). `taste`, `place` and `spendingPosture` are saved context. The viewer labels them "Saved context; Czar does not use this to make decisions yet." They are revisited as consumers only with I-F-2 feature 2.5.
  7. **No soul-to-vault path.** No soul input, interview answer or proposal can write a vault setting, a limit or a payee. A person who wants a lower limit uses the existing CZ-22 owner action.
  8. **Phase 1 cuts.** Agent files: only `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md` in a project root the daemon already knows (CZ-02 `file_paths`); the global `~/.claude/CLAUDE.md` only on its own selection. Git: tracked files, commit subjects (≤ 50, ≤ 30 days) and tracked TODO markers. Import: paste only; archive upload waits for SCR-031. MCP: `propose_soul_context` creates proposals only. Manual task entry stays P2-16. No native folder picker.
  9. **New prompt P-07 `source-belief-extractor`.** Order for model-assisted sources: layer 1 (stored), layer 2, P-01 screen, then P-07 on the paragraphs P-01 passed. Strict JSON output; every proposal must point at a real span of its input. If any step fails, the source produces no automatic proposal. P-07 runs through the D31 proxy and counts against `models.userMonthlyTokens`.
  10. **User-confirmed open loops (open decision 1, accepted with a hold).** The confirmation route is detector-agnostic: CZ-06 gains one eligibility branch, `eligibility = user-confirmed`, that needs a typed local source-evidence receipt and an authenticated confirmation receipt for the same current `TaskSpec`. Phase 1 has one adapter, a placeholder in a current user file; other detectors may add adapters later by defining trust, freshness and confirmation rules only, never a new receipt shape or hash. A confirmed objective may carry zero `observationHashes`; nothing fakes an observation. The wire field `demandEvidence`, `czar-objective-v2`, the confirm route and every public-evidence change are held in SCR-030 and applied only with the paused Flow 7 review (item 13).
  11. **Shadow exception (open decision 2, accepted).** An authenticated **Do this** lets that one objective skip the seven-day shadow default. It is not spending approval: every confirmed objective needs the owner's approval of its plan, and earned allowance never funds it. Shadow mode is not switched globally, a deliberate "watch only" choice still wins, and confirmed objectives count toward the existing `drives.maxCandidatesPerDay` and per-project caps and dedupe; no new count limit is added. The rule is specified now; it is built with SCR-030 because the server cannot tell a confirmed objective apart until the wire field exists.
  12. **Interim soul hash (change to the plan).** Until Flow 7 chooses `czar-soul-v2`, `soulVersionHash` keeps the `czar-hash-v1` preimage unchanged. A non-observed belief's `receipts` hold `src_` ids, committed as opaque ids exactly like `evt_` ids, and its `confidence` of 1 is committed. Because the id prefix names the receipt type, a later reveal still shows whether a belief came from observation. Every compiled version records its `soulHashRule` locally. The first `czar-soul-v2` version links `previousHash` to the last v1 version; v1 versions stay verifiable under v1.
  13. **Held for Flow 7 (SCR-030).** Applied only together with the paused Flow 7 evidence review: `czar-soul-v2` and the `SoulVersionLeaf` v2; the `DemandProofLeaf` v3 "user-confirmed demand" variant; `czar-objective-v2`; `ObjectiveSubmission.demandEvidence` and empty `observationHashes`; `confirmLocalOpenLoop`, `OpenLoopPreview` and `DemandConfirmationReceipt`; server shadow and owner-only enforcement; CZ-13 and CZ-22 approval display; CZ-17 and OpenEvidenceLog verifier changes. OpenEvidenceLog and the vault's `SL_RECEIPT` path are not changed until that review ends.
- **Rejected from the plan:** a `proposed` value in `Belief.state`. A proposal is its own object (`ProposedBelief`); `soul.json` never holds one, so the state is not needed.
- **Why:** gives a useful soul on day one without letting untrusted text, a model or an agent host write the soul or move money; keeps every hash honest by holding the new commitments for the one review that owns public evidence.
- **Accepted risk:** a person may accept a plausible false proposal or a convincing agent summary; the source label and excerpt stay visible and the belief can be deleted. Until SCR-030 lands, non-observed beliefs are committed under v1 without their class in the preimage (item 12).
- **Amends:** product §§3.2, 6.3, 7.2; roadmap §§1.1, 1.5, 3; spec 01 CZ-02/04/05/06/07/08/09, §11.1, §13; spec 02 §4.2, new §4.23–§4.26, §5.2 note, §7.1, §9.2, §9.7, §10, §13.1, §15.3; local OpenAPI 1.1; server OpenAPI (`completeModelCall` accepts P-07); MCP tools §2.6; CZ-02, CZ-26, CZ-04, CZ-05, CZ-06, CZ-07, CZ-08, CZ-09, CZ-22; ai-prompts P-01, P-07; cross-cutting §4, §6; phase-1-tasks T-109 to T-114; G0-18; stage-2 P2-20, P2-21. SCR-030 and SCR-031 filed.

---

## 13. Open items (deferred)

- **OD-41 Phase 1 acceptance-run job types:** to be chosen later from the I-R-2 findings (agent job market landscape); not constrained by the architecture (D86). T-108 implements the chosen modes; scenario steps 6.2–6.7 name the mode.

- **Tool manipulation:** tools that try to get agents to call them more often. To be researched.
- **Conflict of interest:** Czar both recommends tools and routes money to them. An AI dispute judge may be added later.
- **Fairness for new builders:** star-based admission favours incumbents (D16).
- ~~Builder identity design (D18)~~ — settled by D23.
- **Business model** (D12).
