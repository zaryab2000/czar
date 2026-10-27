# 01 — System architecture

- **Status:** draft written 2026-10-18, awaiting Zaryab's review of the open decisions (OD-1 to OD-8 in `system-architecture.md` §21). Specs 02–05 wait on that review.
- **Inputs:** `docs/product/czar-product.md`, `docs/product/decisions-log.md`, `docs/product/feature-roadmap.md`, `docs/specs/00-ground-truth/circle-arc.md`, `docs/specs/00-ground-truth/part2.md`, `docs/architecture/selection-layer-architecture.md`.

## Files

| File | What it is |
|---|---|
| `system-architecture.md` | The architecture spec: 24 sections, Mermaid diagrams inline, traceability to D1–D28 and the 36 forced-design items. |
| `README.md` | This file. |

## Summary

- Four places: the user's machine observes, remembers, compiles the Work Soul and generates objectives; Czar's server plans, pays and proves; a web app in a desktop browser approves and freezes (D69; the iPhone Home Screen app is stage 2); Arc holds the money rules and evidence anchors. Raw work data stays on the machine; only redacted excerpts and redacted objectives leave it (D25, D31). Phase 1 runs locally on one Mac (D70).
- One `CzarVault` per user, owned by the user's Circle Modular Wallet passkey account, which acts as `msg.sender` through UserOps. The vault is the ERC-1271 x402 payer (proven, A1-17) and the ERC-1271 delegate for Gateway pullbacks.
- Spending accounting is reserve-then-settle: an on-chain reservation per payment, settlement confirmed by reading USDC's `authorizationState`, and self-releasing expiry. A hijacked server key can only spend inside approved envelopes, to pre-approved payees, under per-step caps.
- Pocket wallets for Gateway-only merchants: per-objective EOA, funded by `depositFor` only after the vault verifies it is the pocket's delegate, capped at 25% of the envelope, pulled back in about 2 s.
- "Pay on acceptance" is enforced on-chain only for ERC-8183 jobs (Czar as evaluator). For x402 and nanopayments it means "checked before the next step", with evidence and ranking as the consequence.
- The Selection Layer is adopted (`OpenEvidenceLog`, receipts, posteriors, policy) with probers, validators and ERC-8004 mirroring deferred; Czar adds demand-proof and soul-version leaves.
- Eight open decisions need Zaryab's call, led by the Phase 1 boundary for `RecipeSplits` (recommended: Phase 2) and the soul compiler model (recommended: hosted model over redacted excerpts, with disclosure).

## Change log

| Date | ID | Change |
|---|---|---|
| 2026-10-19 | D69 | Summary says the Phase 1 app runs in a desktop browser; Home Screen app is stage 2. |
| 2026-10-19 | D70 | Phase 1 runs on Zaryab's Mac with a local software signer (encrypted keystore); Google Cloud (KMS, Cloud Run, e2-micro VM) moves to stage 2. |
