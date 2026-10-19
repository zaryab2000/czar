# Czar ground truth, part 1: Circle and Arc

- **Date:** 2026-10-18
- **Author:** Claude, research lead
- **Purpose:** the verified facts about Circle and Arc that Czar's specs depend on. Every later spec cites this file instead of re-stating facts.
- **Scope:** Circle Agent Stack (wallets, Gateway Nanopayments, Facilitator, Discovery API, CLI), Arc chain, ERC-8183 and ERC-8004 as deployed on Arc.
- **Out of scope:** everything else Czar depends on. That is listed in `specs/00-ground-truth/research-prompt-part2.md` for a separate researcher.

## Grades
- **CONFIRMED** — checked first-hand: run on Zaryab's machine, read from chain via RPC, read in shipped code, or read in a verified ABI.
- **DOCS** — read in official Circle or Arc documentation, not tested.
- **STRONG SIGNAL** — several consistent sources, or a strong inference from confirmed data.
- **GAP** — not verified. Carried into the research prompt.

## Evidence sources

| Tag | Source | Date |
|---|---|---|
| [HL] | `/Users/zar/Code/ai-on-chain/agent_economy_research/circle/hands-on-log.md` — commands run on Zaryab's machine | 2026-10-09 |
| [ARCH] | `/Users/zar/Code/ai-on-chain/agent_economy_research/circle/architecture.md` | 2026-10-09 |
| [OC] | `/Users/zar/Code/ai-on-chain/agent_economy_research/circle/data/2026-10-09-onchain-notes.md` — RPC reads, Gateway contract source | 2026-10-09 |
| [ACT] | `research/references/circle-agent-stack-by-actor-2026-10-10.md` — CLI 1.2.0 source and docs | 2026-10-10 |
| [TV] | `/Users/zar/Code/ai-on-chain/agent_economy_research/circle/trust-and-verification.md`, `merchant-experience.md`, `buyer-experience.md`, `cli-command-tree.md` | 2026-10-09 |
| [LAB] | `/Users/zar/Code/ai-on-chain/agent_economy_research/research_docs/learning-notes/crash-courses/arc-lab/` — ABIs (verified from the Arc testnet explorer) and scripts | 2026-10-17 |
| [GT] | `research/evidence/arc-circle-docs-2026-10-18.md` — live Arc and Circle docs | 2026-10-18 |
| [CAT] | `research/evidence/discovery-catalog-snapshot-2026-10-18.md` — full Discovery API crawl | 2026-10-18 |

---

## 1. Arc chain

| # | Fact | Grade | Source |
|---|---|---|---|
| A1 | Arc mainnet chain ID `5042`. Arc testnet chain ID `5042002`. | CONFIRMED | [HL], [GT] |
| A2 | Mainnet RPC `https://rpc.mainnet.arc.io`, explorer `https://explorer.arc.io`. Testnet explorer `https://explorer.testnet.arc.io`. | DOCS | [ARCH], [GT] |
| A3 | **Two testnet RPC hostnames are in use:** `rpc.testnet.arc.network` (Circle CLI) and `rpc.testnet.arc.io` (Arc docs). | CONFIRMED (both observed) | [ARCH] |
| A4 | **USDC is the gas token. One balance, two views:** native balance at 18 decimals; ERC-20 interface at `0x3600000000000000000000000000000000000000` at 6 decimals. A faucet drip of 20 USDC showed `20e18` native and `20,000,000` ERC-20. | CONFIRMED (RPC) | [HL], [LAB] |
| A5 | **Decimals trap:** an amount written with 18 decimals into a 6-decimal ERC-20 call is a trillion times too large. In ERC-8183, `fund()` reverts on it. | CONFIRMED in script design; run status GAP | [LAB] `02-erc8183-job.ts` |
| A6 | Transactions with `maxFeePerGas` below 20 Gwei are silently dropped with no receipt. Base fee range 20–20,000 Gwei. Target cost ≈ $0.001 per ERC-20 transfer. ~0.5 s blocks. | DOCS | [GT] |
| A7 | Osaka EVM baseline plus EIP-7708 (Transfer logs for native USDC moves). `PREVRANDAO` always returns 0 — **no on-chain randomness**. Timestamps only non-decreasing at 1 s granularity. Final on inclusion. | DOCS | [GT] |
| A8 | Blocklist enforced at runtime: a transfer can revert even with enough balance. Sending value to `0x0` reverts. | DOCS | [GT] |
| A9 | Use Arc Foundry's `arc-anvil`, not standard anvil, to reproduce Arc behaviour locally. | DOCS | [GT] |
| A10 | Arc mainnet launched 2026-09-16 (docs give no date). Permissioned PoA validators; PoS planned for 2027. | STRONG SIGNAL | [GT], [ACT] |
| A11 | Faucet: 20 testnet USDC per request, arrived in ~20 s. | CONFIRMED | [HL] |
| A12 | Testnet bridge fee quote (ARC-TESTNET from BASE-SEPOLIA): `minimumFee 1.3` (units as returned). | CONFIRMED | [HL] |
| A13 | Testnet USDC→EURC swap quote ~1.0714 EURC per USDC; the quote's suggested floor is 0.000001 EURC. **Never copy a quote's floor into a real swap.** | CONFIRMED | [HL] |

