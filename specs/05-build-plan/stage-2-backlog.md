# Czar stage-2 backlog: everything deferred, in priority order

- **Purpose:** one place for all work deliberately left out of the current stage, so nothing is lost.
- **Rule:** an item moves out of this file only when it is scheduled into a build plan or rejected. Record which.
- **Created:** 2026-10-19
- **Priority key:** P1 = do first after Phase 1 ships · P2 = next · P3 = later · Gate = must happen before a named event.

---

## 0. Status

- **D69 confirmed (2026-10-19): mobile-specific work moves to stage 2.**
  - Phase 1's approval app runs in a desktop browser (passkeys work in desktop Safari and Chrome on macOS).
  - The in-app pending-approvals list stays the source of truth for approvals (spec 01 §4.3, D2-07 guidance).
  - Spec updates in §1: **applied 2026-10-19** (D63–D69), recorded in `amendment-verification.md` § "D63–D69".

---

## 1. Spec updates needed if D69 is confirmed (do before Gate 0 review) — **Applied 2026-10-19**

- `product/decisions-log.md`: add D69; mark D28 "Home Screen web app first" as stage 2.
- `specs/01-system-architecture/`: §4.3 app, §5 deployment, §18 phase map — desktop browser for Phase 1.
- `specs/04-components/app-and-notifications.md`: CZ-22 Phase 1 = desktop web; CZ-23 push = stage 2.
- `specs/04-components/phase-1-acceptance-scenario.md`: replace phone steps with desktop-browser approval steps.
- `specs/05-build-plan/`: remove G0-02 and G0-15 from Gate 0; trim T-080, T-082, T-083 (below).

---

## 2. Mobile (P1 after Phase 1)

| # | Item | Source | Notes |
|---|---|---|---|
| M-1 | Passkeys inside the installed iPhone Home Screen web app | G0-02, D28, D1-11 | Decides web app vs native app |
| M-2 | Native app fallback if M-1 fails | D28 | Needs associated domains (D1-02) |
| M-3 | Home Screen install onboarding (iOS 16.4+ for push) | T-080, T-082, D2-01 | |
| M-4 | Web push notifications, Declarative Web Push | T-083, G0-15, CZ-23, D2-04–D2-07 | Visible notifications only |
| M-5 | Mobile layouts for approvals, freeze, receipts | T-084–T-086 | Desktop layouts ship in Phase 1 |
| M-6 | Soul on the phone via end-to-end encrypted sync | D34 | |

---

## 3. Product Phase 2 (P2)

| # | Item | Source |
|---|---|---|
| P2-1 | Observers for Codex (with `/hooks` trust onboarding), Cursor, Chrome | D7, B2-09, B3, B4 |
| P2-2 | Full Selection Layer (validators, probes, ERC-8004 mirroring) | spec 01 §15.4 |
| P2-3 | Pay on acceptance, full version | product §6.14 |
| P2-4 | Standing objectives | product §6.15 |
| P2-5 | Context minimization, full version | product §6.12 |
| P2-6 | Soul injection into other agents (CZ-10) | product §6.5 |
| P2-7 | Recipe splits (`RecipeSplits`) and builder escrow (`BuilderEscrow`) | D29, D44 |
| P2-8 | Builder claims: GitHub sign-in, committed file, claim server (CZ-21) | D23 |
| P2-9 | Builder vetting and onboarding (star checks etc.) | D24 |
| P2-10 | IPFS pinning of evidence archives | D54 |
| P2-11 | Local soul-compiler model | D31 |
| P2-12 | Local currency display | D51 |
| P2-13 | Daemon on Linux and Windows | OD-39, D67 |
| P2-14 | Snapshot routes (`/v1/snapshots`) | AM-07 |
| P2-15 | Atomic freeze-lowers-limits in the contract | OD-35, D63 |

---

## 4. Product Phase 3 (P3)

| # | Item | Source |
|---|---|---|
| P3-1 | Team soul and team vault | product §6.13 |
| P3-2 | Demand radar | product §6.16 |
| P3-3 | Unmet-demand ERC-8183 jobs | product §6.17 |
| P3-4 | Exploration budget for new merchants | product §6.18 |
| P3-5 | Merchant fix-it feedback | product §6.19 |
| P3-6 | Signed quotes and `upto` pricing | product §6.20 |

---

## 5. Before mainnet (Gate: mainnet)

| # | Item | Source |
|---|---|---|
| MN-1 | External audit of all contracts | spec 03 security-and-testing |
| MN-2 | HSM decision | D61 |
| MN-3 | Gateway mainnet gaps A2-G2 (code hash) and A2-G3 (delegate burns) | part 2 GAPs |
| MN-4 | AR-4 `authorizationState` read on mainnet | spec 01 §20 |
| MN-5 | Deploy Czar-owned ERC-8183 instance (`CzarJobEscrow`) | D27, D32 |
| MN-6 | Re-pin all external addresses and implementations | spec 01 §6.2 |
| MN-7 | Remove the test-keystore vault owner used in M3–M4 | OD-36, D64 |

---

## 6. Google Cloud hosting (P1 after Phase 1; must happen before outside testers join) — D70

| # | Item | Notes |
|---|---|---|
| GC-1 | Create the Google Cloud account and project | Zaryab's action; $300 new-account credit needs a card |
| GC-2 | `gcp-kms` signer backend; run the original G0-13 check | Software-level secp256k1 keys ≈ $0.06/key/month, $0.03 per 10,000 signatures (Cloud KMS pricing page, read 2026-10-19) |
| GC-3 | Move K3, K5, K6, K7, K8, K10, K20 and the relayer key to KMS; re-register `agentSigner`/`autonomySigner` on each vault | Owner UserOp per vault (`rotateSigners`) |
| GC-4 | API on Cloud Run | Always-free tier: 2M requests/month |
| GC-5 | Indexer on an always-free e2-micro VM (us-west1, us-central1 or us-east1) | Public IPv4 ≈ $3.65/month; IPv6 free |
| GC-6 | Postgres: free external provider or on the VM | Google has no free managed Postgres; check provider limits at the time |
| GC-7 | Uptime alerts, backups, secret store for API keys (K11, K12, K17–K19) | |

---

## 7. Deferred discussions (no date)

| # | Topic | Source |
|---|---|---|
| DD-1 | Agent-commerce social network proposal (read-only evidence feed; demand threads) | `product/agent-commerce-social-network-proposal.md` |
| DD-2 | Business model | D12 |
| DD-3 | Tool manipulation by merchants | decisions log open items |
| DD-4 | Conflict of interest; AI dispute judge | decisions log open items |
| DD-5 | Fairness for new builders | D16, D24 |

## Change log

| Date | ID | Change |
|---|---|---|
| 2026-10-19 | D69 | §0 status set to applied; §1 marked Applied; D-numbers added to P2-13, P2-15, MN-7. |
| 2026-10-19 | D70 | Added §6 Google Cloud hosting (GC-1 to GC-7). |
