# Czar decisions log

- **Purpose:** every product decision made so far, with the reasoning. Specs follow these decisions unless a later entry changes them.
- **Format:** each decision states what was decided and why. Open items are listed at the end.
- **Last updated:** 2026-10-18

---

## 1. What Czar is

### D1. Payment is the core, not recommendations
- **Decided:** Czar lets a person pay for a better version of their work. It pays x402 merchants, ERC-8183 specialist agents and builders, in USDC on Arc.
- **Not:** a recommendation engine, a discovery-only tool, or a paid-placement system.
- **Reference model:** Onda, a browser extension that pays artists per listen in USDC on Arc, with escrow that unclaimed artists can claim later. Czar is far more complex than Onda in observation, discovery, evidence and contracts.

### D2. x402 merchants and the discovery layer are the primary beneficiaries
- **Decided:** the observing and recommending agent is the front of the product. Behind it, Czar is also a marketplace of its own, with evidence-based discovery.
- **The marketplace uses multi-input ranking,** specified in `architecture/selection-layer-architecture.md`.
- **Evidence loop:** every time a merchant serves a user, the user provides evidence that the merchant delivered what it promised. That evidence improves the merchant's ranking and future recommendations.
- **Why:** merchants and specialist agents earn very little today. Czar brings them new buyers who would never have searched for them, and fairer discovery.

### D3. Builders are a supporting part
- **Decided:** open-source builders, skill makers and plugin makers are included, but they are a supporting part of the product, not its core.
- **Why it's kept:** it shows that agents using x402 on Arc can pay open-source builders, who usually earn nothing from use.
- **How they're paid:** through recipes with on-chain revenue splits (feature roadmap 2.5), with escrow for builders who haven't claimed their identity yet.

### D4. The feature roadmap is adopted in order
- **Decided:** every feature in `product/feature-roadmap.md` is part of Czar, in the exact order and priority given there.

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
- **Ground truth:** `specs/00-ground-truth/circle-arc.md` fact D8 records the terms and the "query live, don't mirror" approach.

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
- **Amended by D69:** Phase 1 runs the approval app in a desktop browser; the Home Screen web app and iPhone checks move to stage 2.
- **Decided:** the user app ships first as a web app installed to the Home Screen.
- **Early check:** test passkeys inside the installed web app on a real iPhone (gap D1-11). If they fail, switch to a native app.

---

## 8. Architecture follow-ups (2026-10-18, from `specs/01-system-architecture/system-architecture.md` §21)

### D29. Phase 1 pays merchants and specialist agents only (OD-1)
- **Decided:** `RecipeSplits` and `BuilderEscrow` move to Phase 2. Phase 1 plans pay x402 merchants and ERC-8183 agents only.
- **Amends:** product §11.1 and roadmap §3 ("one recipe with on-chain splits" moves to Phase 2). Follows D24.

### D30. Owner approvals go through a UserOp from the user's smart account (OD-2)
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

## 9. Contract and protocol follow-ups (2026-10-18, from `specs/02-data-and-protocol/` and `specs/03-smart-contracts/`)

### D38. Routing fee ratio target is 10% (OD-10)
- **Decided:** the on-chain cost of sending a payment should not exceed 10% of its value (routing policy parameter `maxFeeRatioBps = 1000`). D37's hard limit (cost never above the payment) still applies.

### D39. At most 128 authorizations per reservation (OD-11)
- **Decided:** `MAX_AUTHORIZATIONS_PER_RESERVATION = 128`.

### D40. Earned-autonomy raise step: 20% of `userMax`, at most once per week (OD-12)
- **Decided:** a starting value, to be tuned later.

### D41. Owner-only manual credit for pocket funds returned through the 7-day withdrawal (OD-13)
- **Decided:** only the owner can credit back funds returned through Gateway's slow withdrawal path.

### D42. Single vault contract vs external library decided after a size build (OD-14)
- **Decided:** the build measures contract size first; the split is chosen then.

### D43. Per-step caps live inside each payee leaf (OD-15)
- **Decided:** alternates share the step's cap because the cap is part of the leaf.

### D44. Builder escrow: 48-hour delay, 0.01 USDC minimum tip (OD-16, Phase 2)
- **Decided:** starting values for Phase 2.

---

## 10. Component follow-ups (2026-10-18, from `specs/04-components/amendments-and-open-decisions.md`)

### D45. Layer-2 redaction runs in a bundled Python Presidio helper (OD-17)
- **Decided:** The helper ships inside the daemon installer (packaged with `uv`); users never install Python. Node regex is the forced-review fallback when the helper is down.

### D46. Claude Code hooks use `http` by default (OD-18)
- **Decided:** `http` handler with `onFailure: continue`; automatic fallback to `command` with `async: true` where managed `allowedHttpHookUrls` policies block it (B1-18).