## 2. Circle Gateway and Nanopayments

| # | Fact | Grade | Source |
|---|---|---|---|
| G1 | GatewayWallet address: mainnets `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE`; **all testnets `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`**. The `0x7777…` address has no code on Arc testnet. | CONFIRMED (RPC + CLI) | [HL], [OC] |
| G2 | Buyer signs an EIP-3009 authorization against the GatewayWallet domain `GatewayWalletBatched` v1, valid ≥ 7 days (`maxTimeoutSeconds: 604900` seen in a live 402). | CONFIRMED (live 402) | [HL], [ACT] |
| G3 | **The Gateway buyer signer is an EOA.** For a Circle agent wallet, the wallet's backing EOA signs through Circle MPC. The SDK `GatewayClient` takes a private key. | CONFIRMED (CLI source, SDK) | [ARCH], [ACT], [LAB] |
| G4 | A Gateway deposit is required before paying. CLI minimum 0.5 USDC. Gateway balances are per source chain, with no cross-chain pooling at payment time. | CONFIRMED (CLI source, skill text) | [ACT], [TV] |
| G5 | **Settlement runs on a clock:** `submitBatch(bytes,bytes)` (selector `0xc9486c8b`) on a ~960 s (16 min) tick that skips empty ticks. Median payment-to-`completed` ~14 min. Batch signer is in an AWS Nitro Enclave; one relayer EOA. Deltas are netted per depositor. | CONFIRMED (on-chain logs, contract source) | [OC], [ARCH] |
| G6 | **Settle happens before the seller's handler runs, and there is no refund or void call.** If the handler then fails, the buyer has paid for nothing. | CONFIRMED (SDK tarball read) | [TV], [ACT] |
| G7 | Minimum payment $0.000001. No published per-payment fee; 0.5 bps on crosschain payments. | DOCS | [ACT], [GT] |
| G8 | `withdrawalDelay()` = 1,209,600 on Arc mainnet and testnet (≈ 7 days if the unit is blocks at 0.5 s). Unit unconfirmed from source. | CONFIRMED (value); GAP (unit) | [OC] |
| G9 | CLI `gateway withdraw` is same-chain only. | CONFIRMED (CLI help) | [TV] |
| G10 | **Public, keyless payment records:** `GET https://gateway-api.circle.com/v1/x402/transfers?to=<payTo>` (and `gateway-api-testnet`) returns per-payment buyer, amount, nonce, status (`received → batched → completed`) and batch tx hash. `pageSize` max 100; cursor in the `link` header. | CONFIRMED (called live) | [HL] |
| G11 | Seller middleware: `createGatewayMiddleware({ sellerAddress, facilitatorUrl, networks })` from `@circle-fin/x402-batching/server`, then `gateway.require("$0.001")`. Testnet facilitator `https://gateway-api-testnet.circle.com`; omitting it means **mainnet** (since SDK 3.0.0). | CONFIRMED (built and returned a valid 402) | [HL], [LAB] `seller.ts` |
| G12 | Buyer code path: `new GatewayClient({ chain: "arcTestnet", privateKey })` → `deposit()`, `getBalances()`, `supports(url)`, `pay(url)`, `searchTransfers()`. | CONFIRMED (code); end-to-end run GAP | [LAB] `03-nanopayment.ts` |
| G13 | SDK versions in working code: `@circle-fin/x402-batching` 3.5.0, `@x402/core` 2.28.0, `@x402/evm` 2.28.0, `viem` 2.57.x. Buyer SDK needs Node ≥ 22.18. | CONFIRMED (package files); DOCS (Node) | [LAB], [GT] |
| G14 | Gateway is in Gateway domain 26 for Arc; SDK chain names `arc` and `arcTestnet`. | DOCS | [GT] |

