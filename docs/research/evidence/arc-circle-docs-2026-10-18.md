# Evidence: Arc docs and Circle Agent Stack (live docs read 2026-10-18)

- **Research date:** 2026-10-18
- **Method:** WebFetch of primary pages (docs `.md` versions, live API calls), shallow `git clone` of the two Circle sample repos, WebSearch for secondary coverage
- **Access notes:**
  - curl through the session proxy was refused (403) for docs.arc.io and developers.circle.com, so every web page here was read with WebFetch
  - `gh api` was blocked because the session is limited to its configured repos. `git clone` of the public circlefin repos worked.
- **Grades:** CONFIRMED = primary source fetched this session · STRONG SIGNAL = several credible secondary sources · WEAK SIGNAL = one source or vendor-only · GAP = not found (searches listed)

---

## Exact Discovery API base URL

- **`GET https://api.circle.com/v2/x402/discovery/resources`**: CONFIRMED
  - OpenAPI `servers: https://api.circle.com`, `security: []` ([OpenAPI](https://developers.circle.com/openapi/agent-marketplace-discovery.yaml), [docs page](https://developers.circle.com/agent-stack/agent-marketplace/discovery-api.md))
  - I called it live with no key and it returned HTTP 200 JSON ([live call](https://api.circle.com/v2/x402/discovery/resources?limit=3))

---

## 2. Arc docs (docs.arc.io)

### 2.1 Mainnet status
- **Arc Mainnet is live, chain ID `5042`**: CONFIRMED ([connect-to-arc](https://docs.arc.io/arc/references/connect-to-arc.md))
  - Primary RPC: `https://rpc.mainnet.arc.io`
  - Explorer: `https://explorer.arc.io`
  - Currency symbol USDC, 18 decimals
- **Testnet is chain ID `5042002`**: CONFIRMED (same page)
  - RPC: `https://rpc.testnet.arc.io`
  - Explorer: `https://explorer.testnet.arc.io`
  - Faucet: `https://faucet.circle.com`
- **Mainnet launch date: September 16, 2026**
  - STRONG SIGNAL from secondary sources: [The Block](https://www.theblock.co/news/ecosystems/2026-09-16-circle-launches-arc-mainnet-with-blackrock-and-visa-among-validators-mints-10-billion-arc-tokens-415250) and [Bankless](https://www.bankless.com/read/circles-arc-mainnet-goes-live.md)
  - The Arc community blog dated Aug 6 announced the Sept 16 date in advance ([community.arc.io](https://community.arc.io/home/blogs/arc-public-mainnet-launches-september-16-2026-2026-08-06))
  - The docs themselves give no launch date: GAP in primary docs
- **10 billion ARC tokens minted at genesis; fees stay in USDC.** No public token launch is committed. STRONG SIGNAL ([The Block](https://www.theblock.co/news/ecosystems/2026-09-16-circle-launches-arc-mainnet-with-blackrock-and-visa-among-validators-mints-10-billion-arc-tokens-415250))

### 2.2 USDC as gas, and decimals
- **USDC is the native gas token**: CONFIRMED ([evm-differences](https://docs.arc.io/build/evm-differences.md))
  - **The native interface uses 18 decimals; the ERC-20 interface at `0x3600…0000` uses 6 decimals. Both read the same balance.**
  - Divide a native value by 10¹² to get USDC
  - A `balanceOf` of zero does not mean the native balance is zero, because the 6-decimal view truncates sub-micro amounts
- **Fees**: CONFIRMED ([gas-and-fees](https://docs.arc.io/arc/references/gas-and-fees.md))
  - Target cost is about $0.001 per ERC-20 transfer
  - Minimum base fee 20 Gwei, maximum 20,000 Gwei
  - EIP-1559 pricing with EWMA smoothing
  - 30M gas per block, about 0.5 s block time
- **A tx with `maxFeePerGas` below 20 Gwei is silently dropped, with no receipt**: CONFIRMED ([evm-differences](https://docs.arc.io/build/evm-differences.md))

### 2.3 Osaka EVM and the EVM differences page
- **Arc targets the Osaka hard fork and adds EIP-7708** (Transfer logs for native value moves): CONFIRMED ([evm-differences](https://docs.arc.io/build/evm-differences.md), [arc-chain](https://docs.arc.io/arc-chain.md))
- **Opcode and block differences**: CONFIRMED
  - `PREVRANDAO` always returns 0, so it cannot be used for randomness
  - Blob transactions are rejected. `BLOBHASH` returns 0 and `BLOBBASEFEE` returns 1.
  - There is no EIP-4788 beacon-roots contract
  - The base fee goes to the block producer instead of being burned
  - Timestamps only need to be non-decreasing (one-second granularity), so use block numbers for ordering
  - Transactions are final on inclusion, so one confirmation is enough
- **Value-transfer rules**: CONFIRMED
  - Sending value to `0x0` reverts
  - Burning native value is forbidden
  - The **blocklist is enforced at runtime**, so a transfer can revert even with enough balance
  - SELFDESTRUCT follows special rules and moves held USDC to the beneficiary
- **Use `arc-anvil` from Arc Foundry**, because standard anvil does not reproduce Arc's behaviour: CONFIRMED
- **Consensus and clients**: CONFIRMED ([arc-chain](https://docs.arc.io/arc-chain.md))
  - Malachite BFT with a permissioned validator set
  - Reth execution client
  - Opt-in privacy sector and post-quantum signatures are offered

### 2.4 StableFX, CCTP, Gateway
- **StableFX FxEscrow addresses**: CONFIRMED ([contract-addresses](https://docs.arc.io/arc/references/contract-addresses.md))
  - Mainnet `0xe2E5F173576B513d994073CCbDaCBE027d43DFe6`
  - Testnet `0xd68256f4D69C6BbEcB873D8588AE0Dc6B8E22E10`
- **Arc mainnet became a StableFX chain on 2026-09-16**: CONFIRMED ([StableFX release notes](https://developers.circle.com/release-notes/stablefx-2026.md))
  - The Arc "Stablecoin FX" build page does not describe StableFX's RFQ or access model. It points builders to App Kit Swap instead ([stablecoin-fx](https://docs.arc.io/build/stablecoin-fx.md)).
  - StableFX access requirements (permissioned or KYB): GAP. Not in the release notes or the Arc page.
- **CCTP V2 on mainnet and testnet** (TokenMessengerV2, MessageTransmitterV2 and others): CONFIRMED ([contract-addresses](https://docs.arc.io/arc/references/contract-addresses.md))
  - Mainnet TokenMessengerV2: `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`
- **Gateway on Arc**: CONFIRMED
  - GatewayWallet: mainnet `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE`, testnet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` ([contract-addresses](https://docs.arc.io/arc/references/contract-addresses.md))
  - Gateway domain 26; SDK chain names `arc` and `arcTestnet`; nanopayments supported ([Gateway chains](https://developers.circle.com/gateway/references/supported-blockchains.md))

### 2.5 ERC-8004 deployment and the "Register your first AI agent" tutorial
- **ERC-8004 registries are deployed on both mainnet and testnet**: CONFIRMED ([contract-addresses](https://docs.arc.io/arc/references/contract-addresses.md))

  | Registry | Mainnet | Testnet |
  |---|---|---|
  | IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
  | ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
  | ValidationRegistry | `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58` | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |

- **The tutorial runs on testnet only**: CONFIRMED ([tutorial](https://docs.arc.io/arc/tutorials/register-your-first-ai-agent.md))
  - **IdentityRegistry** mints an ERC-721 identity NFT. Functions: `register(string metadataURI)`, `ownerOf`, `tokenURI`. Read the `Transfer` event to get the agentId.
  - **ReputationRegistry** stores feedback from outside observers. Function: `giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)`. The example uses score 95 and tag `successful_trade`. **Owners cannot rate their own agent.**
  - **ValidationRegistry** runs a two-step check: `validationRequest(address,uint256,string,bytes32)`, then `validationResponse(bytes32,uint8,string,bytes32,string)`, then `getValidationStatus(bytes32)`. The example uses response 100 and tag `kyc_verified`.
  - The metadata JSON fields (name, description, image, agent_type, capabilities, version) are app-defined, not set by ERC-8004
  - **Two wallet paths:**
    - Circle developer-controlled SCA wallets on `ARC-TESTNET`, with gas sponsored by Gas Station (about 0.006 USDC-TESTNET per tx)
    - viem with private keys
  - The tutorial hardcodes scores and recommends computing them from real agent outcomes

### 2.6 ERC-8183 tutorial ("Create your first ERC-8183 job")
- **AgenticCommerce reference contract: `0x0747EEf0706327138c69792bF28Cd525089e4583`, testnet only. No mainnet address is listed.** CONFIRMED ([contract-addresses](https://docs.arc.io/arc/references/contract-addresses.md))
- **Lifecycle shown in the tutorial**: CONFIRMED ([tutorial](https://docs.arc.io/arc/tutorials/create-your-first-erc-8183-job.md))
  1. `createJob(provider, evaluator, expiredAt, description, hook)` creates the job in **Open**
  2. The provider calls `setBudget(jobId, amount, optParams)`. The example budget is 5 USDC, passed as `5000000` (6 decimals).
  3. The client calls USDC `approve`, then `fund(jobId, optParams)`. The job moves to **Funded**.
  4. The provider calls `submit(jobId, bytes32 deliverable, optParams)`. The job moves to **Submitted**.
  5. The evaluator calls `complete(jobId, bytes32 reason, optParams)`. The job moves to **Completed** and the provider is paid, net of any fees.
  6. `getJob(jobId)` returns id, client, provider, evaluator, description, budget, expiredAt, status, hook
  - **Status enum:** 0 Open, 1 Funded, 2 Submitted, 3 Completed, 4 Rejected, 5 Expired
  - The quickstart sets the client as the evaluator, sets `expiredAt` to now + 3600 s, and uses the zero address for the hook
  - **The tutorial ABI has no `reject` or `claimRefund`**: CONFIRMED gap in the tutorial
- **The ERC-8183 spec fills that gap** (Draft, created 2026-02-25): CONFIRMED ([EIP-8183](https://eips.ethereum.org/EIPS/eip-8183))
  - Also defines `setProvider`, `reject(jobId, reason, optParams)` and `claimRefund(jobId)`
  - Who can **reject**: the client while Open; the evaluator while Funded or Submitted
  - **Expiry:** once `block.timestamp >= expiredAt` in Funded or Submitted, `claimRefund` returns the full escrow to the client and sets the job to Expired. The spec recommends that anyone can call it.
  - **Hooks:** an `IACPHook` contract with `beforeAction` and `afterAction` can wrap setProvider, setBudget, fund, submit, complete and reject. **`claimRefund` cannot be hooked**, so a hook can never block a refund.
  - The evaluator can be the client or a smart contract
  - Whether the Arc reference deployment includes every spec function: GAP. Only the tutorial ABI was seen.

### 2.7 Contract addresses page (other items)
- USDC `0x3600000000000000000000000000000000000000` on both networks: CONFIRMED ([contract-addresses](https://docs.arc.io/arc/references/contract-addresses.md))
- EURC: mainnet `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1`, testnet `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`
- USYC, cirBTC, WETH, Memo, Multicall3, Multicall3From, Permit2 (`0x0000…22D473030F116dDEE9F6B43aC78BA3`) and the Arachnid CREATE2 factory are listed for both networks
- **No paymaster contract is listed** on the page

### 2.8 Agentic Economy page and its sample apps
- **Content**: CONFIRMED ([agentic-economy](https://docs.arc.io/build/agentic-economy.md))
  - ERC-8004 for identity and reputation, ERC-8183 for the job lifecycle
  - Two sample apps: **arc-escrow** (https://github.com/circlefin/arc-escrow) and **arc-nanopayments** (https://github.com/circlefin/arc-nanopayments)
  - Also covers the Arc MCP server, Elliptic and TRM compliance, and sub-second finality
- **The page does not mention the Discovery API, Agent Marketplace or Agent Wallets**: CONFIRMED
- **The full sample-apps list has 11 apps**: CONFIRMED ([sample-applications](https://docs.arc.io/arc/references/sample-applications.md))
  - Commerce, P2P (passkey modular wallets), escrow, nanopayments, e-commerce payments, Onramp demo, multichain wallet (Gateway), fintech, stablecoin FX, DeFi lend/borrow, prediction markets
  - **None of them is a consumer Discovery-API agent**

### 2.9 Arc Studio
- **What it is:** an AI coding agent ("Idea to app in minutes") at `https://studio.arc.io/`. CONFIRMED ([arc-studio](https://docs.arc.io/ai/arc-studio.md))
  - Browser workbench with live preview, code and file editor, and terminal
  - Plans, generates, compiles and deploys Solidity
  - Can build a frontend on top of an already-deployed contract
  - Built-in testnet USDC faucet
  - Connect a wallet to sign from the preview
  - Push the code to GitHub
- **Templates (remixable):** prediction market, USDC checkout, crosschain bridge, onchain profile. CONFIRMED
- **Testnet only.** The docs say Studio "does not deploy to mainnet on your behalf". The studio.arc.io disclaimer says it does not "deploy, sign, fund, or submit mainnet transactions". CONFIRMED ([arc-studio](https://docs.arc.io/ai/arc-studio.md), [studio.arc.io](https://studio.arc.io/))
- **Arc Studio CLI** (`npm i -g @circle-fin/arc-studio-cli`, Node 20+): CONFIRMED ([arc-studio-cli](https://docs.arc.io/ai/arc-studio-cli.md))
  - Account: `login` (browser device-link that mints a personal access token), `whoami`, `tokens list/revoke`
  - Sessions: interactive mode, `run`, `attach`, `acp` (ACP stdio agent, e.g. for Zed)
  - Workspace and apps: `pull`, `ls`, `cat`, `clone`, `apps`, `deployments`, `preview`, `open`
  - Integration: `skills install`, to register Studio as a skill or subagent for Claude Code
  - Deploys to Arc testnet only
- **Arc docs MCP server:** `https://docs.arc.io/mcp`, with docs search and get-page tools: CONFIRMED ([mcp](https://docs.arc.io/ai/mcp.md))
- **Paymaster on Arc:** the docs have a "deploy your own ERC-4337 paymaster" how-to (EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032`, verify before use; Pimlico bundler; deposits in 18-decimal native USDC). CONFIRMED ([deploy-a-paymaster](https://docs.arc.io/integrate/relayers-and-paymasters/deploy-a-paymaster.md))

---

## 3. Circle developer docs (developers.circle.com)

### 3.1 Circle CLI
- **Install:** `npm install -g @circle-fin/cli` (Node ≥ 20.18.2). CONFIRMED ([circle-cli](https://developers.circle.com/agent-stack/circle-cli.md))
- **Command groups**: CONFIRMED ([command-reference](https://developers.circle.com/agent-stack/circle-cli/command-reference.md))
  - **wallet**: login, logout, status, create (max 5 agent wallets per user), list, limit / limit set / limit reset / limit budget, balance, fund, transfer, swap, sign message, sign typed-data, execute, import
  - **services**: `circle services search` (by keyword, category or type), `inspect`, `pay` (with `--max-amount`)
  - **bridge**: transfer, status, get-fee
  - **gateway**: balance, deposit (**minimum 0.5 USDC**), withdraw
  - **blockchain**, **transaction**, **contract**, **skill**, **terms**, **telemetry**
- **The CLI is the only documented way to operate an Agent Wallet.** No browser or mobile SDK for Agent Wallets was found. CONFIRMED for the docs pages read. GAP for any web SDK (searched the llms.txt index and the wallet pages).

### 3.2 Agent Wallets
- **Custody:** built on Circle user-controlled wallets with **2-of-2 MPC**. "The user retains custody", and key shares are never shown to the agent. CONFIRMED ([agent-wallets](https://developers.circle.com/agent-stack/agent-wallets.md))
- **Email login**: CONFIRMED ([authenticate](https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/authenticate.md))
  - Run `circle wallet login <email>` and enter the alphanumeric email OTP. Add `--testnet` for testnet.
  - Two-step mode for agents: `--init`, then `--request <id> --otp <code>`. The request ID expires after 10 minutes.
  - Sessions last 28 days and are stored in the OS keychain
  - Login provisions agent wallets on every supported chain
  - The docs warn: do not give an agent access to your inbox
- **Fiat onramp**: `circle wallet fund --method fiat` opens a card or bank onramp in the browser (or prints a URL with `--no-open`). CONFIRMED ([fund](https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/fund.md))
  - Other methods: `--method crypto` (QR code / EIP-681 URI) and the testnet faucet (20 USDC)
  - Onramp provider, countries and limits: GAP (not on the page)
- **Spending policies, all 8 types**: CONFIRMED ([custom-policies](https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/custom-policies.md), [command-reference](https://developers.circle.com/agent-stack/circle-cli/command-reference.md))
  - **Transfer limits** (`--rule-type transfer-limit`, the default): `--per-tx`, `--daily`, `--weekly`, `--monthly`, over a rolling window. They must satisfy per-tx ≤ daily ≤ weekly ≤ monthly. Set with `--policy-type stablecoin` (USDC).
  - **Recipient allowlist** and **recipient blocklist**
  - **Contract allowlist** and **contract blocklist**
  - `limit budget` shows the remaining budget. `limit reset` restores the defaults.
  - **Policies work on MAINNET ONLY. "Testnet is not supported."** CONFIRMED
  - The overview page says the limits cover outbound transfers **and x402 payments** ([agent-wallets](https://developers.circle.com/agent-stack/agent-wallets.md)). CONFIRMED
- **Human approval**: CONFIRMED (same pages)
  - **Every policy change needs a second email OTP**
  - **There is no per-transaction human approval feature**
  - Circle's disclaimer says agent transactions "may occur without real-time human review" ([agents.circle.com](https://agents.circle.com/))
- **Supported chains (mainnet / testnet):** Arbitrum, **Arc (`ARC` / `ARC-TESTNET`)**, Avalanche, Base, Ethereum, Monad, Optimism, Polygon PoS, Unichain. CONFIRMED ([supported-blockchains](https://developers.circle.com/agent-stack/agent-wallets/supported-blockchains.md))
- **Fees**: CONFIRMED ([fees](https://developers.circle.com/agent-stack/agent-wallets/fees.md))
  - Gas is $0 (sponsored), but "capped, subject to fair use"
  - Swap: 2 bps
  - **Gateway protocol fee: 0.5 bps on crosschain x402 payments; free for same-chain**
  - Forwarding: $0.05
- **All transfers are sanctions-screened before onchain submission**: CONFIRMED ([agent-wallets](https://developers.circle.com/agent-stack/agent-wallets.md))

### 3.3 Agent Nanopayments and Gateway Nanopayments
- **Minimum payment: "as little as $0.000001 USDC per payment"**: CONFIRMED ([gateway-nanopayments](https://developers.circle.com/gateway-nanopayments.md), [batched-settlement](https://developers.circle.com/gateway-nanopayments/concepts/batched-settlement.md))
- **Flow**: CONFIRMED ([gateway-nanopayments](https://developers.circle.com/gateway-nanopayments.md))
  1. The buyer makes a one-time onchain deposit into the GatewayWallet
  2. The seller answers a request with HTTP 402
  3. The buyer signs an EIP-3009 `TransferWithAuthorization` offchain, at no gas cost, and retries the request
  4. The seller verifies the authorization and serves the resource **right away**
  5. Gateway settles the authorizations onchain in batches
- **Batch timing**: Gateway settles "periodically", with **no interval or guarantee stated**. CONFIRMED that it is unspecified ([batched-settlement](https://developers.circle.com/gateway-nanopayments/concepts/batched-settlement.md))
  - An AWS Nitro Enclave verifies signatures and signs the net balances; the GatewayWallet contract checks the enclave's signature
  - Seller funds become withdrawable only after the batch confirms onchain
- **Networks: Arc mainnet (`arc`) and testnet (`arcTestnet`) are Gateway chains**, and "Gateway supports nanopayments on all blockchains except Solana". CONFIRMED ([Gateway chains](https://developers.circle.com/gateway/references/supported-blockchains.md))
- **Buyer SDK**: `@circle-fin/x402-batching`. CONFIRMED ([buyer quickstart](https://developers.circle.com/gateway-nanopayments/quickstarts/buyer.md))
  - `GatewayClient({chain, privateKey})` with `getBalances()`, `deposit()`, `pay(url)`, `withdraw()`, `supports(url)`
  - A Circle Wallets path uses `BatchEvmScheme` with developer-controlled `signTypedData`
  - **"Gateway Nanopayments requires an EOA wallet"**
  - Node ≥ 22.18. Browser support is not addressed.
- **Seller SDK**: CONFIRMED ([become-a-seller](https://developers.circle.com/agent-stack/agent-marketplace/become-a-seller.md))
  - `@circle-fin/x402-batching` with `createGatewayMiddleware({sellerAddress, facilitatorUrl})` and `gateway.require("$0.01")`
  - Optionally accept onchain x402 too, via `x402ResourceServer` + `BatchFacilitatorClient` + `GatewayEvmScheme`
  - The examples use `arcTestnet`
- **CLI pay flow**: CONFIRMED ([pay-for-service](https://developers.circle.com/agent-stack/agent-nanopayments/operations/pay-for-service.md))
  - Run `circle services pay <url> --address … --chain ARC --max-amount 0.01`, or add `--estimate` to preview
  - Most services need a Gateway balance
  - No confirmation prompt is described
- **Nanopayments went live on mainnet in May 2026.** STRONG SIGNAL, from a single trade-press article ([Crowdfund Insider](https://www.crowdfundinsider.com/2026/05/276951-circle-launches-nanopayments-on-mainnet-enabling-usdc-micro-transactions-for-agentic-economy/)) plus the Agent Stack blog calling it "previously announced"

### 3.4 Agent Marketplace and the Discovery API
- **Marketplace**: CONFIRMED ([agent-marketplace](https://developers.circle.com/agent-stack/agent-marketplace.md))
  - A "curated, compliance-first catalog of x402 services" that accept USDC
  - Browse it at `agents.circle.com/services`
  - The docs claim "600+ live services across 15+ blockchain networks". The Aug 12 blog says 900+.
  - Each listing is sanctions-checked on the seller side and **health-checked; unreachable endpoints are auto-excluded**
- **Endpoint:** `GET https://api.circle.com/v2/x402/discovery/resources`. Public, with no key. Responses support gzip. CONFIRMED ([discovery-api](https://developers.circle.com/agent-stack/agent-marketplace/discovery-api.md), [OpenAPI](https://developers.circle.com/openapi/agent-marketplace-discovery.yaml))
- **Query parameters (all optional)**: CONFIRMED
  - `query`: fuzzy search over URL, provider, description and tags
  - `type`: `http` or `mcp`
  - `category`: one of the 6 values below
  - `network`: CAIP-2 ID, or a legacy EVM alias such as `base`
  - `asset`, `scheme`, `payTo`, `maxUsdPrice`
  - `supportsVanillax402`, `supportsCircleGateway`, `siwx`
  - `fields`: comma-separated paths, to trim each item
  - `limit`: 1–200, default 50
  - `offset`: ≥ 0, default 0
  - Pagination is offset-based, using `pagination.total`. There is no cursor.
- **Category enum: exactly `SOCIAL_INTELLIGENCE`, `FINANCIAL_ANALYSIS`, `WEB_SEARCH_RESEARCH`, `PREDICTION_MARKETS`, `CREATIVE`, `INFRASTRUCTURE`**: CONFIRMED (OpenAPI enum and the [Sept 9 blog](https://www.circle.com/blog/discover-the-whole-agent-marketplace-in-one-call))
- **Response schema**: CONFIRMED (OpenAPI, plus live response)
  - Top level: `x402Version`, `items[]`, `pagination{limit,offset,total}`
  - Each item: `resource`, `type`, `x402Version`, `lastUpdated`, `accepts[]`, `metadata`
  - `accepts[]`: `scheme`, `network`, `asset`, `amount` (atomic units, USDC has 6 decimals), `payTo`, `extra{name,version}`. Live data also includes `maxTimeoutSeconds`, plus `extra.feePayer`, `extra.verifyingContract` or `extra.assetTransferMethod`, depending on the chain.
  - `metadata`: `provider{name,description,category,tags[],website,docsUrl,openApiUrl}`, `path`, `method`, `description`, `mimeType`, `input` (JSON Schema), `output` (JSON Schema), `siwx`, `supportsVanillax402`, `supportsCircleGateway`
- **NO ranking, reputation, rating, quality score, uptime, latency, usage or popularity field exists in the spec or in live responses**: CONFIRMED
  - `lastUpdated` is a catalog timestamp, not a health signal
  - Health checks are used only to include or exclude listings; the results are not exposed
  - Live order looks alphabetical by resource URL (2captcha…, aero.lonestaroracle…, africa…). Observed in a sample of 3, so WEAK SIGNAL.
- **Live counts observed on 2026-10-18 (unstable; see note)**: CONFIRMED that the API returned them
  - All listings: total 2858
  - Arc mainnet (`network=eip155:5042`): 2195, or 323 when the `fields` parameter was added
  - **Arc testnet (`eip155:5042002`): 0**
  - Legacy alias `network=arc`: 0. Use the CAIP-2 ID instead.
  - `supportsCircleGateway=true`: 689–691
  - By category: FINANCIAL_ANALYSIS 603, WEB_SEARCH_RESEARCH 102, SOCIAL_INTELLIGENCE 95, INFRASTRUCTURE 89, PREDICTION_MARKETS 24, CREATIVE 14
  - **Note:** the filtered totals do not add up. Arc + Gateway returned 2056, which is more than Gateway-only (689), and the categories sum to 927, well under 2858. Either some listings have no category or the network filter matches loosely. WEAK SIGNAL on exact counts. Re-test with curl before relying on them.
- **Getting listed**: CONFIRMED ([get-listed](https://developers.circle.com/agent-stack/agent-marketplace/get-listed.md))
  - Requirements: a payable 402 endpoint, a published OpenAPI spec, and a payout wallet
  - Submit through the Google Form `https://forms.gle/7YFzvdmMcn1JH5tF6`
  - **"Listings are reviewed and approved manually today"**
  - **"A self-serve, automated submission flow is coming"**, with no date
  - **The payout wallet is sanctions-screened** at review
  - After listing, the endpoint is continuously health-checked
  - No review timeline is stated
- **agents.circle.com landing page**: CONFIRMED ([agents.circle.com](https://agents.circle.com/))
  - The seller section has a "Check your score" box ("Free and instant. No signup, no API key") with an API-domain input
  - What that score measures is not explained: GAP
  - The services page shows All / 1P / 3P tabs and sortable "#" and "Endpoints" columns, with no ratings or badges ([services](https://agents.circle.com/services))

### 3.5 Paymaster
- **Circle Paymaster** is a permissionless ERC-4337 token paymaster: CONFIRMED ([paymaster](https://developers.circle.com/paymaster.md))
  - v0.7: Arbitrum, Base. v0.8: Arbitrum, Avalanche, Base, Ethereum, Optimism, Polygon, Unichain.
  - Charges a 10% gas surcharge
  - **Arc is not listed.** Arc does not need it, since gas is already USDC; for Arc the docs offer a deploy-your-own paymaster how-to (§2.9).

### 3.6 x402 Facilitator Service
- **Circle's hosted x402 facilitator covers Arc, Base and Polygon PoS**: CONFIRMED ([facilitator-service](https://developers.circle.com/facilitator-service.md), [supported-networks](https://developers.circle.com/facilitator-service/supported-networks.md))
  - **Arc mainnet `eip155:5042` and Arc testnet `eip155:5042002`, both supporting the `exact` (EIP-3009) and `upto` (Permit2) schemes**
  - Base Sepolia and Amoy testnets support `exact` only
  - **An API key is required to settle.** A keyless trial with an allowance exists, tracked per `payTo` address.
  - Circle screens both parties
  - Base URL and fees: GAP (not on these pages)

---

## 4. Circle sample apps

### 4.1 circlefin/arc-escrow ("Workflow Escrow Refund Protocol")
- **Repo:** https://github.com/circlefin/arc-escrow. Last commit 2026-06-18. CONFIRMED (cloned)
- **What it does:** a freelance escrow on **Arc testnet** with AI-validated deliverables. CONFIRMED (README, source)
  - **Contract analysis:** the user uploads a PDF or DOCX agreement. `app/api/contracts/analyze` sends the text to OpenAI `gpt-4o-mini` to pull out the terms, amount and tasks.
  - **Deploy:** `app/api/contracts/escrow` deploys a per-agreement **RefundProtocol.sol** (EIP-712) through Circle Smart Contract Platform's `deployContract`, using bytecode stored in `lib/constants.ts`
  - **Deposit:** USDC `approve`, then `pay(address,uint256,address)` via developer-controlled wallets' `createContractExecutionTransaction`
  - **Validate work:** the beneficiary uploads an **image**. `gpt-4o` vision checks it against the task list and returns `{valid, confidence: HIGH|MEDIUM|LOW, reasons}`. If valid, the app calls `withdraw(uint256[])` to release the funds.
  - **Refund:** `refundByRecipient(uint256)`. The contract also has `refundByArbiter`, `earlyWithdrawByArbiter` and `updateRefundTo`.
  - **USDC buy and sell:** Circle ramp sessions (`/v1/w3s/ramp/sessions`, hardcoded country "US")
- **UX:** a Next.js + Supabase desktop dashboard. CONFIRMED
  - Email/password or Google sign-in
  - An agreements table, deposit and validation dialogs (with confetti), a transactions list, and a wallet balance
  - Circle webhooks are received through ngrok
- **Circle products used:** Developer-Controlled Wallets, Smart Contract Platform, the user-controlled-wallets SDK (a dependency), Ramp sessions, and webhooks. CONFIRMED
  - **No ERC-8004, ERC-8183, x402 or nanopayments**
  - The contract is Circle's Refund Protocol, not ERC-8183

### 4.2 circlefin/arc-nanopayments ("Arc Nanopayments" sample)
- **Repo:** https://github.com/circlefin/arc-nanopayments. A single initial commit, 2026-04-04. CONFIRMED (cloned)
- **What it does:** a Next.js seller exposes 4 x402-paywalled endpoints on **Arc testnet**. CONFIRMED (README, `lib/x402.ts`, `agent.mts`)
  - Endpoints: `/api/premium/quote` $0.001, `/dataset` $0.01, `/compute` $0.0003, `/agent-task` $0.03
  - The seller returns 402 with `PAYMENT-REQUIRED` (scheme `exact`, network `eip155:5042002`, `extra.name "GatewayWalletBatched"`)
  - It then verifies and settles through `BatchFacilitatorClient` and logs to Supabase
- **Buyer:** `agent.mts`, a Node CLI script. CONFIRMED
  - Creates an **ephemeral private key**, funds it from the buyer key (native USDC for gas, then ERC-20 USDC), and deposits 1 USDC into Gateway
  - Then **calls `gateway.pay()` on the 4 hardcoded local endpoints in rotation, once per second**
  - Auto-redeposits when the balance falls below 0.5 USDC
  - `--limit` sets a **local, in-script spend cap**. At the cap it asks in the terminal for more allowance.
  - **The LangChain/Deep Agents/OpenAI agent described in the README is not in the source.** `agent.mts` imports no LLM library, and grep finds langchain/deepagents only in the README, package.json and .env.example. CONFIRMED (grep)
- **UX:** a desktop **seller dashboard** (hardcoded demo login `admin@example.com`) with a Gateway balance badge, a real-time payments table, and a withdraw dialog for crosschain withdrawal to 7 testnets. The buyer side has no UI; it is terminal only. CONFIRMED
- **Circle products used:** Gateway Nanopayments (`@circle-fin/x402-batching`, both GatewayClient and BatchFacilitatorClient), x402 v2 (`@x402/core`, `@x402/evm`), and the Circle faucet. CONFIRMED
  - **No Discovery API, Agent Wallets, ERC-8004, mobile UI or consumer-facing buyer**

## 5. Circle blog and announcements (May–Oct 2026)

- **"Introducing Circle Agent Stack", May 11, 2026**: CONFIRMED ([blog](https://www.circle.com/blog/introducing-circle-agent-stack-financial-infrastructure-for-the-agentic-economy))
  - Launched Agent Wallets (time-bound limits, allowlists and blocklists), Agent Marketplace and Circle CLI
  - Nanopayments and Circle Skills were "previously announced"
  - Hub: agents.circle.com
- **"Turn your API into an agent-ready revenue stream", dated July 31, 2026** (page also shows Aug 12): CONFIRMED ([blog](https://www.circle.com/blog/turn-your-api-into-an-agent-ready-revenue-stream))
  - Invites sellers to apply for listing
  - Names three loose areas: data and intelligence, digital infrastructure, real-world execution
- **"Building the Open Agentic Economy", Aug 12, 2026, by Jasper Kim and Hao Min**: CONFIRMED ([blog](https://www.circle.com/blog/building-the-open-agentic-economy))
  - Main argument: the bottleneck moves from building agents to finding and evaluating them
  - Calls **trusted discovery the missing "capstone"**: the reputation signal is missing and validation is still emerging
  - Proposes a preliminary **"multi-input ranking"** built on observed behaviour, PageRank-style. Its principles:
    - Organic rank is never for sale
    - Inclusion is permissionless
    - The read surface is open
    - Ranking is contestable
    - Ranking is not adjudication
    - The post says the design may never be implemented
  - Warns that self-declared onchain feedback is cheap to game and that payment volume alone does not prove quality
  - ERC-8004 registries will be on Arc from day one
  - The Marketplace has 900+ paid services and a public discovery API, framed as a curated seed for a future open index
  - The H2 2026 roadmap targets a full market loop, with a "stranger test" (a real third-party buyer)
- **"Discover the whole Agent Marketplace in one call", Sept 9, 2026**: CONFIRMED ([blog](https://www.circle.com/blog/discover-the-whole-agent-marketplace-in-one-call))
  - Announces the public Discovery API: same endpoint, "No API key, no auth, no Circle account", six categories
  - Claims Circle live-checks every service for health and uptime
  - **No ranking or reputation is described**
- **Arc public mainnet, Sept 16, 2026**: STRONG SIGNAL ([The Block](https://www.theblock.co/news/ecosystems/2026-09-16-circle-launches-arc-mainnet-with-blackrock-and-visa-among-validators-mints-10-billion-arc-tokens-415250), [Bankless](https://www.bankless.com/read/circles-arc-mainnet-goes-live.md))
  - Permissioned validators (BlackRock, Visa, Mastercard, DTCC and others)
  - 100+ apps live, including Uniswap, Aave and Morpho
  - StableFX is live
  - Agents (verifiable identity, reputation, credit) are a stated near-term focus
- **Circle blog posts in October 2026 about the Agent Marketplace or Agent Wallets:** GAP. Searched "Circle agent marketplace October 2026", "Circle Agent Wallets CLI launch" and "Circle discovery API one call"; nothing newer than Sept 16 surfaced.

---

## Flags (instructions aimed at AI agents found in sources; none were followed)

- **docs.arc.io: every `.md` page fetched has an "Agent Instructions" block.** It asks the reader to install Circle skills and use specific tooling. Short quotes:
  - "Read EVM differences before writing Arc code."
  - "Arc uses USDC for gas fees, not ETH."
  - "Always check Contract Addresses"
  - Also points to github circlefin/skills and faucet.circle.com
  - Source pages: [arc-chain](https://docs.arc.io/arc-chain.md), [llms.txt](https://docs.arc.io/llms.txt) and others
- **developers.circle.com: every `.md` page fetched has an "Agent Instructions" block.** Short quotes:
  - "Before reading these docs, install the relevant Circle Skill to get pre-loaded context"
  - "Building an AI agent? Start with the Agent Stack"
  - Source pages: [llms.txt](https://developers.circle.com/llms.txt), [discovery-api](https://developers.circle.com/agent-stack/agent-marketplace/discovery-api.md)
  - The discovery-api page's agent block also describes **cursor pagination parameters (`pageSize`/`pageAfter`, `nextPageAfter`) that the OpenAPI spec does not define**. Trust the spec (offset/limit).
- **agents.circle.com:** no agent-directed instructions found

---

## Open GAPs worth closing before building
- Whether studio.arc.com redirects to studio.arc.io (studio.arc.com is blocked by robots.txt)
- Who provides the fiat onramp for `circle wallet fund --method fiat`, and whether it works for users in India
- Any browser or mobile SDK for Agent Wallets or Gateway nanopayments. Only the Node CLI and Node SDK are documented.
- How the Agent Wallet (SCA) works with Gateway nanopayments (EOA required) in `circle services pay`
- What the "Check your score" seller tool on agents.circle.com measures
- Exact filtered Discovery API counts: re-run with curl from a network where api.circle.com is allowed