### D47. Outbound objectives: first five reviewed, then automatic (OD-19)
- **Decided:** The user reviews the first five objectives before they leave the machine; after that they go automatically, with review still available.

### D48. Pocket-worthiness volume is measured per objective (OD-20)
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
- **Decided:** Defines amendment AM-08.

### D54. Evidence archives stay on Czar's server in Phase 1; IPFS pinning is Phase 2 (OD-26, changed)
- **Decided:** Hashes are anchored on-chain, so archives remain verifiable. Pin providers are chosen in Phase 2.

### D55. A structural check with no schema and no history records `inconclusive` (OD-27)
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
- **Decided:** as stated.

### D61. Key management: cloud KMS with a signer service; vendor chosen at build time (OD-33)
- **Amended by D70:** Phase 1 uses a local software signer; Google Cloud KMS comes in stage 2.
- **Decided:** Testnet uses cloud KMS. Whether an HSM is required is decided at the pre-mainnet audit (AR-1).

### D62. The relayer gas key is held in KMS (OD-34)
- **Amended by D70:** in Phase 1 the relayer gas key sits in the local keystore.
- **Decided:** Not a hot wallet.

---

## 11. Build-plan follow-ups (2026-10-19, from `specs/05-build-plan/build-plan.md`)

### D63. Freeze lowers limits in a follow-up agent step, not atomically (OD-35)
- **Decided:** the `frozen` flag already blocks all spending; the agent then calls `lowerAutoLimit(category, 0)` per category (D60). An atomic contract version is in the stage-2 backlog.

### D64. A test-keystore vault owner is allowed on testnet for M3–M4 (OD-36)
- **Decided:** testnet only, until the app exists; removed in M6 and listed in the pre-mainnet checklist.

### D65. Docs lagging D51 are fixed before the Gate 0 review (OD-37)
- **Decided:** spec 01 §4.3 and §8.2, product §4.1 and §9.2 updated to USD-only wording.

### D66. One cloud provider for server, indexer and KMS, chosen before M2 (OD-38)
- **Amended by D70:** provider chosen: Google Cloud, in stage 2. Phase 1 runs locally.
- **Decided:** provider still open; must offer a key-management service and managed Postgres.

### D67. The Phase 1 daemon supports macOS only (OD-39)
- **Decided:** Linux and Windows are in the stage-2 backlog.

### D68. Model prices are read during task T-046 (OD-40)
- **Decided:** cost budgets stay in tokens and request counts until then.

### D69. Phase 1 approvals run in a desktop browser; mobile work moves to stage 2
- **Decided (2026-10-19):** the approval app runs in a desktop browser in Phase 1 (passkeys work in desktop Safari and Chrome on macOS). The in-app pending-approvals list is the source of truth.
- **Moves to stage 2:** iPhone Home Screen install, iPhone passkey test (G0-02), web push (G0-15, CZ-23), mobile layouts, native-app fallback. See `specs/05-build-plan/stage-2-backlog.md` §2.
- **Amends:** D6 and D28 (the Home Screen web app comes in stage 2).

---

### D70. Phase 1 runs locally on Zaryab's Mac for $0; Google Cloud comes later
- **Decided (2026-10-19):**
  - **Phase 1 (testnet):** the server, paying agent, indexer, Czar's merchants, Postgres (Docker) and the signer service run as local processes on Zaryab's Mac, against Arc testnet. No cloud cost.
  - **Keys:** a **local software signer** with an encrypted keystore. Its passphrase is held in the macOS keychain. Testnet keys only; never committed; never real funds.
  - **Same interface:** the signer service keeps one backend interface (`signer.backend = local-keystore | gcp-kms`), so moving to cloud KMS is a configuration change plus key re-registration on the vaults.
  - **Later (stage 2, before outside testers join):** Google Cloud. Cloud KMS for server keys, Cloud Run for the API, an always-free e2-micro VM for the indexer, and a free external or VM-hosted Postgres. See `specs/05-build-plan/stage-2-backlog.md` §6.
- **Trade-off accepted:** in Phase 1 the paying agent runs only while the Mac is awake (relaxes the always-on aim of D25 for testnet).
- **Amends:** D61 (cloud KMS deferred to stage 2), D62 (relayer gas key in the local keystore in Phase 1), D66 (provider chosen: Google Cloud, for stage 2).

---

## 12. Open items (deferred)

- **Tool manipulation:** tools that try to get agents to call them more often. To be researched.
- **Conflict of interest:** Czar both recommends tools and routes money to them. An AI dispute judge may be added later.
- **Fairness for new builders:** star-based admission favours incumbents (D16).
- ~~Builder identity design (D18)~~ — settled by D23.
- **Business model** (D12).