## 3. Circle Facilitator Service (vanilla x402)

| # | Fact | Grade | Source |
|---|---|---|---|
| F1 | Buyer signs EIP-3009 against the **USDC** contract (domain `USDC` v2). One on-chain transfer per payment. | CONFIRMED (live 402) | [HL], [ACT] |
| F2 | **A smart-contract account can sign, via ERC-1271, but only once deployed.** ERC-6492 (undeployed) is not supported. | DOCS + CLI source | [ARCH], [TV] |
| F3 | Endpoints: `POST https://api.circle.com/v1/facilitator/x402/verify`, `/settle`, `/status/{paymentId}`, `/supported`. | CONFIRMED (verify called) | [HL], [ACT] |
| F4 | **Keyless seller trial:** header `Facilitator-Seller-Proof` = base64url EIP-712 `SellerRequest` signed by the `payTo` key, bound to purpose, method, body hash, network, nonce and a 5-minute expiry. A real `/verify` call returned `isValid:false, insufficient_funds` from an unfunded buyer — the path works end to end. After the trial: `403 registration_required`, then a Console API key. | CONFIRMED | [HL], [ARCH] |
| F5 | Networks: Arc, Base, Polygon PoS and their testnets. `exact` and `upto` schemes on Arc mainnet and testnet. | DOCS | [GT] |

## 4. Circle Agent Wallets and CLI

| # | Fact | Grade | Source |
|---|---|---|---|
| W1 | 2-of-2 MPC smart accounts. Circle co-signs every signature. Email-OTP login; 28-day session stored in the OS keychain. First login creates a wallet on every supported EVM chain, including Arc. | CONFIRMED | [HL], [ACT] |
| W2 | A new smart account has no code until its first transaction (`eth_getCode` = `0x`). | CONFIRMED (RPC) | [HL] |
| W3 | **Spending policies are mainnet only and enforced on Circle's servers** before co-signing. `limit` on ARC-TESTNET is rejected. Default caps exist but their values are undocumented. | CONFIRMED | [HL], [ACT] |
| W4 | **No per-transaction human approval exists** in Agent Wallets. Changing a policy needs an email OTP. | DOCS | [GT] |
| W5 | **Passkeys exist only behind a hidden flag:** `CIRCLE_EXPERIMENTAL_AUTH_PASSKEY=1` enables `wallet link`, `unlink` and `login --method passkey`. | CONFIRMED (CLI help) | [HL], [TV] |
| W6 | Agent Wallets are operated through the Node CLI. No browser or mobile SDK is documented. | DOCS | [GT] |
| W7 | CLI 1.2.0 (2026-10-06). A remote minimum-version policy can block old CLIs. Telemetry to Datadog is on by default (`circle telemetry disable` or `DO_NOT_TRACK=1`). | CONFIRMED | [HL] |
| W8 | All CLI commands except help, `terms show`, `skill list` and `update` are blocked until a human accepts Terms. | CONFIRMED | [HL] |
| W9 | `circle services pay` prefers Gateway, falls back to vanilla on the same chain, enforces `--max-amount`. It skips `upto` and Permit2 schemes. | CONFIRMED (CLI source) | [ACT], [TV] |
| W10 | Circle's skill text tells agents to pay "routine micropayments below a few cents" without confirmation and to use the marketplace "as a rescue" before declining. | CONFIRMED (skill files) | [ACT] |

## 5. Discovery API and catalog

| # | Fact | Grade | Source |
|---|---|---|---|
| D1 | `GET https://api.circle.com/v2/x402/discovery/resources`. Keyless. `limit` ≤ 200 (default 50), `offset` paging. | CONFIRMED | [HL], [CAT] |
| D2 | Cached: `cache-control: public, max-age=3600, stale-while-revalidate=600`. Listings can lag by up to an hour. | CONFIRMED | [HL] |
| D3 | **No ranking, rating, uptime, usage or reputation field.** Unqueried order is alphabetical by URL; queries use fuzzy text match on spelling, not meaning. | CONFIRMED | [HL], [CAT] |
| D4 | One backend serves the API, the MCP server (`https://agents.circle.com/api/mcp`, tools `search_agent_marketplace_services`, `get_agent_marketplace_service`) and the CLI. The CLI always hides SIWX listings (209). | CONFIRMED | [HL] |
| D5 | `category=DATA_ENRICHMENT` is rejected by every surface although listings carry it. `sort` is ignored. | CONFIRMED | [HL] |
| D6 | Catalog on 2026-10-18: 2,858 endpoints from 43 providers; 2,195 payable on Arc mainnet; 134 on Arc testnet (132 Quicknode RPC). | CONFIRMED | [CAT] |
| D7 | **About 10% of live 402s differ from the catalog** in price or payee (74-endpoint probe). Probe before paying. | CONFIRMED | [HL] |
| D8 | Agent Platform Terms §15 forbid scraping, mirroring, redistributing or derivative works. Query live; don't mirror. | DOCS (terms page) | [ACT] |
| D9 | The CLI honours `CIRCLE_DISCOVERY_URL`, so `circle services search` can point at another index with the same schema. | CONFIRMED (CLI source) | [ARCH], [ACT] |
| D10 | Listing is by Google Form with manual review; a self-serve wizard is built but not live. | CONFIRMED (page payload) | [ACT] |
| D11 | Catalog Gateway sellers took $58.89 from 68 buyers over 30 days; 21 of 51 Gateway payout addresses earned nothing. | CONFIRMED | [ACT] |

## 6. ERC-8183 `AgenticCommerce` on Arc testnet

| # | Fact | Grade | Source |
|---|---|---|---|
| E1 | Proxy `0x0747EEf0706327138c69792bF28Cd525089e4583` on Arc testnet; implementation `0xA316fd02827242D537F84730F8a37D0BA5fd351a`. **No mainnet deployment listed.** | CONFIRMED (verified ABI); DOCS (no mainnet) | [LAB], [GT] |
| E2 | **The deployed contract includes** `createJob`, `setProvider`, `setBudget`, `fund`, `submit`, `complete`, `reject`, `claimRefund`, `getJob`, `jobCounter`. Events include `JobCreated`, `ProviderSet`, `BudgetSet`, `JobFunded`, `JobSubmitted`, `JobCompleted`, `JobRejected`, `JobExpired`, `PaymentReleased`, `Refunded`, `EvaluatorFeePaid`. | CONFIRMED (ABI) | [LAB] |
| E3 | Status enum: Open, Funded, Submitted, Completed, Rejected, Expired. | CONFIRMED (script) | [LAB] |
| E4 | **Hooks must be whitelisted by an admin** (`setHookWhitelist`, error `HookNotWhitelisted`). Czar cannot attach its own hook contract without that admin's approval. | CONFIRMED (ABI) | [LAB] |
| E5 | **Fees exist:** `platformFeeBP`, `evaluatorFeeBP`, `platformTreasury`, with admin setters. Current values: GAP. | CONFIRMED (ABI); GAP (values) | [LAB] |
| E6 | **Upgradeable and admin-controlled:** UUPS proxy with `ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE`. | CONFIRMED (ABI) | [LAB] |
| E7 | `expiredAt` must be more than now + 5 minutes (`ExpiryTooShort`). The provider sets the budget; `fund()` pulls the current budget, so approve exactly the budget. `optParams` is forwarded only to hooks but lands in calldata (public). | CONFIRMED (script + ABI) | [LAB] |
| E8 | The client may `reject` while Open; the evaluator may `reject` while Funded or Submitted. `claimRefund` after expiry cannot be blocked by hooks. | DOCS (EIP-8183) | [GT] |

## 7. ERC-8004 on Arc

| # | Fact | Grade | Source |
|---|---|---|---|
| R1 | Registries — mainnet Identity `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, Reputation `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`, Validation `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58`; testnet `0x8004A818BFB912233c491871b3d84c89A494BD9e`, `0x8004B663056A597Dffe9eCcC1965A193B7388713`, `0x8004Cb1BF31DAf7788923b405b754f57acEB4272`. | CONFIRMED | [OC], [LAB] |
| R2 | **Controlled by one external EOA, not Circle:** UUPS proxies owned by `0x547289319C3e6aedB179C0b8e8aF0B5ACd062603`, upgraded on Arc mainnet 2026-09-14. | CONFIRMED (RPC) | [OC] |
| R3 | **Usage is thin and concentrated:** 2,316 agents on Arc mainnet, 80.7% from two bulk registrants; 313 feedback entries, 66% from one client; 0 validation responses. Testnet ~897k agents. | CONFIRMED (log scan) | [OC] |
| R4 | `giveFeedback` cannot be called by the agent's own owner or operators. | DOCS (spec) | [GT] |

---

## 8. What these facts force in Czar's design

1. **Pay-on-acceptance cannot be enforced on x402 itself** (G6). Money moves before the result exists. Czar needs one of these:
   - ERC-8183 jobs for work that must pass acceptance (E2)
   - a Czar-funded protection or refund mechanism for x402 calls
   - acceptance results that feed only rankings, not refunds
   - **This choice belongs in the architecture spec.**
2. **The vault cannot pay Gateway directly** (G3). Gateway signs with an EOA, so Czar needs an executor EOA with a Gateway balance, funded by the vault per envelope, with receipts reported back.
3. **The vault might pay vanilla x402 directly through ERC-1271** (F2), if USDC on Arc accepts ERC-1271 signatures in `transferWithAuthorization`. That would let on-chain envelope limits govern each payment. **Highest-priority item to verify** (research prompt §A).
4. **Merchants see funds only after the next batch,** about every 16 minutes (G5). Any merchant-facing "earned" figure must say "pending" until then.
5. **Payments are public** (G10). Anyone can read a Gateway seller's buyers. That's good for evidence, but Czar users' spending patterns are visible by address. Plan address hygiene.
6. **No on-chain randomness** (A7). The exploration budget's sampling and the probe schedules need commit-reveal or off-chain randomness with on-chain commitments.
7. **Czar's own spending limits are required,** not optional (W3, W4). Circle's limits are mainnet-only, server-side and have no per-transaction approval.
8. **A custom ERC-8183 hook needs admin whitelisting** (E4). Choose between asking the admin, deploying a Czar-owned ERC-8183-compatible contract, or using it without hooks. Also account for fees (E5) and upgradeability (E6).
9. **ERC-8004 content isn't a trust signal** (R2, R3). Use it for identity anchors only.
10. **Discovery must probe before paying** (D7), query live without mirroring (D8), and treat cached results as up to an hour old (D2).
11. **Every amount needs an explicit decimals type** (A4, A5) across native (18) and ERC-20 (6) values.
12. **Gas settings:** always set `maxFeePerGas` ≥ 20 Gwei (A6).

## 9. Carried to the research prompt (GAPs in this domain)

- Whether USDC on Arc accepts ERC-1271 signatures in EIP-3009 (`transferWithAuthorization`), and whether Circle's Facilitator settles them for a smart-contract payer.
- Whether a contract can deposit into Gateway on behalf of another address (e.g. `depositFor`), and how a contract-held balance could be spent.
- The unit of `withdrawalDelay`, and whether an instant (non-delayed) withdrawal path exists through Circle's API.
- Current ERC-8183 fee values and the admin address; whether any mainnet deployment is planned.
- Passkey (P-256) verification on Arc: precompile availability, Circle Modular Wallets support for Arc.
- Changes since 2026-10-09: CLI versions after 1.2.0, `@circle-fin/x402-batching` after 3.5.0, policy support on testnet.
- End-to-end runs not yet done: one Gateway nanopayment on Arc testnet, one ERC-8183 release and refund on Arc testnet.
