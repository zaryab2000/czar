# Czar ground truth, part 2: everything outside part 1

- **Date:** 2026-10-18 (every fact checked this day unless a row says otherwise)
- **Author:** Claude, research lead, with seven researcher agents (one per area). The lead reviewed each draft and spot-checked the key transactions.
- **Purpose:** the verified facts beyond Circle and Arc basics that Czar's specs depend on. Later specs cite this file by fact ID (for example `A1-17`).
- **Scope:** `specs/00-ground-truth/research-prompt-part2.md`, sections A–F.
- **Builds on:** `specs/00-ground-truth/circle-arc.md` (part 1). Where this file corrects part 1, the correction table below says so, and this file wins.

## Grades
- **CONFIRMED** — primary source read this session (official docs, spec or EIP text, source at a named commit/tag/version), an on-chain read with a block number, or our own experiment output.
- **STRONG SIGNAL** — several credible secondary sources agree, or a strong inference from confirmed data.
- **WEAK SIGNAL** — one secondary source.
- **GAP** — searched, not found. The searches are listed in the GAPs section.

## How to read the tables
- Each section names its own source tags (for example `[SRC]`, `[RPC-M]`) at its top. A tag means the same thing everywhere within its section.
- `[EXP]` and `raw/...` paths point to experiment folders under `research/evidence/experiments/`:

| Folder | What ran | Network |
|---|---|---|
| `a1-erc1271-usdc/` | ERC-1271 contract paid x402 through Circle's Facilitator; direct `transferWithAuthorization` from a contract; simulations | Arc testnet (live), mainnet + testnet (simulation) |
| `a2-gateway-e2e/` | Gateway deposit → nanopayment → batch; delegate and ERC-1271 tests; instant withdrawals | Arc testnet |
| `a3-a5-reads/` | x402 `/supported`, ERC-8183 and ERC-8004 reads | Arc mainnet + testnet (read-only) |
| `a6-a9-arc-probes/` | P-256 precompile, EntryPoints, 7702 acceptance, splits/ENS/EAS probes, explorer API, `arc-anvil` | Arc mainnet + testnet (read-only), local `arc-anvil` |
| `gt2-df-readonly-probes/` | GitHub API, Discovery API, CLI tarball diffs | read-only HTTP |

- **Testnet funds used:** three throwaway keys, never printed and gitignored. gt-a2 received 5 testnet USDC (`0x22548792…2d48`) and gt-a1 received 2 (`0xf57309d4…1e0b`). Both came from the user's Arc testnet agent wallet `0xc7984a08…5a45`. The 5 USDC transfer was sent before the user's approval arrived; the amount was within what the user then approved. No mainnet funds were used.

## Corrections to part 1

| Part 1 fact | Was | Now | Evidence |
|---|---|---|---|
| A3 | Two testnet RPC hostnames are in use | `rpc.testnet.arc.network` **no longer resolves in DNS**. Use `rpc.testnet.arc.io`. CLI 1.2.2 switched to it. SDK `GatewayClient.withdraw()` still hard-codes the dead host. | A9-08, F1-09, A2-31 |
| A2 | Explorers graded DOCS | Both are Blockscout. The mainnet API is behind a Cloudflare challenge for scripts; the testnet API is keyless but rate-limited. | A9-09 – A9-11 |
| G3 | Gateway buyer signer is an EOA | **Still true, now proven by experiment.** Nanopayments reject both delegates and ERC-1271 payers. | A2-09, A2-10 |
| G8 | `withdrawalDelay()` unit unknown | **Blocks** (from source). 1,209,600 blocks ≈ 7.1 days. | A2-13, A2-14 |
| G12 | End-to-end nanopayment not run | Run on Arc testnet: 1.2 s to HTTP 200; 107 s and 12 min 47 s to `completed`. | A2-24 – A2-26 |
| F2 | ERC-1271 payers accepted (docs) | **Proven live:** a deployed ERC-1271 contract paid an x402 seller through Circle's Facilitator and `/settle` mined. | A1-17, A1-18 |
| W7 | CLI 1.2.0 | CLI **1.2.2** (2026-10-14) | F1-01 |
| W9 | `services pay` skips `upto` and Permit2 | CLI 1.2.2 **pays `upto` and Permit2**. It won't create a Permit2 approval, and the charged amount is seller-reported. | F1-03 – F1-05 |
| D9 | Point `CIRCLE_DISCOVERY_URL` at an index with "the same schema" | Circle's live items use a non-spec `metadata` object, not the spec's `extensions.bazaar`. A CLI-compatible index must copy Circle's shape. | A3-37 |
| E5 | ERC-8183 fee values GAP | `platformFeeBP` 0, `evaluatorFeeBP` 0. One EOA holds both admin roles and the treasury. No hook has ever been whitelisted. | A4-07 – A4-09 |
| R2 | Registries "upgraded" 2026-09-14 | That was the **first activation**, from a placeholder (`1.0.0`) to v2.0.0. Nothing has changed since. | A5-11, A5-12 |
| R4 | `giveFeedback` blocked for owner/operators | Still true. The older `feedbackAuth` pre-authorization was removed in Jan 2026, so **anyone else** can give feedback. | A5-07, A5-08 |

---

## A. Payments and on-chain (P1)

### A1. Smart-contract payer for vanilla x402

**Short answer: yes, proven on Arc testnet.** A deployed ERC-1271 contract paid a local x402 seller through Circle's Facilitator Service (keyless trial).
- `/verify` returned `isValid:true`.
- `/settle` returned `success:true`, with tx `0x78d909c8…e66d` in block 67854309.
- USDC on Arc runs Circle's `NativeFiatTokenV2_2`, which checks ERC-1271 signatures. Mainnet is shown by simulation only (same implementation bytecode).

Evidence folder: `/Users/zar/Code/ai-on-chain/czar_v0/research/evidence/experiments/a1-erc1271-usdc/` (`README.md`, `raw/`).

#### What USDC on Arc actually is

| # | Fact | Grade | Source (URL or path, version, date) |
|---|---|---|---|
| A1-01 | `0x3600000000000000000000000000000000000000` is a zeppelinos-style `AdminUpgradeabilityProxy`. The implementation slot `0x7050c9e0…f8c3` and `implementation()` both give `0xC6AD664ac6679F4Ce74e10E91449C93Ec1ae3cA6` on **both** mainnet and testnet. The EIP-1967 slot is empty. | CONFIRMED (RPC) | `raw/onchain-reads.txt`; mainnet block 26616774, testnet block 67853964; 2026-10-18 |
| A1-02 | The implementation bytecode is identical on both networks: 23,659 bytes, same SHA-1. Proxy admins differ (mainnet `0x9005e53e3ee2f27999f15e7a52c58f804fc716e0`, testnet `0x49f78af090f1f98e7184b7f61f1f1a8a8064b40d`), and so do `owner()` (mainnet `0xf5a5658b55983E2Aa037cAC7A8431B510E8A97F4`, testnet `0xDC29Bab4A7d5425cA44eeF20a5B67E3D897F9a03`). `paused()` = false on both. | CONFIRMED (RPC) | same |
| A1-03 | `name()` = `"USDC"`, `symbol()` = `"USDC"`, `version()` = `"2"`, `decimals()` = 6. `DOMAIN_SEPARATOR()` equals keccak of `EIP712Domain(name "USDC", version "2", chainId, verifyingContract 0x3600…)`, recomputed locally for chainId 5042 (`0x9405…df84`) and 5042002 (`0x3611…c6b0`). `eip712Domain()` (ERC-5267) **reverts**, so clients must hard-code name/version. | CONFIRMED (RPC + local hash) | same |
| A1-04 | The implementation is **`NativeFiatTokenV2_2`** (`contracts/v2/NativeFiatTokenV2_2.sol`), solc `v0.6.12+commit.27d51765`, optimizer 10,000,000 runs, EVM `istanbul`. The explorer verified it on 2026-08-18 and marks it `is_partially_verified: true` (metadata only). | CONFIRMED (explorer API) | `https://testnet.arcscan.app/api/v2/smart-contracts/0xC6AD…3cA6` (redirects to `explorer.testnet.arc.io`); 2026-10-18 |
| A1-05 | **What it is:** "ERC20 Token that uses blockchain's native coin as its underlying asset". It inherits `FiatTokenV2_2`. Balances and moves go through precompiles: `NATIVE_COIN_AUTHORITY` = `0x1800000000000000000000000000000000000000` and `NATIVE_COIN_CONTROL` = `0x1800000000000000000000000000000000000001`, which handles the blacklist. `DECIMALS_SCALING_FACTOR` = `10**12`, so the 6-decimal view sits over 18-decimal native USDC. | CONFIRMED (verified source) | same, `NativeFiatTokenV2_2.sol` lines 18–66 |
| A1-06 | The verified source is **byte-identical** to `circlefin/stablecoin-evm` tag `release-2026-08-12T202509` (commit `fc85788bc7c23cefe3df1a757133048bfddadeaa`). That covers `NativeFiatTokenV2_2.sol` plus all 21 additional files. CHANGELOG: "2.2.0, Introduce NativeFiatToken variant (2026-03-13)". | CONFIRMED (diff) | `gh` clone at that tag; 2026-10-18 |
| A1-07 | Compared with tag `v2.2.0` (commit `405efc100c016ed1a437063b6274b4e24ea7b8b1`): `SignatureChecker.sol` and `EIP3009.sol` differ only in copyright and licence header lines. The ERC-1271 logic is the same. CHANGELOG 2.2.0 (2023-11-09): "Add ERC-1271 signature validation support to EIP-2612 and EIP-3009 functions". | CONFIRMED (diff) | same |

#### Does it accept ERC-1271 in `transferWithAuthorization`?

| # | Fact | Grade | Source (URL or path, version, date) |
|---|---|---|---|
| A1-08 | Both overloads are in the implementation's dispatcher: `transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)` = `0xcf092995` and `(…,uint8,bytes32,bytes32)` = `0xe3ee160e`. So are `receiveWithAuthorization(…,bytes)` `0x88b7ab63`, `cancelAuthorization(address,bytes32,bytes)` `0xb7b72899` and `permit(address,address,uint256,uint256,bytes)` `0x9fd5a6cf`. | CONFIRMED (bytecode PUSH4 search, both networks) | `raw/onchain-reads.txt` |
| A1-09 | **How the check works:** `EIP3009._requireValidSignature` calls `SignatureChecker.isValidSignatureNow(signer, toTypedDataHash(domainSeparator, structHash), signature)`. If `from` has code, it `staticcall`s `isValidSignature(bytes32,bytes)` and needs the 32-byte return to equal `0x1626ba7e`. Otherwise it uses ECDSA recovery. The `v,r,s` overload packs `abi.encodePacked(r, s, v)` and goes down the same path, so it works for contracts too. | CONFIRMED (verified source) | `contracts/util/SignatureChecker.sol` lines 38–76; `contracts/v2/EIP3009.sol` lines 90–140, 270–290 |
| A1-10 | `SignatureChecker` is an **external linked library** at `0xfcFf98B65F9ea559EC0df36F4072C7E3BE0520Df`. Its address is embedded in the implementation code on both networks, and its code (1,741 bytes) contains `1626ba7e`. That explains why the magic value is missing from the implementation's own bytecode. | CONFIRMED (explorer `external_libraries` + RPC) | `raw/onchain-reads.txt` |
| A1-11 | **Experiment, simulation:** an `eth_call` against the live USDC put a minimal ERC-1271 account (`src/OwnerSig1271.sol`) in place with a code override. Its owner signed the USDC EIP-712 digest. Results on **both testnet (block 67853550) and mainnet (block 26616147)**: the bytes overload moved 1 USDC (payer 10,000,000 → 9,000,000, payee 0 → 1,000,000, `authorizationState` = true). The `v,r,s` overload succeeded. A wrong key reverted `FiatTokenV2: invalid signature`. The same signature against a code-less address reverted `FiatTokenV2: invalid signature`. Zero balance reverted `ERC20: transfer amount exceeds balance`. | CONFIRMED (own experiment, simulation; no mined tx) | `sim.sh`, `raw/sim-testnet.txt`, `raw/sim-mainnet.txt`; 2026-10-18 |
| A1-12 | **Experiment, live on-chain (Arc testnet):**<br>• Deployed `OwnerSig1271` at `0xd80fe1aD38eC902df4Db294795D7CD18163A23EE`: tx `0xe147acdb1baf831a8aa352a732fb3dd9356a13cbf46f4877f1492819912bacda`, block 67854276.<br>• Funded it with 1 USDC: tx `0xfae95790c161ef6659272f00ff78b6f8595b5160a514b77874a51cd26a0a2454`, block 67854283.<br>• The owner EOA, acting as relayer, called the bytes overload `0xcf092995` with `from` = the contract: tx `0x8f5cd4f148c60b2635b3ef606dac7cc8568bb19c6a9818ea29e1c1d3dbf5ef51`, block 67854293, status 1, gas 121,739, 3.5 s from send to receipt.<br>• Result: contract 1,000,000 → 900,000; seller 0 → 100,000; `authorizationState` = true. | CONFIRMED (own experiment, mined) | `live.sh`, `raw/live-run.txt`, `raw/live-direct-3009.json`; 2026-10-18 14:29Z |

#### Does Circle's Facilitator settle it?

| # | Fact | Grade | Source (URL or path, version, date) |
|---|---|---|---|
| A1-13 | Docs: "Facilitator Service accepts signatures from externally owned accounts (EOAs) and from deployed smart contract accounts through ERC-1271. Smart contract accounts that aren't deployed yet (ERC-6492) are not supported. EOA signatures must use a `v` value of 27 or 28." | CONFIRMED (official docs) | `https://developers.circle.com/facilitator-service/how-it-works.md`, "Supported buyer accounts"; 2026-10-18 |
| A1-14 | Circle's OpenAPI says the same for `upto`: "Facilitator Service accepts EOA signatures and signatures from deployed ERC-1271 smart accounts." The seller proof can also come from an ERC-1271 `payTo` ("Deployed smart contract accounts at `payTo` are validated through ERC-1271"). | CONFIRMED (official docs) | `https://developers.circle.com/openapi/facilitator-service.yaml` (`UptoPayload.signature`); `…/facilitator-service/sign-seller-proof.md`; 2026-10-18 |
| A1-15 | **Testnet uses the same base URL** as mainnet. `POST https://api.circle.com/v1/facilitator/x402/verify` and `/settle` take `network: "eip155:5042002"`. `gateway-api-testnet.circle.com` is for Gateway only. `/verify` "doesn't consume keyless trial usage". The keyless trial covers `exact` only. | CONFIRMED (docs + live calls) | `…/facilitator-service/quickstart.md`, `…/keyless-trial.md`, OpenAPI `VerifyPayment`; `raw/verify-C1-*.txt` |
| A1-16 | **Experiment, live `/verify` controls (Arc testnet, keyless, local x402 v2 seller):** (C1) unfunded owner EOA as payer → HTTP 200 in 528 ms, `{"isValid":false,"invalidReason":"insufficient_funds"}`. (C2) payer = `0xd80fe1aD38eC902df4Db294795D7CD18163A23EE`, the address where `live.sh` will deploy the ERC-1271 account (no code yet), signed by the owner → HTTP 200 in 476 ms, `invalid_exact_evm_payload_signature`. This is the "before" half. The "after deploy" half is A1-17. | CONFIRMED (own experiment) | `x402-flow.mjs`, `raw/verify-C1-eoa-unfunded.txt`, `raw/verify-C2-undeployed-contract-address.txt`; 2026-10-18 14:22Z |
| A1-17 | **Experiment, live `/verify` + `/settle` with the deployed ERC-1271 payer (Arc testnet, keyless trial, local x402 v2 seller, 0.1 USDC):**<br>• `/verify`: HTTP 200 in 718 ms and 500 ms, `{"isValid":true,"payer":"0xd80f…23ee"}`. This is the same address that returned `invalid_exact_evm_payload_signature` before deployment (A1-16).<br>• `/settle`: HTTP 200 in 2,621 ms, `{"success":true,"transaction":"0x78d909c8f9b9ac6827b616d25a1a1070078390492677dc8672597db41c06e66d","amount":"100000"}`. Mined in block 67854309, status 1.<br>• The buyer got HTTP 200 with a `PAYMENT-RESPONSE` header. Final balances: contract 800,000, seller 200,000. | CONFIRMED (own experiment, mined) | `x402-flow.mjs`, `raw/live-x402-verify.txt`, `raw/live-x402-settle.txt`; 2026-10-18 14:29:51–54Z |
| A1-18 | **What Circle's settle tx looks like:**<br>• Sent from relayer `0x07C2DA3b4189747a34bBD07a6f9f4B78992CfF11` to `0x3600…`.<br>• Selector `0xcf092995`: the **bytes** overload, even for a 65-byte signature (v = 28). That differs from `@x402/evm` (A1-20).<br>• Gas used: 96,739.<br>• Logs: `AuthorizationUsed` (`0x98de5035`); native system `Transfer` from `0xffff…fffe` for 0.1×10¹⁸; ERC-20 `Transfer` for 100,000. | CONFIRMED (RPC, block 67854309) | `raw/live-tx-summary.txt`, `raw/live-facilitator-settle-calldata.txt` |

#### Reference implementation `@x402/evm` (what open-source facilitators do)

| # | Fact | Grade | Source (URL or path, version, date) |
|---|---|---|---|
| A1-19 | `@x402/evm` 2.28.0 (latest on npm, 2026-09-29). `verifyEIP3009` calls `classifyErc6492Payer`, then `verifyTypedDataSignature`. That function runs `getCode(from)`: with no code it does ECDSA recovery (65-byte sig only); with code it does `readContract isValidSignature(digest, signature)` and needs a result starting with `0x1626ba7e`. ERC-6492 (counterfactual) payers are accepted only if the factory is in `eip6492AllowedFactories` (default `[]`), else `invalid_batch_settlement_evm_eip6492_factory_not_allowed`. | CONFIRMED (package source) | `npm pack @x402/evm@2.28.0`: `dist/esm/chunk-BEMCJZKA.mjs` (`src/shared/verifySignature.ts`), `dist/esm/exact/facilitator/index.mjs` lines 89–258 |
| A1-20 | The settle path (`executeTransferWithAuthorization`) picks the overload by **signature length**. 65 bytes (130 hex) → `v,r,s` overload. Anything else → `bytes` overload. Simulation before settling does the same. So a contract wallet with longer signatures (Safe, Kernel, WebAuthn) uses `0xcf092995`, which exists on Arc USDC (A1-08). | CONFIRMED (package source) | `dist/esm/chunk-DBLZWTJ6.mjs` lines 150–212, 300–331 |
| A1-21 | The x402 spec text still says "The 65-byte signature" and "recovers to the `authorization.from` address". The spec's own smart-account route is ERC-7710, not ERC-1271. The reference code goes further than the spec text. | CONFIRMED (spec) | `coinbase/x402` `specs/schemes/exact/scheme_exact_evm.md` @ `0e6e8c55d86b4f14234fb6e49a4052074fb93e57`, lines 13, 29, 77 |

#### Design implications
- The Czar vault can be the `from` of a vanilla x402 `exact` payment on Arc. The vault's own `isValidSignature` is where on-chain envelope limits can live (A1-09, A1-11, A1-13).
- Whatever the vault returns from `isValidSignature` is the whole check. The digest it receives is the USDC EIP-712 hash, so the vault must decode and limit-check the `TransferWithAuthorization` fields itself. Pass them alongside the signature, or keep a pre-registered allowlist of digests. Otherwise it is only as strong as "the owner key signed" (A1-09).
- The check happens at verify time *and* again at settle time (`staticcall`, `view`). A vault whose answer changes between the two (spent envelope, revoked key) makes settle revert after `/verify` said yes. Expect `/settle` failures as normal (A1-09, A1-19).
- `isValidSignature` is `view`, so it can't decrement an envelope. Spending must be recorded elsewhere: an after-the-fact `Transfer` read, or a pre-reserve tx (A1-09).
- The vault must be **deployed before its first payment**. No ERC-6492 on Circle's Facilitator, and none by default in `@x402/evm` (A1-13, A1-19).
- Hard-code the domain `name "USDC"`, `version "2"`. `eip712Domain()` reverts (A1-03).
- Proven path for Czar: the vault is deployed with code at `from`, the owner or agent key signs the USDC digest, and Circle's Facilitator settles through the bytes overload. About 97k gas, paid by Circle (A1-17, A1-18).
- Use 65-byte signatures if a third-party facilitator might be EOA-strict. Longer signatures go through the `bytes` overload, which Arc USDC supports and Circle already uses (A1-08, A1-18, A1-20).

### A2. Gateway and contracts

Sources used below (all checked 2026-10-18):
- **[SRC]** `circlefin/evm-gateway-contracts` at commit `c21d2d2e356d6566b6c7c3dde7ebcbdf1747590b` (2026-09-29), CHANGELOG top entry `1.3.0 (2026/06)`.
- **[TNV]** Arc testnet explorer verified source of the GatewayWallet implementation `0xa33d52b46964495ea6e2bb09ce85faed05776e28` (`https://explorer.testnet.arc.io/api/v2/smart-contracts/<addr>`), verified 2026-07-22, solc `v0.8.29+commit.ab55807c`, 150 runs, `cancun`.
- **[RPC-T]** `cast` reads, Arc testnet `https://rpc.testnet.arc.io`, block 67852832; **[RPC-M]** Arc mainnet `https://rpc.mainnet.arc.io`, block 26615746. Output: `research/evidence/experiments/a2-gateway-e2e/raw/onchain-reads-*.txt`.
- **[SDK]** `@circle-fin/x402-batching@3.5.0` tarball (`npm pack`), `dist/client/index.mjs`, `dist/server/index.mjs`.
- **[DOC-x]** `https://developers.circle.com/<path>.md`: `gateway/howtos/manage-delegates`, `gateway/references/erc-1271`, `gateway/references/technical-guide`, `gateway/references/fees`, `gateway/references/supported-blockchains`, `gateway-nanopayments/concepts/batched-settlement`, `agent-stack/agent-nanopayments/operations/withdraw`, `release-notes/gateway-2026`; OpenAPI `https://developers.circle.com/openapi/gateway.yaml` (v1.0.0) and `.../gateway-nanopayments.yaml`.
- **[EXP]** My experiment, Arc testnet: `research/evidence/experiments/a2-gateway-e2e/` (README, scripts, `raw/`).

#### Deposits, delegates, signatures (contract source)

| # | Fact | Grade | Source |
|---|---|---|---|
| A2-01 | **Any address, including a contract, can deposit.** `deposit(address token, uint256 value)` credits `msg.sender`; no EOA check. | CONFIRMED (source) | [SRC] `src/modules/wallet/Deposits.sol` |
| A2-02 | **Deposit on behalf of another address:** `depositFor(address token, address depositor, uint256 value)` — pulls from `msg.sender` (approve first), credits `depositor`. Reverts on zero `depositor`, denylisted caller/depositor, or USDC-blacklisted depositor. Event `Deposited(token, depositor, sender, value)`. | CONFIRMED (source + EXP: EOA `depositFor` to a contract, tx `0xf3fc113f…730c`, block 67853513; API showed 0.5 available for the contract) | [SRC] `Deposits.sol`; [EXP] |
| A2-03 | Signature deposits: `depositWithPermit(token, owner, value, deadline, v, r, s)`, `depositWithPermit(token, owner, value, deadline, bytes signature)` (EIP-7597, "to allow for SCA deposits"), `depositWithAuthorization(token, from, value, validAfter, validBefore, nonce, v, r, s)` and a `bytes signature` overload (ERC-7598, uses `receiveWithAuthorization`). Balance goes to `owner`/`from`. | CONFIRMED (source) | [SRC] `Deposits.sol` |
| A2-04 | **Delegates exist:** `addDelegate(address token, address delegate)` gives `delegate` a *full allowance* over the caller's `token` balance; `removeDelegate(address token, address delegate)`; view `isAuthorizedForBalance(address token, address depositor, address addr)`. Events `DelegateAdded`, `DelegateRemoved`. Cannot delegate to self. | CONFIRMED (source + EXP `addDelegate` tx `0x34934364…3445`) | [SRC] `src/modules/wallet/Delegation.sol`; [EXP] |
| A2-05 | Delegate removal sets status `Revoked`, not `Unauthorized`. **Burn intents already signed by a revoked delegate still burn on-chain** (`_wasEverAuthorizedForBalance`). The API stops issuing new attestations for it once the revocation is final. | CONFIRMED (source); DOCS (API side) | [SRC] `Delegation.sol`, `Burns.sol`; [DOC] manage-delegates |
| A2-06 | Delegates only act through **burn intents** (API transfers). On-chain `initiateWithdrawal` and `withdraw` use `msg.sender` only — a delegate cannot start the 7-day trustless withdrawal for someone else. | CONFIRMED (source) | [SRC] `src/modules/wallet/Withdrawals.sol` |
| A2-07 | Burn-intent signature check (`_validateSignatureAndGetSigner`), three paths: (1) ECDSA recovers to `sourceSigner`; (2) ECDSA recovers to a registered TEE `isContractSignatureSigner` (vouches for a contract); (3) `sourceSigner` was ever on the ERC-1271 allowlist → `SignatureChecker.isValidERC1271SignatureNow`. Then `sourceSigner` must have ever been authorized for `sourceDepositor`. | CONFIRMED (source) | [SRC] `src/modules/wallet/Burns.sol` |
| A2-08 | ERC-1271 for burn intents is **live** on Arc testnet: added in contracts 1.1.0 (allowlist) and 1.3.0 (TEE vouch, `ContractSignatureSigners`); API support announced 2026-08-05. Request opts in with `"contractSigner": true` per item in `POST /v1/transfer`. TEE simulates `isValidSignature` against 2-of-3 RPC quorum, blocks up to 5 min old; read-only validation only. | CONFIRMED (source, docs, EXP) | [SRC] CHANGELOG; [DOC] erc-1271, release-notes; [EXP] |
| A2-09 | **Gateway Nanopayments do NOT accept ERC-1271.** Docs: "Gateway Nanopayments … isn't available through ERC-1271." Experiment: a contract with a Gateway balance and a correct `isValidSignature`, owner-signed `GatewayWalletBatched` authorization → `/v1/x402/verify` `isValid:false, invalidReason:"invalid_signature"`. | CONFIRMED (docs + EXP) | [DOC] erc-1271 (Note at end); [EXP] `raw/verify-direct.log` |
| A2-10 | **Gateway Nanopayments do NOT honor delegates.** With `isAuthorizedForBalance(USDC, buyer, delegate) = true` on-chain, a delegate-signed authorization with `from = buyer` → `/v1/x402/verify` `invalid_signature` (re-tested 31 s and 9 min after `addDelegate`, same result). The seller middleware returned "Payment verification failed". No doc mentions delegates for nanopayments. | CONFIRMED (EXP) | [EXP] `raw/verify-direct.log`, `raw/delegate-pay.log` |
| A2-11 | Why (A2-09/10): the batched authorization is EIP-3009 `TransferWithAuthorization(from,to,value,validAfter,validBefore,nonce)` under domain `GatewayWalletBatched` v1 — there is no separate signer field. The SDK always sets `from: this.signer.address`. On-chain, `submitBatch(bytes,bytes)` applies pre-netted `BatchedDelta{depositor,value}` signed by a `batchSigner`; payment signatures are checked off-chain only. | CONFIRMED (SDK + source) | [SDK] `dist/client/index.mjs` `createPaymentPayload`; [SRC] `src/modules/wallet/Batches.sol`, `src/lib/BatchedDelta.sol` |
| A2-12 | SDK `GatewayClient` has `depositFor(amount, depositor)` but **no delegate methods**, and its `createBurnIntent` hard-codes `sourceDepositor = sourceSigner = account.address`. Delegate / ERC-1271 transfers need hand-built burn intents. | CONFIRMED (SDK) | [SDK] `dist/client/index.mjs` |

#### Withdrawals

| # | Fact | Grade | Source |
|---|---|---|---|
| A2-13 | **`withdrawalDelay()` is in blocks** ("The number of blocks that must pass after calling `initiateWithdrawal`"). `initiateWithdrawal` sets `withdrawalBlock = block.number + withdrawalDelay()`; `withdraw` reverts `WithdrawalNotYetAvailable` while `withdrawableAtBlocks > block.number`. This resolves part 1 G8. | CONFIRMED (source) | [SRC] `src/modules/wallet/WithdrawalDelay.sol`, `Withdrawals.sol`, `GatewayWallet.sol` (`/// in blocks`) |
| A2-14 | Value `1209600` on both testnet and mainnet. Testnet batch ticks of 960 s span ≈1,896 blocks ⇒ ≈0.506 s/block ⇒ delay ≈ **7.1 days**. Docs say "7-day withdrawal delay". | CONFIRMED (RPC); derived time | [RPC-T], [RPC-M]; [EXP] `raw/batch-cadence-testnet.txt`; [DOC] technical-guide |
| A2-15 | Trustless flow: `initiateWithdrawal(address token, uint256 value)` (moves available → withdrawing; **repeat calls add to the amount and reset the timer**), then `withdraw(address token)` (withdraws the full withdrawing balance to `msg.sender`). Views `withdrawalBlock(token, depositor)`, `withdrawingBalance`, `withdrawableBalance`. Owner can change the delay with `updateWithdrawalDelay`. | CONFIRMED (source) | [SRC] `Withdrawals.sol`, `WithdrawalDelay.sol` |
| A2-16 | **Non-delayed path exists: a same-chain transfer.** Sign an EIP-712 `BurnIntent` (domain `GatewayWallet` v1, no chainId) with `destinationDomain = sourceDomain = 26`, `POST https://gateway-api[-testnet].circle.com/v1/transfer` → `{transferId, attestation, signature, fees, expirationBlock}`, then anyone calls `GatewayMinter.gatewayMint(attestation, signature)` (permissionless when `destinationCaller` = 0). SDK `GatewayClient.withdraw(amount)` does this ("instant, no 7-day delay"); CLI `circle gateway withdraw` is same-chain only. | CONFIRMED (EXP + SDK + docs) | [EXP] `withdraw.ts`, `raw/withdraw-2.log`; [SDK]; [DOC] agent-stack withdraw, technical-guide |
| A2-17 | Measured on Arc testnet: `/v1/transfer` answered 201 in **~0.4–0.6 s**; mint mined **~1.8–2.0 s** after the request; Circle's `gatewayBurn` on the source landed ~7–14 s after the mint. Fee charged **0.0035 USDC** per intent (`baseFee`), no transfer fee for same chain. Attestation valid ~1,196 blocks (~10 min). | CONFIRMED (EXP) | [EXP] `raw/withdraw-*.log`, `raw/gateway-burns.txt`; [DOC] fees (Arc gas fee $0.0035; same-chain no 0.5 bps fee) |
| A2-18 | Conditions for the instant path (docs): deposit must be finalized (Arc ≈1 block, ≈0.5 s); `maxBlockHeight` must be ≥ current block + `withdrawalDelay`; `maxFee` must cover the gas fee; ≤16 intents per request; Circle's API must be up. If the attestation is never minted, the balance (value + fee) is re-credited after `expirationBlock`. | DOCS; re-credit CONFIRMED (EXP: two unminted attestations of 0.5035 and 0.2035, expiring at blocks 67854778/67854835; buyer balance 0.3805 at block 67854309 → 1.0875 at block 67854972, `raw/buyer-balance-after-expiry.json`) | [DOC] technical-guide, supported-blockchains, fees |
| A2-19 | **Delegates and contracts can use the instant path.** Measured, all 201 + successful mint: (a) delegate EOA signs for the buyer's balance; (b) ERC-1271 contract is the depositor (`contractSigner: true`, owner EOA produces the signature bytes); (c) contract added as **ERC-1271 delegate** of an EOA depositor signs for that EOA's balance. The test contract was *not* on the on-chain allowlist (`isAllowlistedContractSigner` = false) — the TEE-vouch path was used. | CONFIRMED (EXP) | [EXP] `raw/withdraw-delegate.log`, `raw/withdraw-erc1271.log`, `raw/withdraw-erc1271-delegate.log`, `raw/gateway-burns.txt` |

#### Deployed bytecode vs source

| # | Fact | Grade | Source |
|---|---|---|---|
| A2-20 | Testnet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` is an `ERC1967Proxy`; implementation `0xa33d52b46964495ea6e2bb09ce85faed05776e28` (EIP-1967 slot, block 67852832). Explorer: proxy and implementation both `is_fully_verified: true`. | CONFIRMED (RPC + explorer) | [RPC-T]; [TNV] |
| A2-21 | All 29 `src/**/*.sol` files of the explorer-verified implementation are **byte-identical** to the repo at commit `c21d2d2` (includes `ContractSignatureSigners.sol` ⇒ release 1.3.0). | CONFIRMED (diff) | [TNV] vs [SRC] |
| A2-22 | Mainnet `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` implementation `0xd15002e19d75f6abe69e46b2a94cc7c0cc5857de` (block 26615746); same code size (22,818 bytes) as testnet; it answers `isContractSignatureSigner` ⇒ 1.3.0 ABI. Code hashes differ from testnet (`0xfe96…305f` vs `0x69ed…06b4`) — cause unknown (see GAP). | CONFIRMED (RPC) | [RPC-M] |
| A2-23 | Role holders, testnet / mainnet: `owner` `0x5b96…A89` / `0x6b88…4e2`; `pauser` `0x3Ee9…89Ea` / `0xf1e3…7FC0`; `contractSignersAllowlister` `0xd311…b97e` / `0x5173…b969`; `feeRecipient` `0x0368…2E69` / `0xc2c2…DA46`; `domain()` 26; `paused()` false; USDC `0x3600…0000` supported. Full addresses in raw files. Owner is a single address (`Ownable2Step`), and can change `withdrawalDelay`, batch/burn/TEE signers. | CONFIRMED (RPC) | [RPC-T], [RPC-M] |

#### End-to-end nanopayment (Arc testnet)

| # | Fact | Grade | Source |
|---|---|---|---|
| A2-24 | **Full flow run end to end** (resolves part 1 G12 GAP): approve + `deposit` 2 USDC (mined 3.1 s; Gateway API credited 5.9 s after start) → local `createGatewayMiddleware` seller → `GatewayClient.pay()` 1.23 s, HTTP 200, seller handler ran with `verified:true` → transfer `f1f4ddc1-8324-4420-97b9-bb0ae32e3a27` `received` → `completed`, batch tx `0x10acef079f1eecdf3141a24ac1f777a56591c773a79b1a0fc3442b4bdb80e02d` (block 67853617, 14:24:02 UTC), **107 s** after `createdAt` 14:22:14.994. | CONFIRMED (EXP) | [EXP] `raw/events.jsonl`, `raw/poll.jsonl`, `raw/batch-tx.txt` |
| A2-25 | Payment 2 (transfer `d863fd6a-6e1c-4ab6-ac61-22966d41529a`, 2 s polling): `createdAt` 14:27:17.018 `received` → `batched` (updatedAt 14:40:00.573) → `completed` (updatedAt 14:40:04.267). Batch tx `0x70f1ca46a5305ffec1dba2199ab3d0b05036ed99aefc2740b7ce7cc0db21bef5`, block 67855510, block time 14:40:01. **12 min 47 s** to `completed`; `batched` lasts ~4 s. | CONFIRMED (EXP) | [EXP] `raw/poll-id.jsonl`, `raw/batch-tx-2.txt` |
| A2-26 | Testnet batch ticks every **960 s** (13:21:01, 13:36:01, 13:52:01, 14:08:01, 14:24:02 UTC; 13:21→13:36 was 900 s). So latency to `completed` is 0–16 min depending on where the payment lands in the tick. Matches part 1 G5 (mainnet). | CONFIRMED (RPC logs) | [EXP] `raw/batch-cadence-testnet.txt` |
| A2-27 | The batch tx is `submitBatch` (`0xc9486c8b`) from relayer `0xc73e…a884`, emits `BatchProcessed(batchId, signer 0x1b2c…8457, USDC)`. Decoded: 8 deltas netting to 0, including merchant **+1000** and buyer **−1000**. | CONFIRMED (RPC + decode) | [EXP] `raw/batch-tx.txt` |
| A2-28 | **The seller is paid into its Gateway balance, not its wallet.** After the batch, merchant `/v1/balances` = `0.001000`, wallet unchanged. Seller must do a Gateway transfer (A2-16) to get USDC out. Doc: "pending balances become available. The seller can then withdraw". | CONFIRMED (EXP + docs) | [EXP] `raw/merchant-balance.json`; [DOC] batched-settlement |
| A2-29 | Statuses in OpenAPI: `received`, `batched`, `confirmed`, `completed`, `failed`. At 15 s polling, payment 1 went straight `received` → `completed`. `/v1/balances` response has `balance` and `pendingBatch`; a buyer's pending payment is already subtracted from `balance`. | CONFIRMED (OpenAPI + EXP) | [DOC] gateway-nanopayments.yaml; [EXP] |
| A2-30 | Public Gateway endpoints worked **without an API key** on testnet: `POST /v1/x402/verify`, `POST /v1/transfer`, `POST /v1/balances`, `GET /v1/x402/transfers[/{id}]`. | CONFIRMED (EXP) | [EXP] |
| A2-31 | SDK `GatewayClient` config accepts `rpcUrl`, but `withdraw()` mints with the hard-coded destination `rpcUrl` (`https://rpc.testnet.arc.network` for `arcTestnet`) — when that host failed DNS here, the API had already issued the attestation and debited the balance, and the mint threw. Default `maxFee` is `2.01` USDC. | CONFIRMED (SDK + EXP) | [SDK] `withdraw()`; [EXP] `raw/withdraw.log` |

#### Design implications

- A contract vault cannot be the nanopayment payer, even with delegates or ERC-1271 (A2-09, A2-10). The payer must be an EOA whose own key signs. Part 1 G3 stands, now with experiment proof.
- Simplest funding of an executor EOA: vault calls `depositFor(USDC, executorEOA, amount)` — one tx, no executor gas (A2-02, A2-24).
- Vault-side clawback is possible: executor EOA calls `addDelegate(USDC, vault)`; the vault (ERC-1271) then signs a same-chain burn intent with `contractSigner: true` to pull unspent balance back in ~2 s (A2-19c, A2-16). Revoking is weak by design: signed intents survive `removeDelegate` (A2-05).
- A delegate cannot start the on-chain 7-day withdrawal (A2-06); clawback relies on Circle's API being up.
- Sellers are paid into Gateway balances (A2-28); Czar-run sellers (recipes, builder payouts) need a periodic same-chain transfer (0.0035 USDC each, A2-17).
- Budget 0–16 min for `completed` (A2-24, A2-25, A2-26); never block a user-facing step on it. Use `received` from `/settle` as the payment receipt.
- Don't rely on `GatewayClient.withdraw()` for delegate/contract flows or custom RPCs (A2-12, A2-31); hand-build burn intents (working code: `withdraw.ts`).
- Trust: one `owner` can change `withdrawalDelay`, batch signers and TEE signers (A2-23); batch deltas are trusted from the `batchSigner` and can debit `withdrawing` balances too (A2-11). Record in the threat model.

#### Sources for A3–A5

- **Date checked:** 2026-10-18 (all facts below)
- **Raw evidence:** `research/evidence/experiments/a3-a5-reads/` (`reads.sh`, `raw/`)


| Tag | Source | Version / commit |
|---|---|---|
| [X402] | `github.com/x402-foundation/x402` (canonical; `coinbase/x402` README now says it is "a development fork") | commit `faa1c694c66a3732aaabbce93bdae140e521a67d` (2026-10-15). `specs/` is byte-identical to `coinbase/x402` @ `0e6e8c55d86b4f14234fb6e49a4052074fb93e57` |
| [X402-C] | `x402-foundation/x402/contracts/evm/` (README + `src/`) | same commit; Apache-2.0 repo licence, contract files `SPDX MIT` |
| [CORE] | npm `@x402/core@2.28.0` tarball (published 2026-09-29; still latest) | 2.28.0 |
| [EXT] | npm `@x402/extensions@2.28.0` tarball | 2.28.0 |
| [CFS] | Circle docs `developers.circle.com/facilitator-service/how-it-works.md`, `/supported-networks.md`, `/facilitator-service.md` | fetched 2026-10-18 |
| [SUP] | Live `GET https://api.circle.com/v1/facilitator/x402/supported` | 2026-10-18 14:18 UTC |
| [DISC] | Live `GET https://api.circle.com/v2/x402/discovery/resources?limit=2` | 2026-10-18 |
| [ERCs] | `github.com/ethereum/ERCs` `ERCS/erc-8183.md`, `ERCS/erc-8004.md` | repo HEAD `4dec821bcb7dfbd739c843dcb7247e750781dd55`; last commit to erc-8183.md `a078cab5cc` (2026-03-13); to erc-8004.md `503591a6e8` (2026-01-25) |
| [BASE] | `github.com/erc-8183/base-contracts` | `142e669c1fd318486a4628395b629f033654dd06` (2026-06-30), MIT |
| [HOOKS] | `github.com/erc-8183/hook-contracts` | `3abab14cf137ce860efbd577e4ac4d339980f507` (2026-05-12), MIT |
| [8004C] | `github.com/erc-8004/erc-8004-contracts` | `b9e466c250744a7e06b13dff9d3c2844ed64f825` (2026-08-15); no git tags |
| [ARCDOCS] | `docs.arc.io/arc/references/contract-addresses.md` | fetched 2026-10-18 |
| [ABI] | `/Users/zar/Code/ai-on-chain/agent_economy_research/research_docs/learning-notes/crash-courses/arc-lab/abi/AgenticCommerce.ts` (verified ABI of impl `0xA316fd02…351a`) | fetched 2026-10-17 |
| [RPC-M] | `cast` against `https://rpc.mainnet.arc.io` | blocks 26,615,711–26,616,785 (and historical blocks named in the row) |
| [RPC-T] | `cast` against `https://rpc.testnet.arc.io` | blocks 67,852,888–67,854,023 |
| [EXPL-T] | `https://explorer.testnet.arc.io/api?module=logs&action=getLogs…` and `/api/v2/addresses/…` | 2026-10-18 |

### A3. x402 protocol details (current spec version)

#### Headers and core schemas

| # | Fact | Grade | Source |
|---|---|---|---|
| A3-01 | **Current protocol version is 2** (`x402Version: 2`). Spec file `specs/x402-specification-v2.md`, version history "v2.0 2025-12-9". The spec repo is now `x402-foundation/x402`. | CONFIRMED | [X402] |
| A3-02 | **HTTP headers (v2):** `PAYMENT-REQUIRED` (server → client, base64 JSON `PaymentRequired`, sent with HTTP 402), `PAYMENT-SIGNATURE` (client → server, base64 JSON `PaymentPayload`), `PAYMENT-RESPONSE` (server → client, base64 JSON `SettlementResponse`). Spec says all protocol data is in headers; body is a server concern. | CONFIRMED | [X402] `specs/transports-v2/http.md` |
| A3-03 | **Legacy v1 names still in the SDK:** the client sends `X-PAYMENT` when `x402Version === 1` and `PAYMENT-SIGNATURE` for 2; it reads `PAYMENT-RESPONSE` then falls back to `X-PAYMENT-RESPONSE`. The server reads only `payment-signature` / `PAYMENT-SIGNATURE`. A v1 402 body is accepted only if `x402Version === 1`. | CONFIRMED | [CORE] `dist/esm/chunk-FV2JN4FK.mjs` (`encodePaymentSignatureHeader`, `getPaymentSettleResponse`, `extractPayment`) |
| A3-04 | **`PaymentRequired` fields:** `x402Version` (number, req), `error` (string, opt), `resource` (`ResourceInfo`, req), `accepts` (array of `PaymentRequirements`, req), `extensions` (object, opt). | CONFIRMED | [X402] spec v2 §5.1; [CORE] `x402Client-C7_OogbK.d.ts` |
| A3-05 | **`ResourceInfo`:** `url` (req), `description`, `mimeType`, `serviceName` (printable ASCII ≤ 32), `tags` (≤ 5, each ≤ 32 ASCII), `iconUrl` (http(s), ≤ 2048). | CONFIRMED | [X402] spec v2 §5.1.2; [CORE] `interface ResourceInfo` |
| A3-06 | **`PaymentRequirements`:** `scheme`, `network` (CAIP-2, e.g. `eip155:5042`), `amount` (atomic units, string), `asset`, `payTo`, `maxTimeoutSeconds`, `extra`. Spec marks `extra` optional; the TS type makes it required (`extra: Record<string, unknown>`). Reserved `extra` keys: `assetTransferMethod`, `paymentFlow`. | CONFIRMED | [X402] §5.1.2, §6.1; [CORE] |
| A3-07 | **`PaymentPayload`:** `x402Version`, `resource` (opt), `accepted` (the chosen `PaymentRequirements`), `payload` (scheme-specific), `extensions` (opt). For `exact` EVM, `payload` = `{signature, authorization:{from,to,value,validAfter,validBefore,nonce}}`. | CONFIRMED | [X402] §5.2; [CORE] |
| A3-08 | **`SettlementResponse`:** `success`, `errorReason` (opt), `payer` (opt), `transaction` (req; empty string if none; MUST be non-empty for `settlement_pending`), `network`, `amount` (opt; actual settled), `extensions` (opt). TS type also has `errorMessage` and `extra`; `VerifyResponse` TS type has `invalidMessage`. | CONFIRMED | [X402] §5.3, §9; [CORE] |
| A3-09 | **Payment flows** (`extra.paymentFlow`): `authorization` (default: verify → resource → settle), `upfront` (settle → resource), `escrow` (settle → resource → settle). Non-default flows MUST be declared in `accepts[].extra.paymentFlow`; clients SHOULD prefer `authorization`. | CONFIRMED | [X402] §6.1 |
| A3-10 | **Facilitator API:** `POST /verify` (read-only, MUST NOT write state), `POST /settle` (may be called more than once for `escrow`), `GET /supported` → `{kinds:[{x402Version,scheme,network,extra?}], extensions:[...], signers:{"eip155:*":[...]}}`. A facilitator may return extension results in an `EXTENSION-RESPONSES` HTTP header (base64 JSON), never forwarded to buyers. | CONFIRMED | [X402] §7 |
| A3-11 | **`settlement_pending` error code** is non-terminal: tx was broadcast but confirmation unknown; caller must reconcile on chain before retrying. | CONFIRMED | [X402] §9 |

#### `upto` scheme

| # | Fact | Grade | Source |
|---|---|---|---|
| A3-12 | **How the final amount is set:** `amount` in `PaymentRequirements` is phase-dependent. At `/verify` it is the signed maximum; at `/settle` the **resource server** sets it to the actual charge (≤ maximum, may be 0). The facilitator re-verifies the signature against `permit2Authorization.permitted.amount`, checks `requirements.amount <= permitted.amount`, then transfers `requirements.amount`. Single settlement per authorization; 0 means no transaction. | CONFIRMED | [X402] `specs/schemes/upto/scheme_upto.md`, `scheme_upto_evm.md` |
| A3-13 | **EVM `upto` uses Permit2 only** (`permitWitnessTransferFrom`); EIP-3009 is "not supported" for `upto`. Payload is `{signature, permit2Authorization:{permitted:{token,amount}, from, spender, nonce, deadline, witness:{to, facilitator, validAfter}}}`. `spender` is the proxy `0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002`. | CONFIRMED | [X402] `scheme_upto_evm.md` |
| A3-14 | **Who settles:** only the facilitator named in `witness.facilitator`. `x402UptoPermit2Proxy.settle(...)` reverts `UnauthorizedFacilitator()` if `msg.sender != witness.facilitator`; `AmountExceedsPermitted()` guards the cap. Witness type: `Witness(address to,address facilitator,uint256 validAfter)`. Clients learn the facilitator address from `/supported` → `extra.facilitatorAddress`. | CONFIRMED | [X402-C] `src/x402UptoPermit2Proxy.sol` |
| A3-15 | **Buyer prerequisite:** a one-time `approve(Permit2)` on the token, or a sponsored approval (`erc20ApprovalGasSponsoring`) or an EIP-2612 permit (`eip2612GasSponsoring` → `settleWithPermit`). Without allowance, verify returns 412 `PERMIT2_ALLOWANCE_REQUIRED`. | CONFIRMED | [X402] `scheme_upto_evm.md` Phase 1/3 |
| A3-16 | **Circle's statement on `upto` (Arc):** Facilitator Service supports `upto` "on Arc, Base, and Polygon PoS mainnet and on Arc testnet". Contracts used: Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` and x402 Permit2 proxy `0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002`. "Facilitator Service does not meter usage. It accepts the amount you send to `/settle` as long as it doesn't exceed the signed maximum." The witness binds to "a specific Circle facilitator wallet. Only that wallet can submit the settlement." | CONFIRMED (docs read) | [CFS] |
| A3-17 | **Circle `upto` differences from `exact`:** settlement needs a **Circle API key only** (no keyless trial); zero-amount payments supported; repeat `/settle` with the same authorization returns the original payment (no second charge), conflicts return HTTP 409. | CONFIRMED (docs read) | [CFS] how-it-works |
| A3-18 | **Live `/supported` (Circle):** `upto` kinds for `eip155:5042` (facilitatorAddress `0x77149d4ea2d74b803d724bbd4cfc23762753bab2`), `eip155:5042002` (`0xda60a77376fed2842ee3e6770b69b8c3761314a5`), Base and Polygon, each with `assetTransferMethod: "permit2"`. Facilitator extensions: `payment-identifier`, `settlement-status`, `eip2612GasSponsoring`. **No `batch-settlement` kind, no `bazaar`, no `sign-in-with-x`.** | CONFIRMED (live call) | [SUP] |
| A3-19 | **On-chain on Arc:** Permit2 has code on mainnet and testnet (9,152 bytes). `x402UptoPermit2Proxy` has code on both (3,142 bytes, same code hash as Base mainnet). `x402ExactPermit2Proxy` `0x402085c2…20001` has code on **testnet only** (mainnet code size 0). | CONFIRMED | [RPC-M] block 26,615,711; [RPC-T] block 67,852,888 |
| A3-20 | Circle Facilitator accepts buyer signatures from EOAs (`v` = 27/28) and deployed ERC-1271 contracts; not ERC-6492. (Applies to both schemes as written.) | CONFIRMED (docs read) | [CFS] "Supported buyer accounts" |

#### `batch-settlement` scheme

| # | Fact | Grade | Source |
|---|---|---|---|
| A3-21 | **What it is:** a scheme where the commitment is verified per request but value moves later. Settlement "stores" the commitment and returns a **commitment identifier**, not a transfer. Two trust models: capital-backed (escrow/channel) or credit-backed (billing intermediary). Supports dynamic pricing up to `amount`. | CONFIRMED | [X402] `specs/schemes/batch-settlement/scheme_batch_settlement.md` |
| A3-22 | **EVM binding = unidirectional payment channels.** `ChannelConfig{payer, payerAuthorizer, receiver, receiverAuthorizer, token, withdrawDelay (uint40 seconds, 15 min–30 days), salt}`; `channelId = EIP712Hash(ChannelConfig)` under domain `x402 Batch Settlement`. Client deposits once (`eip3009` default, or `permit2`; facilitator-sponsored), then signs **cumulative vouchers** (`maxClaimableAmount`). Payload `type` is `deposit`, `voucher` or `refund`. | CONFIRMED | [X402] `scheme_batch_settlement_evm.md`; [X402-C] `MIN_WITHDRAW_DELAY = 15 minutes`, `MAX_WITHDRAW_DELAY = 30 days` |
| A3-23 | **Server duties:** server owns per-channel state (`chargedCumulativeAmount`, latest voucher, mirrored `balance`/`totalClaimed`); must serialize per channel and update state only after the handler succeeds. Claims via `claimWithSignature(claims, signature)` (many channels per tx, accounting only); `settle(receiver, token)` sweeps to receiver. Payer escape hatch: `initiateWithdraw` → wait `withdrawDelay` → `finalizeWithdraw`. Cooperative `refund` / `refundWithSignature`. `payerAuthorizer = address(0)` means vouchers are checked by EIP-1271 against `payer`. | CONFIRMED | [X402] EVM binding; [X402-C] `x402BatchSettlement.sol` public functions |
| A3-24 | **Contracts on Arc:** `x402BatchSettlement` `0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003`, `ERC3009DepositCollector` `0x4020806089470a89826cB9fB1f4059150b550004`, `Permit2DepositCollector` `0x4020425FAf3B746C082C2f942b4E5159887B0005` have code on Arc mainnet and testnet, though the README's deployment table does not list Arc. The batch-settlement runtime code hash differs between Arc mainnet, Arc testnet and Base (cause not checked). | CONFIRMED (code present); GAP (whether it is the same source/build) | [RPC-M], [RPC-T], [X402-C] README |
| A3-25 | Circle's Gateway Nanopayments (`@circle-fin/x402-batching`, `GatewayWalletBatched`) is a **different system** from x402 `batch-settlement`; Circle Facilitator does not advertise `batch-settlement`. | CONFIRMED (absence in `/supported`) | [SUP]; part 1 G2 |

#### SIWX (`sign-in-with-x`) extension

| # | Fact | Grade | Source |
|---|---|---|---|
| A3-26 | **Purpose:** CAIP-122 wallet sign-in so a server can recognise an address that already paid and skip payment. Server ↔ client only; facilitator not involved. | CONFIRMED | [X402] `specs/extensions/sign-in-with-x.md` |
| A3-27 | **Server declares** `extensions["sign-in-with-x"] = {info:{domain, uri, version:"1", nonce (32 hex), issuedAt, statement?, expirationTime? (default +5 min), notBefore?, requestId?, resources?}, supportedChains:[{chainId, type ("eip191" / "ed25519"), signatureScheme? ("eip191"/"eip1271"/"eip6492"/"siws")}], schema:{…}}`. | CONFIRMED | same |
| A3-28 | **Client proof** goes in HTTP header `SIGN-IN-WITH-X` (base64 JSON): server fields + `address`, `chainId`, `type`, `signature` (example also has `signatureScheme`). EVM message is EIP-4361 (SIWE). Smart wallets: EIP-1271 and EIP-6492 verified on chain. | CONFIRMED | same |
| A3-29 | **Server must** check `domain` and `uri` origin against its **configured** public origin (not `Host`), `issuedAt` < 5 min and not future, nonce unique. Error codes `invalid_siwx_*` (e.g. `invalid_siwx_domain_mismatch`, `invalid_siwx_nonce`, `invalid_siwx_signature`). "Check payment history" is application-specific. | CONFIRMED | same |
| A3-30 | **Spec inconsistencies:** the SIWX examples use `"x402Version": "2"` (string; core says number), and put `supportedChains` beside `info`/`schema` rather than inside `info` (core says an extension is `{info, schema}`). | CONFIRMED (as written) | [X402] sign-in-with-x.md vs spec v2 §5.1.2 |
| A3-31 | Circle's catalog marks SIWX listings with `metadata.siwx: true/false`; part 1 D4 says the CLI hides SIWX listings. | CONFIRMED | [DISC]; part 1 D4 |

#### Bazaar / discovery schema

| # | Fact | Grade | Source |
|---|---|---|---|
| A3-32 | **`GET /discovery/resources` response (spec + SDK):** `{x402Version, items:[DiscoveryResource], pagination:{limit, offset, total}}`. Query params: `type`, `payTo`, `scheme`, `network`, `extensions`, `limit` (spec: 1–100, default 20), `offset`. | CONFIRMED | [X402] spec v2 §8.1; [EXT] `DiscoveryResourcesResponse` |
| A3-33 | **`DiscoveryResource` item (SDK type):** `resource` (string, req), `type` (req, e.g. `http`), `x402Version` (req), `accepts` (`PaymentRequirements[]`, req), `lastUpdated` (ISO 8601, req), optional `description`, `mimeType`, `serviceName`, `tags`, `iconUrl`, `extensions` (e.g. bazaar `info`/`schema`). The spec table lists only the required five + `extensions`. | CONFIRMED | [EXT] `index-BT3nNhEn.d.ts` `interface DiscoveryResource`; [X402] §8.3 |
| A3-34 | **`GET /discovery/search`:** params `query` (req), `type`, `payTo`, `scheme`, `network`, `extensions`, `limit`, `cursor` (both advisory). Response `{x402Version, resources:[DiscoveryResource], partialResults?, pagination?:{limit, cursor}|null}`. Note: **`resources`**, not `items`. | CONFIRMED | [X402] `extensions/bazaar.md`; [EXT] `SearchDiscoveryResourcesResponse` |
| A3-35 | **`extensions.bazaar` (declared in the 402):** `{info:{input, output?}, schema (JSON Schema 2020-12), routeTemplate?}`. `input.type` = `"http"` (query methods `GET`/`HEAD`/`DELETE` with `queryParams`, `headers`; body methods `POST`/`PUT`/`PATCH` with required `bodyType` `json`/`form-data`/`text` and `body`; optional `pathParams`) or `"mcp"` (`toolName`, `inputSchema` required; `description`, `transport` `streamable-http`/`sse`, `example`). `output` = `{type, format?, example?}`. MCP catalog key is (`resource.url`, `toolName`). `routeTemplate` uses `:param`. | CONFIRMED | [X402] `extensions/bazaar.md` |
| A3-36 | **Catalog-poisoning rules:** facilitators MUST validate `info` against `schema`, MUST NOT resolve external `$ref`/`$id`, and MUST soft-drop invalid `serviceName`/`tags`/`iconUrl`. Helper names in the SDK: `isValidServiceName`, `sanitizeTags`, `isValidIconUrl`, `sanitizeResourceServiceMetadata`, `isValidRouteTemplate`. | CONFIRMED | [X402] bazaar.md; [EXT] exports |
| A3-37 | **Circle's live discovery item shape is not the spec shape.** Keys: `resource`, `type`, `x402Version`, `lastUpdated`, `accepts`, **`metadata`** (no `extensions`). `metadata` holds `provider{name, website, docsUrl, description, category, tags}`, `path`, `method`, `description`, `mimeType`, `input`, `output`, `siwx`, `supportsVanillax402`, `supportsCircleGateway`. Top level is `{x402Version, items, pagination:{limit, offset, total}}` (total 2,858). | CONFIRMED (live call) | [DISC] |
| A3-38 | **Permit2 accepts ERC-1271 signatures.** `SignatureVerification.verify`: if `claimedSigner.code.length == 0` it does ECDSA (65- or 64-byte sig); otherwise it calls `IERC1271(claimedSigner).isValidSignature(hash, signature)` and reverts `InvalidContractSignature()` unless the magic value matches. Permit2 has code at `0x000000000022D473030F116dDEE9F6B43aC78BA3` on Arc mainnet and testnet; code hashes differ per chain (Permit2 caches chain-specific EIP-712 immutables), so byte-equality with the repo was not checked. Not tested live with `upto`. | CONFIRMED (source); code present CONFIRMED (RPC, mainnet block 26618674, testnet block 67855838) | `Uniswap/permit2` @ `cc56ad0f3439c502c246fc5cfcc3db92bb8b7219` `src/libraries/SignatureVerification.sol`; lead check 2026-10-18 |

#### Design implications
- A Czar seller must send `PAYMENT-REQUIRED` and read `PAYMENT-SIGNATURE`; a Czar buyer should also accept `X-PAYMENT-RESPONSE` from v1 sellers (A3-02, A3-03).
- `upto` gives "charge after the work" pricing, but the seller alone picks the final amount; the buyer's only protection is the cap (A3-12, A3-16). Czar envelopes must budget the cap, not the expected price.
- `upto` needs a Permit2 allowance on the buyer's USDC — a standing allowance a Czar vault would have to grant to Permit2 (A3-15). Permit2 does accept contract signatures (A3-38), so an ERC-1271 vault can sign `upto` in principle; untested live.
- `upto` on Circle needs a Circle API key on the seller side (A3-17); a Czar-run seller can't use the keyless trial for `upto`.
- `batch-settlement` (A3-22, A3-23) is a standard, on-Arc channel design that fits many sub-cent calls from one envelope and supports EIP-1271 payers, but Circle's facilitator doesn't offer it (A3-18). Using it means running our own facilitator logic or a third party.
- To make Czar's index readable by the Circle CLI via `CIRCLE_DISCOVERY_URL`, mirror Circle's `metadata` item shape (A3-37), not just the x402 spec shape (A3-33). To stay readable by x402 SDK clients, also include spec fields (`extensions.bazaar`, `serviceName`, `tags`). Serving both on one item is possible since all extra fields are optional.
- Treat incoming `extensions.bazaar` from sellers as untrusted: validate and sanitize as the spec requires (A3-36).

### A4. ERC-8183 (Agentic Commerce)

| # | Fact | Grade | Source |
|---|---|---|---|
| A4-01 | **Status: Draft.** Title "Agentic Commerce", created 2026-02-25, authors Davide Crapis, Bryan Lim, Tay Weixiong, Chooi Zuhwa; requires ERC-20. Merged 2026-03-05 (`573d985487`); last change 2026-03-13 (`a078cab5cc`, added the reference implementation). Licence CC0. | CONFIRMED | [ERCs] `ERCS/erc-8183.md` |
| A4-02 | **Hook interface (normative), exact:** `interface IACPHook { function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external; function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external; }`. The reference version `is IERC165`, and the reference `createJob` checks `ERC165Checker.supportsInterface(hook, type(IACPHook).interfaceId)`. | CONFIRMED | [ERCs] erc-8183.md "Hooks", "Reference Implementation" |
| A4-03 | **Hookable:** `setProvider`, `setBudget`, `fund`, `submit`, `complete`, `reject`. **`claimRefund` SHALL NOT be hookable.** `data` encoding: `setProvider` `abi.encode(address provider, bytes optParams)`; `setBudget` `abi.encode(uint256 amount, bytes optParams)`; `fund` raw `optParams`; `submit` `abi.encode(bytes32 deliverable, bytes optParams)`; `complete`/`reject` `abi.encode(bytes32 reason, bytes optParams)`. Before-hooks may revert to block; after-hooks may revert to roll back. | CONFIRMED | [ERCs] |
| A4-04 | **Hooks are optional.** "A non-hooked kernel … is fully compliant." Spec: "Implementations MAY maintain an allowlist or registry of audited hook contracts." Hooks "SHOULD NOT be upgradeable after a job is created". | CONFIRMED | [ERCs] |
| A4-05 | **Normative vs reference mismatch:** normative text says `fund(jobId, expectedBudget, optParams?)` SHALL revert if `job.budget != expectedBudget` (front-running protection). The EIP's own reference code has `function fund(uint256 jobId, bytes calldata optParams)` — no `expectedBudget`. The Arc testnet ABI matches the reference: `fund(uint256,bytes)`. | CONFIRMED | [ERCs] lines 91, 591; [ABI] |
| A4-06 | **Arc testnet deployment = EIP reference shape.** Functions include `createJob(address,address,uint256,string,address)`, `setProvider(uint256,address)`, `setBudget(uint256,uint256,bytes)`, `fund(uint256,bytes)`, `submit(uint256,bytes32,bytes)`, `complete(uint256,bytes32,bytes)`, `reject(uint256,bytes32,bytes)`, `claimRefund(uint256)`, `setHookWhitelist(address,bool)`, `setPlatformFee(uint256,address)`, `setEvaluatorFee(uint256)`, `initialize(address,address,address)`. **No `getRoleMember`** (not AccessControlEnumerable), no pause. | CONFIRMED | [ABI]; `getRoleMember` call reverted [RPC-T] |
| A4-07 | **Current values (Arc testnet proxy `0x0747EEf0706327138c69792bF28Cd525089e4583`, block 67,853,228):** `platformFeeBP` = **0**, `evaluatorFeeBP` = **0**, `platformTreasury` = `0xcBe5B97a069be3E4B5398663790731fb76aB620D`, `paymentToken` = `0x3600000000000000000000000000000000000000`, `jobCounter` = 186,931, implementation (EIP-1967 slot) `0xa316fd02827242d537f84730f8a37d0ba5fd351a`. `whitelistedHooks(address(0))` = true. | CONFIRMED | [RPC-T] |
| A4-08 | **Role holders:** `DEFAULT_ADMIN_ROLE` (`0x00…00`) and `ADMIN_ROLE` (`0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775`) are both held by `0xcBe5B97a069be3E4B5398663790731fb76aB620D` — the same address as the treasury and the proxy creator. Only 2 `RoleGranted` events ever (both in creation tx `0x7b90975a892815bb98c361f899b762590a909a1f2e701628739546113e4e20da`, block 33,908,011, 2026-03-26 16:11 UTC), 0 `RoleRevoked`. `hasRole` = true for both at block 67,853,228. The holder is an EOA (code size 0, nonce 5). `getRoleAdmin(ADMIN_ROLE)` = `DEFAULT_ADMIN_ROLE`. | CONFIRMED | [EXPL-T] getLogs; [RPC-T] |
| A4-09 | **No hook has ever been whitelisted** on the testnet deployment: 0 `HookWhitelistUpdated` events. Only `address(0)` (no hook) is allowed, so today only hook-less jobs can be created there. Only one `Upgraded` event (at creation). | CONFIRMED | [EXPL-T] getLogs (topic0 `HookWhitelistUpdated(address,bool)`, `Upgraded(address)`) |
| A4-10 | **Reference implementation repos:** (a) the EIP text itself (`IACPHook.sol` + `AgenticCommerce.sol`, CC0); (b) `github.com/erc-8183/base-contracts` — README: "Reference implementation of ERC-8183", **MIT**, contracts `ERC8183.sol`, `ERC8183WithAuthorization.sol`, `IERC8183Hook.sol`, `IDisburser.sol`; org `erc-8183` links to eips.ethereum.org/EIPS/eip-8183; (c) `github.com/erc-8183/hook-contracts` (MIT): `BaseERC8183Hook.sol`, `FundTransferHook`, `BiddingHook`, `PrivacyHook`, `MultiHookRouter`. | CONFIRMED | [ERCs], [BASE], [HOOKS] |
| A4-11 | **`base-contracts` has moved past the EIP:** `setProvider(uint256 jobId, address provider_, uint256 agentId)`, `fund(uint256 jobId, address expectedToken, uint256 expectedBudget, bytes optParams)`, payment-token allowlist (`setPaymentTokenAllowed`), `setPayoutReceiver`, `submitClaim`/`settleClaim`/`rejectClaim`, `pause`/`unpause`, `emergencyWithdraw` (admin, while paused), `batchDetachHook`. `initialize(address treasury_, address admin_)`; whitelists `address(0)` at init; fees capped `platformFeeBP + evaluatorFeeBP <= 10000`; `_authorizeUpgrade` needs `DEFAULT_ADMIN_ROLE`. It is **not ABI-compatible** with the Arc testnet contract. | CONFIRMED | [BASE] `contracts/ERC8183.sol` |
| A4-12 | **Can a project deploy its own ERC-8183 contract with its own hooks? Yes.** Both reference codes are open (CC0 / MIT); the spec makes the hook allowlist optional; in both references the deployer chooses the admin at `initialize`, and the admin calls `setHookWhitelist(hook, true)`. Third parties already run their own on Arc mainnet (e.g. `0x8D0A5B74d5716D88d4eD5519FD0AFB8B2Efe9Bb6` has 8,314 bytes of code). | CONFIRMED (licence, code paths, code present); WEAK SIGNAL (who deployed `0x8D0A…9Bb6`: `github.com/JspIIV/arc-acp8183` README via search) | [ERCs], [BASE], [RPC-M] |
| A4-13 | **No official mainnet deployment.** Arc contract-addresses page lists ERC-8183 for **testnet only** ("Arc Testnet hosts a reference implementation"). No code at `0x0747EE…4583` or `0xA316fd…351a` on Arc mainnet; the testnet deployer `0xcBe5…620D` has nonce 0 on mainnet. | CONFIRMED | [ARCDOCS]; [RPC-M] block 26,615,711 |

#### Design implications
- Fees are 0 on testnet today (A4-07), but a single EOA can change fees, whitelist hooks or upgrade the contract at any time (A4-08, A4-06). Don't rely on Circle's testnet instance for anything beyond testing.
- Czar can't attach a hook to the Arc testnet instance without that EOA whitelisting it, and none has ever been whitelisted (A4-09). If Czar needs hooks (e.g. linking jobs to envelopes or acceptance checks), deploy a Czar-owned ERC-8183 contract (A4-12).
- There's no canonical mainnet instance (A4-13). For mainnet, Czar has to deploy its own anyway; pick one base and stick to it, because the EIP reference (Arc testnet ABI) and `erc-8183/base-contracts` differ in `fund`/`setProvider` signatures (A4-05, A4-11).
- If Czar uses the EIP-reference shape, add the `expectedBudget` check the spec requires (A4-05); `base-contracts` already has it.
- Never make `claimRefund` hookable; it is the guaranteed exit (A4-03).
- **Note (2026-10-19, review RV-059):** A4-03's `data` encodings omit the caller. Both the EIP reference (`ethereum/ERCs` `4dec821` lines 581–674) and `erc-8183/base-contracts` `142e669` (lines 646–773) encode `abi.encode(actor, …)`. No Phase 1 impact (hooks are off); re-read before enabling hooks.

### A5. ERC-8004 (Trustless Agents)

| # | Fact | Grade | Source |
|---|---|---|---|
| A5-01 | **Status: Draft**, requires 155, 712, 721, 1271. Last spec change 2026-01-25 (`503591a6e8`, "Updates from community feedback"). The contracts repo's `ERC8004SPEC.md` matches the EIP text (no differences ignoring blank lines). | CONFIRMED | [ERCs]; [8004C] |
| A5-02 | **Deployed implementation version is `2.0.0`** (`getVersion()`) for all three registries on Arc mainnet and testnet; repo sources `IdentityRegistryUpgradeable.sol` and `ReputationRegistryUpgradeable.sol` return `"2.0.0"`. The repo has **no tags or changelog**; last commit 2026-08-15 (README chain list). | CONFIRMED | [RPC-M] block 26,616,785; [RPC-T] block 67,854,023; [8004C] |
| A5-03 | **Global agent ID:** `agentRegistry` = `{namespace}:{chainId}:{identityRegistry}` (e.g. `eip155:5042:0x8004A169…a432`) + `agentId` (ERC-721 tokenId). `agentURI` = tokenURI; may be `ipfs://`, `https://` or `data:application/json;base64,…`; updated with `setAgentURI(uint256 agentId, string newURI)` → `URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)`. | CONFIRMED | [ERCs] erc-8004.md "Identity Registry" |
| A5-04 | **Registration file fields (exact):** `type` = `"https://eips.ethereum.org/EIPS/eip-8004#registration-v1"`, `name`, `description`, `image`, `services` (array of `{name, endpoint, version?}`; OASF entries may add `skills`, `domains`; example names `web`, `A2A`, `MCP`, `OASF`, `ENS`, `DID`, `email`), `x402Support` (bool), `active` (bool), `registrations` (array of `{agentId, agentRegistry}`, all fields mandatory), `supportedTrust` (optional; e.g. `reputation`, `crypto-economic`, `tee-attestation`; absent = discovery only). | CONFIRMED | [ERCs] |
| A5-05 | **Optional domain proof:** publish `https://{endpoint-domain}/.well-known/agent-registration.json` with a `registrations` entry matching the on-chain agent. | CONFIRMED | [ERCs] "Endpoint Domain Verification" |
| A5-06 | **`agentWallet`** is a reserved metadata key (can't be set via `setMetadata`/`register`). Starts as the owner; change with `setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)` (EIP-712 from EOA or ERC-1271), typehash `AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)`; cleared on transfer. Also `getAgentWallet`, `unsetAgentWallet`. Selectors present in the mainnet implementation bytecode. | CONFIRMED | [ERCs]; [8004C] `IdentityRegistryUpgradeable.sol`; [RPC-M] bytecode grep |
| A5-07 | **Feedback flow (current): no pre-authorization.** Any address may call `giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)` except the agent's owner or approved operators (contract: `require(!isAuthorizedOrOwner(msg.sender, agentId), "Self-feedback not allowed")`). `valueDecimals` 0–18. Emits `NewFeedback(...)`. Selector `0x3c036a7e` is in the mainnet Reputation implementation. | CONFIRMED | [ERCs]; [8004C] `ReputationRegistryUpgradeable.sol`; [RPC-M] |
| A5-08 | **What changed from the older spec:** the 2025-10-08 "Review" text (`cb7ae28320`) required the agent to sign a `feedbackAuth` tuple (`agentId, clientAddress, indexLimit, expiry, chainId, identityRegistry, signerAddress`) and used `giveFeedback(uint256 agentId, uint8 score, bytes32 tag1, bytes32 tag2, string fileuri, bytes32 filehash, bytes feedbackAuth)`. `feedbackAuth` is gone from 2026-01-07 (`c4e857ca95`) onward; score became signed `int128 value` + `valueDecimals`; tags became strings; `endpoint` added. | CONFIRMED | [ERCs] file at `cb7ae28320`, `c4e857ca95`, `503591a6e8` (via `gh api … contents?ref=`) |
| A5-09 | **Other reputation calls:** `revokeFeedback(uint256 agentId, uint64 feedbackIndex)`; `appendResponse(uint256 agentId, address clientAddress, uint64 feedbackIndex, string responseURI, bytes32 responseHash)` (anyone); `getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2)` — spec says `clientAddresses` MUST be non-empty (Sybil risk); `readFeedback`, `readAllFeedback`. Stored on chain: `value`, `valueDecimals`, `tag1`, `tag2`, `isRevoked`; `endpoint`, `feedbackURI`, `feedbackHash` are event-only. | CONFIRMED | [ERCs] |
| A5-10 | **Off-chain feedback file:** required `agentRegistry`, `agentId`, `clientAddress` (CAIP-10 style), `createdAt`, `value`, `valueDecimals`; optional `tag1`, `tag2`, `endpoint`, `mcp`, `a2a`, `oasf`, `proofOfPayment{fromAddress, toAddress, chainId, txHash}` ("can be used for x402 proof of payment"). | CONFIRMED | [ERCs] |
| A5-11 | **What the 2026-09-14 upgrade on Arc mainnet was:** an **activation from a placeholder**, not a feature change. Before, all three proxies pointed to bootstrap implementation `0xcb7af40c0be4fb92e183942b6dbb6b14a888f067` with `getVersion()` = `"1.0.0"` (matches repo `MinimalUUPSMainnet.sol`: owner hard-coded `0x547289319C3e6aedB179C0b8e8aF0B5ACd062603`, no registry logic). Identity switched to `0x7274e874ca62410a93bd8bf61c69d8045e399c02` (v2.0.0) at block **20,817,518** (tx `0xfacf3e9d…c11e`, `Upgraded` + `Initialized(2)`); Reputation → `0x16e0fa7f7c56b9a767e34b192b51f921be31da34` and Validation → `0xdb31f5d9167f8ebc8b30fbbf814c4d297c2d7f99` in later blocks (both still on the bootstrap at block 20,817,518; tx hashes in part 1 [OC]). | CONFIRMED | [RPC-M] storage + `getVersion()` at blocks 20,817,517 / 20,817,518 / latest; [8004C] `contracts/MinimalUUPSMainnet.sol` |
| A5-12 | **No upgrade since:** current implementations equal the 2026-09-14 targets; owner `0x5472…2603` nonce on Arc mainnet is still 3 (one tx per registry). Testnet registries run the same three implementation addresses, v2.0.0. | CONFIRMED | [RPC-M] block 26,616,785; [RPC-T] block 67,854,023 |
| A5-13 | The contracts repo README lists Arc **Testnet** addresses but not Arc mainnet; Arc docs list both. | CONFIRMED | [8004C] README line 179; [ARCDOCS] |
| A5-14 | A branch `feat/unique-reverse-lookup` (2026-06-04, "enforce agentWallet uniqueness via reverse-lookup bucket check") is not merged to `master`; other open branches `feat/tee`, `feat/tee-registry`, `mainnet`. | CONFIRMED | [8004C] `git branch -r`, `git log --all` |

#### Design implications
- Feedback needs no permission from the agent (A5-07, A5-08), so ERC-8004 reputation on Arc is open to spam; only read it filtered by client addresses Czar trusts (A5-09).
- A Czar registration file should use the exact `registration-v1` fields (A5-04) and can set `x402Support: true`; use the `.well-known/agent-registration.json` proof for endpoint domains (A5-05).
- To link a payment to feedback, put an x402 tx in `proofOfPayment` (A5-10) — it's in the off-chain file, so it's only as trustworthy as the file host plus `feedbackHash`.
- The registries are upgradeable by one EOA at any time (A5-11, A5-12; part 1 R2). Pin the implementation address Czar was tested against and alert on `Upgraded`.
- Payment address for an agent should be read via `getAgentWallet`, not `ownerOf` (A5-06).

#### Sources for A6–A9

- **Date checked:** 2026-10-18 (every row below)
- **Experiment folder:** `research/evidence/experiments/a6-a9-arc-probes/` (README, scripts, raw outputs). Shorthand `[EXP]/<file>`.
- **Mainnet** = Arc chain `5042` via `https://rpc.mainnet.arc.io`. **Testnet** = chain `5042002` via `https://rpc.testnet.arc.io`.
- Block numbers are given for every on-chain read. Mainnet reads happened in blocks `26615632`–`26617677`, testnet reads in blocks `67852798`–`67855644`.

### A6. Passkeys and smart accounts on Arc

| # | Fact | Grade | Source (URL or path, version, date) |
|---|---|---|---|
| A6-01 | **The P-256 verify precompile is live at `0x0000000000000000000000000000000000000100` on mainnet and testnet.** The EIP-7951 vector "SHA-256 #1: signature malleability" (valid) returns `0x…0001`. Vector "SHA-256 #3: Modified r or s" returns `0x` (empty). The same valid vector with one hash byte changed also returns `0x`. | CONFIRMED (eth_call, mainnet block `26615844`, testnet block `67853022`) | `[EXP]/p256-precompile.txt`, `p256-probe.sh`. Vectors from `ethereum/EIPs` `assets/eip-7951/test-vectors.json` @ `69ce35b4` |
| A6-02 | **Arc charges the EIP-7951 price (6900 gas), not RIP-7212 (3450).** A `STATICCALL` to `0x100` with 6899 gas returns empty; with 6900 gas it returns `1`. Same on both networks. | CONFIRMED (eth_call + code override, mainnet block `26615816`, testnet block `67852989`) | `[EXP]/p256-gascap.txt`, `p256-gascap-probe.sh`. EIP-7951 (status `Final`): "gas cost of `6900`"; RIP-7212 was 3450 |
| A6-03 | The interface is the same as RIP-7212. Input is 160 bytes (`hash ‖ r ‖ s ‖ x ‖ y`). Success returns a 32-byte `1`. Failure returns empty output and does not revert. EIP-7951 also adds the point-at-infinity check that RIP-7212 lacked. | CONFIRMED (spec) | https://github.com/ethereum/EIPs/blob/69ce35b4/EIPS/eip-7951.md |
| A6-04 | Arc docs don't name the P-256 precompile. They say Arc "targets the **Osaka** hard fork as its baseline", and Osaka includes EIP-7951. A6-01/02 are the proof. | CONFIRMED (docs) | https://docs.arc.io/arc/references/evm-differences.md |
| A6-05 | **Circle Modular Wallets (passkey MSCA) support Arc mainnet and testnet.** The wallets supported-blockchains table lists "Arc (`ARC` / `ARC-TESTNET`) … Modular: MSCA". The "Create a modular wallet" guide uses Arc Testnet as its example (`${clientUrl}/arcTestnet`, `import { arcTestnet } from "viem/chains"`). | CONFIRMED (docs) | https://developers.circle.com/wallets/supported-blockchains.md ; https://developers.circle.com/wallets/modular/create-a-modular-wallet.md |
| A6-06 | Web SDK package `@circle-fin/modular-wallets-core`, latest `1.0.16` (registry modified 2026-09-16). The transport is `toModularTransport(clientUrl, clientKey)`, where the URL is `<modular wallets base URL>/<chain>` (for example `arcTestnet`). Passkeys use `toPasskeyTransport`. The SDK enums include `ContractAddress.Arc_USDC` and `ContractAddress.ArcTestnet_USDC`. iOS and Android SDKs also exist (docs pages); their versions were not checked. | CONFIRMED (npm + tarball + docs) | `npm view @circle-fin/modular-wallets-core` ; tarball `dist/index.d.ts` ; https://developers.circle.com/sdks/modular/web-sdk.md |
| A6-07 | The SDK tarball hard-codes factory `0x0000000DF7E6c9Dc387cAFc5eCBfa6c3a6179AdD`. On Arc that address is a verified `UpgradableMSCAFactory`. Blockscout ranks it among the top factories (5,791 accounts on testnet, 338 on mainnet). Circle's `SingleOwnerMSCAFactory` `0xf61023061ed45fa9eAC4D2670649cE1FD37ce536` is the #1 testnet factory (39,352 accounts). | CONFIRMED (tarball + explorer API) | `@circle-fin/modular-wallets-core@1.0.16` `dist/index.mjs` ; `[EXP]/blockscout-userops-indexer.txt`, `blockscout-testnet-address-names.txt` |
| A6-08 | Circle Paymaster's address table lists no Arc row. This is expected, since Arc gas is already USDC. | CONFIRMED (docs) | https://developers.circle.com/paymaster/addresses-and-events.md |
| A6-09 | **The eth-infinitism EntryPoint addresses**, copied from the GitHub release notes: v0.6 `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`; v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032`; v0.8 `0x4337084d9e255ff0702461cf8895ce9e3b5ff108`; **v0.9 `0x433709009B8330FDa32311DF1C2AFA402eD8D009`** (released 2025-11-16), with SenderCreator v0.9 `0x0A630a99Df908A81115A3022927Be82f9299987e`. | CONFIRMED (release notes) | `gh api repos/eth-infinitism/account-abstraction/releases` (tags v0.6.0, v0.7.0, v0.8.0 `27377b14`, v0.9.0 `b36a1ed5`) |
| A6-10 | **All four EntryPoints (v0.6, v0.7, v0.8, v0.9) and SenderCreator v0.9 have code on mainnet and testnet.** | CONFIRMED (eth_getCode, mainnet block `26616061`, testnet block `67853245`) | `[EXP]/address-probe.txt` |
| A6-11 | The v0.6 and v0.7 codehashes on Arc equal Ethereum mainnet's (`0xc93c806e…`, `0x8db5ff69…`). The v0.8 and v0.9 codehashes differ between chains. The byte diff shows only the chain ID (`0x13b2` vs `0x4cef52`) and the cached EIP-712 domain separator (immutables) changed. This is the same bytecode, not a fork. | CONFIRMED (eth_getCode + byte diff; Ethereum block `26220007`) | `[EXP]/codediff.txt`, `codediff.py` |
| A6-12 | Arc's contract-addresses page does **not** list EntryPoints. Arc's paymaster how-to names EntryPoint v0.7 and says to verify before use. | CONFIRMED (docs) | https://docs.arc.io/arc/references/contract-addresses.md ; https://docs.arc.io/integrate/relayers-and-paymasters/deploy-a-paymaster.md |
| A6-13 | **ERC-4337 is in active use on Arc.** In 9,000 blocks (~75 min), mainnet emitted 520 `UserOperationEvent`s on v0.7, 38 on v0.8, 4 on v0.6 and 0 on v0.9. Testnet emitted 48 on v0.6, 40 on v0.7, 1 on v0.8 and 0 on v0.9. | CONFIRMED (eth_getLogs, mainnet blocks `26607557`–`26616557`, testnet blocks `67844775`–`67853775`) | `[EXP]/userop-activity.txt` |
| A6-14 | Blockscout's user-ops indexer runs for both networks (v0.6 and "v07_v08" enabled). Top mainnet bundler `0xB1bcCa2AC714A6eED7742866a2EC772394E9ea1A`: 639,438 bundles. Verified paymasters include `SingletonPaymasterV7` at `0x777777777777AeC03fd955926DbF81597e66834C`. Verified factories include ZeroDev `KernelFactory` at `0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419`. Which company runs each bundler EOA was not established. | CONFIRMED (explorer API) | `https://user-ops-indexer-arc-{mainnet,testnet}…blockscout.com/api/v1/{status,bundlers,paymasters,factories}` → `[EXP]/blockscout-userops-indexer.txt` |
| A6-15 | **Pimlico supports Arc mainnet (`arc`, 5042) and Arc testnet (`arc-testnet`, 5042002).** Bundler: v0.6, v0.7, v0.8 and v0.9. Paymaster: v0.6, v0.7 and v0.8 (no v0.9 paymaster). "EIP-7702 support: ✅". For v0.8 only Simple Account is marked supported. | CONFIRMED (docs) | https://docs.pimlico.io/guides/supported-chains |
| A6-16 | **Alchemy** marks "Arc Mainnet" and "Arc Testnet" ✅ for Bundler, Gas Sponsorship, ERC20 Gas Payments and BSOs. | CONFIRMED (docs) | https://www.alchemy.com/docs/wallets/supported-chains |
| A6-17 | **ZeroDev** lists "Arc Mainnet" 5042 and "Arc Testnet" 5042002 under "Regular EVM Networks". | CONFIRMED (docs) | https://docs.zerodev.app/sdk/faqs/chains |
| A6-18 | **Biconomy** lists Arc Testnet only, for MEE versions `2.2.1, 2.1.0`. Arc mainnet is not listed, and Arc is in none of its ERC-4337 infra tables. | CONFIRMED (docs) | https://docs.biconomy.io/contracts-and-audits/supported-chains |
| A6-19 | **Circle**: the Modular Wallets client URL (`…/arcTestnet`) acts as Circle's bundler and paymaster endpoint for MSCA. | CONFIRMED (docs) | https://developers.circle.com/wallets/modular/create-a-modular-wallet.md |
| A6-20 | **Candide**: no Arc listing found. Its endpoint page fetched empty; pricing puts "new and custom networks" on Enterprise. | GAP | see GAPs |
| A6-21 | Arc's account-abstraction page says "Arc supports the ERC-4337 standard". It lists Alchemy, Biconomy, Blockradar, Circle Wallets, Crossmint, Dynamic, MetaMask Embedded Wallets, Para, Pimlico, Privy, Thirdweb, Turnkey and Zerodev. | CONFIRMED (docs) | https://docs.arc.io/arc/tools/account-abstraction.md |
| A6-22 | **EIP-7702 per Arc docs:** "Arc targets the **Osaka** hard fork as its baseline, including features such as EIP-7702 (set-code transactions)". The docs also say EIP-7702 transactions "behave as on Ethereum". | CONFIRMED (docs) | https://docs.arc.io/arc/references/evm-differences.md |
| A6-23 | **Live RPC accepts type-4 txs for validation.** A signed type-4 tx from an unfunded throwaway key was rejected with `-32003 insufficient funds … have 0 want 4000000000000000` on both networks. That is the same error as a type-2 control tx, and it is not a "tx type not supported" error. | CONFIRMED (eth_sendRawTransaction, testnet block `67854834`, mainnet block `26617677`) | `[EXP]/eip7702/rpc-acceptance.txt` |
| A6-24 | **`arc-anvil --network arc` executes 7702.** A self-sponsored type-4 tx mined with `status 1`, and the EOA code became `0xef0100‖0x3600…0000`. `cast send --auth` without `--gas-limit` failed in gas estimation (`execution reverted, data: "0x"`); an explicit gas limit worked. | CONFIRMED (local experiment) | `[EXP]/arc-anvil-smoke.txt`, `arc-anvil-smoke.sh` |
| A6-25 | No type-4 txs were found in the last 600 blocks (~5 min) on either network. Live use is not shown. | CONFIRMED (block scan, mainnet blocks `26616340`–`26616939`, testnet blocks `67853542`–`67854141`) | `[EXP]/scan-type4.txt` |
| A6-26 | A funded, mined 7702 test on live testnet was **not** run. `circle wallet fund --address <throwaway> --chain ARC-TESTNET` returned `NOT_FOUND: Wallet not found for address …`, because the CLI faucet only funds the user's own Circle wallets. Steps for a human are in the experiment README. | GAP (blocked) | `[EXP]/eip7702/faucet-attempt.txt` ; Circle CLI `1.2.0` help: "must be one of your wallets" |

#### Design implications
1. Passkey signatures can be checked on-chain for 6900 gas via `0x100`, so Czar contracts can verify WebAuthn P-256 directly (A6-01, A6-02). Budget 6900 gas, not 3450 (A6-02).
2. Treat empty return data as "invalid", never as a revert (A6-01, A6-03).
3. Circle Modular Wallets is a supported passkey-account path on both Arc networks (A6-05–A6-07).
4. Any EntryPoint v0.6–v0.9 can be targeted, but pick v0.7 or v0.8: they carry most traffic and have bundler plus paymaster support from Pimlico and Alchemy (A6-10, A6-13, A6-15, A6-16). v0.9 has no Pimlico paymaster and no traffic seen (A6-13, A6-15).
5. Don't hard-code a single bundler. Pimlico, Alchemy, ZeroDev and Circle cover both networks; Biconomy covers testnet only (A6-15–A6-19).
6. 7702 is supported by docs, RPC and the local node, but live use is unproven until the funded test runs (A6-22–A6-26).
7. When sending 7702 txs with Foundry, set `--gas-limit` explicitly (A6-24).

### A7. Revenue splits on Arc

| # | Fact | Grade | Source (URL or path, version, date) |
|---|---|---|---|
| A7-01 | **0xSplits v2.2 is deployed on Arc mainnet and testnet** at the same addresses as Base: `PullSplitFactoryV2.2` `0x6B9118074aB15142d7524E8c4ea8f62A3Bdb98f1`, `PushSplitFactoryV2.2` `0x8E8eB0cC6AE34A38B67D5Cf91ACa38f60bc3Ecf4`, `SplitsWarehouse` `0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8`. | CONFIRMED (repo deployments + eth_getCode, mainnet block `26616061`, testnet block `67853245`) | `0xSplits/splits-contracts-monorepo` @ `efec4ac4` (2026-10-02, "chore(splits-v2): record Arc mainnet and testnet deployment (#88)") `packages/splits-v2/deployments/{5042,5042002}.json` ; `[EXP]/address-probe.txt` |
| A7-02 | The factories hold 3,030 bytes of code each. `SplitsWarehouse` holds 12,146 bytes; its mainnet, testnet and Base bytecode differ only in the chain ID and domain-separator immutables. | CONFIRMED (eth_getCode + byte diff) | `[EXP]/codediff.txt` |
| A7-03 | **0xSplits v1 `SplitMain` `0x2ed6c4B5dA6378c7897AC67Ba9e43102Feb694EE` is NOT on Arc** (no code on either network). The v2.0 and v2.1 factories are also absent. | CONFIRMED (eth_getCode) | `[EXP]/address-probe.txt` |
| A7-04 | `@0xsplits/splits-sdk` `6.7.0` has `ARC = 5042` and `ARC_TESTNET = 5042002` in `SPLITS_V2_SUPPORTED_CHAIN_IDS`, but not in `SPLITS_SUPPORTED_CHAIN_IDS` (v1). Arc is not in `SPLITS_SUBGRAPH_CHAIN_IDS`. | CONFIRMED (source) | `0xSplits/splits-sdk` @ `12936cc0` `packages/splits-sdk/src/constants/index.ts` |
| A7-05 | Splits V2 audit: "Prepared by: Zach Obront … Date: Feb 19 to 23, 2023" (year as written), at commit `9dde20f6a537675bc9ca47acb276ea9ecb2dcc26`. Scope: `SplitWalletV2.sol`, `SplitFactoryV2.sol`, `ERC6909.sol`, `ERC6909X.sol` and libraries. Whether the v2.1 and v2.2 changes were re-audited is not stated in the repo. | CONFIRMED (repo); GAP (v2.2 audit coverage) | `splits-contracts-monorepo/audits/splits-v2.md` @ `efec4ac4` |
| A7-06 | Splits docs: contracts are "independently audited"; the bug bounty pays "up to **$50,000** for critical fund-loss bugs"; testnet deployments are out of scope. | CONFIRMED (docs repo) | `0xSplits/splits-docs` @ `83a2e5b1` `src/pages/resources/security.mdx` |
| A7-07 | V2 design: `PullSplit` deposits into the ERC-6909 `SplitsWarehouse` and recipients claim from it. `PushSplit` sends directly to recipients. Factories create CREATE2 clones with address prediction. | CONFIRMED (source layout) | `splits-contracts-monorepo/packages/splits-v2/AGENTS.md` and `src/` @ `efec4ac4` |
| A7-08 | Drips (splits plus repo-owned accounts) is **not** deployed on Arc. Its deployments cover ethereum, filecoin, metis, optimism, sepolia, optimism-sepolia (plus old testnets). | CONFIRMED (repo) | `drips-network/contracts` @ `07c39242` `deployments/` |
| A7-09 | Arc's contract-addresses page lists no splits protocol. | CONFIRMED (docs) | https://docs.arc.io/arc/references/contract-addresses.md |

#### Design implications
1. Czar can use audited 0xSplits V2.2 (Pull or Push) on both Arc networks instead of writing its own splitter (A7-01, A7-05).
2. Use the V2 factories only. V1 `SplitMain` is absent, and v1 SDK paths will fail on Arc (A7-03, A7-04).
3. Split balances can't be read from the 0xSplits subgraph on Arc; index events ourselves (A7-04, A9 rows).
4. Native USDC is 18-decimal native value and also a 6-decimal ERC-20. Test split payouts with `arc-anvil`, because standard anvil gets this wrong (A7-01, A9-12; part 1 A4).

### A8. Identity for builders

| # | Fact | Grade | Source (URL or path, version, date) |
|---|---|---|---|
| A8-01 | **ENS is not on Arc.** The ENS registry address `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e` has no code on testnet. On mainnet it holds an **unrelated** 2,747-byte contract (Ethereum's has 5,346 bytes). Its selectors resolve to `transferTokensTo`, `changeForwardingAddress`, `getOwner`, `recoverUSDT`, `recoverUSDC`, `changeOwner`, `getForwardingAddress`, and `owner(bytes32)` fails. **Do not treat that address as ENS on Arc.** | CONFIRMED (eth_getCode + eth_call, mainnet block `26616147`) | `[EXP]/address-probe.txt`; `cast selectors` / `cast 4byte` this session |
| A8-02 | **ENSIP-19 (multichain primary names):** the reverse node for an EVM chain is `[addr].[coinTypeAsHex].reverse`, with `coinType = 0x80000000 \| chainId`. For Arc mainnet that is `0x800013b2` (2147488690); for testnet `0x804cef52`. There is also a default `[addr].default.reverse`. The ENSIP-19 "Supported Chains" list is Default, Ethereum, Optimism, Base, Arbitrum, Linea and Scroll (plus Sepolia variants). **Arc is not listed.** | CONFIRMED (spec) | https://docs.ens.domains/ensip/19 ; coinType computed this session |
| A8-03 | Only chains that post state to L1 get chain-specific reverse resolvers. Arc is an L1, so an Arc-specific ENS primary name is not available. An Arc address can still use the **default** reverse name set on Ethereum L1. | CONFIRMED (spec text); applying it to Arc is STRONG SIGNAL (inference) | https://docs.ens.domains/ensip/19 ; https://docs.ens.domains/web/reverse |
| A8-04 | Forward resolution "name → Arc address" works off-chain today: an ENS name on Ethereum stores `addr(node, 2147488690)`, and clients resolve it with an Ethereum RPC (CCIP-Read where the resolver uses it). Arc contracts can't read ENS. | STRONG SIGNAL (from ENSIP-9/11/19 mechanics; not tested end to end) | https://docs.ens.domains/ensip/19 |
| A8-05 | The Arc mainnet Blockscout name service lists only `ens` (TLD `eth`, from `eth.blockscout.com`). The testnet name service returns "Network with id 5042002 not found". | CONFIRMED (API) | `https://bens.services.blockscout.com/api/v1/{5042,5042002}/protocols` |
| A8-06 | Third-party `.arc` name services exist (Orixa Domains, ArcNS, arcnames.co). None is official, and ArcNS says it has no link to Arc or Circle. | WEAK SIGNAL (project sites, unaudited) | https://www.orixa.domains/ ; https://github.com/cekuu35/arcns ; https://arcnames.co/ |
| A8-07 | **EAS is not deployed on Arc** per EAS's own lists. The `eas-contracts` README and `deployments/` (25 networks) have no Arc entry, and `eas-sdk`, `eas-sdk-v2` and `eas-indexing-service` don't mention 5042. No code at any well-known EAS address on either network: Ethereum `0xA1207F…E587` / `0xA7b392…7BDF`, OP-stack predeploys `0x4200…0021` / `0x4200…0020`, Arbitrum `0xbD75f6…c458`, Polygon `0x5E634e…F790`. A third-party EAS deployment at some other address can't be ruled out. | CONFIRMED (repos + eth_getCode, mainnet block `26616061`, testnet block `67853245`) | `ethereum-attestation-service/eas-contracts` @ `e6e97028` ; `[EXP]/address-probe.txt` |
| A8-08 | **Drips `FUNDING.json` mechanism:** the repo's default branch must hold root `FUNDING.json` of the form `{"drips": {"<chain>": {"ownedBy": "0x…"}}}`. A Lit Protocol action fetches `raw.githubusercontent.com/{name}/HEAD/FUNDING.json` and signs an EIP-712 `DripsOwnership(bytes32 chain,uint8 sourceId,bytes name,address owner,uint32 timestamp)` payload. `RepoDriver.updateOwnerByLit(...)` accepts it only if `signer == litOracle`. Other sources include `gitLab`, `gitHubUser` (via `api.github.com/users/{name}/social_accounts`), `orcid`, `website`, `huggingFace` and `codeberg`. | CONFIRMED (source + docs) | `drips-network/contracts` @ `07c39242` `src/RepoDriver.sol`, `oracle/litAction.js` ; `drips-network/docs` @ `c063b361` `get-support/claim-your-repository.mdx` |
| A8-09 | **Drips trust:** (a) the Lit oracle key (`litOracle`), which the Drips admin can replace via `updateLitOracle` (`onlyAdminOrConstructor`, `Managed`/upgradeable); (b) GitHub serving `raw.githubusercontent.com` honestly; (c) anyone with push rights to the default branch can change the owner. Drips is not on Arc (A7-08). | CONFIRMED (source) | same as A8-08 |
| A8-10 | **Signed gist / Keybase-style proof:** the user signs a statement binding the identity and posts it as a GitHub gist. Verifiers fetch the gist and check the signature. Keybase docs: "The server is not trusted… the client verifies the GitHub proof itself." For Ethereum keys the same pattern is an EIP-191 signature in a gist. Trust: GitHub's attribution of the gist to the account; anyone can verify, no oracle needed. | CONFIRMED (Keybase docs for the pattern); Ethereum variant is STRONG SIGNAL (convention, no standard) | https://book.keybase.io/docs/server |
| A8-11 | GitHub publishes per-user public key material that verifiers can fetch without auth: `https://github.com/<user>.keys` (SSH), `GET /users/{u}/gpg_keys`, `GET /users/{u}/ssh_signing_keys`, `GET /users/{u}/social_accounts`. GitHub has no native Ethereum-address field. | CONFIRMED (API calls this session) | `gh api users/octocat/...` ; `curl https://github.com/octocat.keys` (HTTP 200) |
| A8-12 | **GitHub OAuth attestations — Human Passport (ex-Gitcoin Passport):** the GitHub stamp uses OAuth, and the backend issues a W3C Verifiable Credential. Providers: `githubContributionActivityGte#30` / `#60` / `#120` ("commits on at least N different days"). The credential record holds the GitHub user ID; it proves activity, not repo ownership. On-chain copies are EAS attestations via `eas-proxy`, on chain IDs `0xa`, `0x2105`, `0xa4b1`, `0xe708`, `0x144`, `0x82750`, `0x168` and testnets. **Arc is not among them.** Trust: Passport's issuer key and its OAuth backend. | CONFIRMED (source) | `passportxyz/passport` @ `ac92d160` `platforms/src/Github/` ; `passportxyz/eas-proxy` @ `1311b99b` `deployments/onchainInfo.json` |
| A8-13 | **SIWE (ERC-4361, status `Final`)** proves control of an address to a relying server (off-chain session). It supports contract accounts via ERC-1271 and has an optional `resources` URI list. It does **not** link to GitHub by itself; the server that sees both the OAuth login and the SIWE signature makes the link, and must be trusted. | CONFIRMED (spec) | https://github.com/ethereum/ERCs/blob/master/ERCS/erc-4361.md |
| A8-14 | **npm provenance ties a package version to a GitHub repo + workflow + commit, not to a person.** The attestation bundle at `https://registry.npmjs.org/-/npm/v1/attestations/<pkg>@<ver>` holds a SLSA v1 statement (`predicateType` `https://slsa.dev/provenance/v1`) and an npm publish attestation. Fields seen: `subject[].name` (`pkg:npm/…`) + `sha512`; `buildDefinition.externalParameters.workflow.{repository, path, ref}`; `internalParameters.github.{event_name, repository_id, repository_owner_id}`; `resolvedDependencies[].digest.gitCommit`; `runDetails.metadata.invocationId`. The Sigstore cert SAN is the workflow URI `https://github.com/<org>/<repo>/.github/workflows/<file>@<ref>`, with Fulcio extensions `1.3.6.1.4.1.57264.1.8` Issuer (`https://token.actions.githubusercontent.com`), `.1.9` Build Signer URI, `.1.12` Source Repository URI, `.1.15` Source Repository Identifier, `.1.17` Source Repository Owner Identifier, `.1.18` Build Config URI, `.1.21` Run Invocation URI. | CONFIRMED (live attestation for `sigstore@5.0.0` + Fulcio OID doc) | `[EXP]/provenance/npm-sigstore-5.0.0-*.json` ; https://github.com/sigstore/fulcio/blob/78da569b/docs/oid-info.md |
| A8-15 | Provenance is optional and many packages lack it: `@circle-fin/modular-wallets-core@1.0.16` and `@0xsplits/splits-sdk@6.7.0` have no `dist.attestations`. | CONFIRMED (`npm view`) | this session |
| A8-16 | **PyPI (PEP 740):** `GET https://pypi.org/integrity/<project>/<version>/<filename>/provenance` (Accept `application/vnd.pypi.integrity.v1+json`) returns `attestation_bundles[].publisher` = `{kind: "GitHub", repository: "<owner>/<repo>", workflow: "<file>.yml", environment}`. The simple JSON API exposes a `provenance` URL per file. The publisher is the Trusted Publisher identity (repo + workflow), not a person. | CONFIRMED (live call for `sigstore` 4.5.0 wheel) | `[EXP]/provenance/pypi-sigstore-provenance.json` |

#### Design implications
1. No naming or attestation layer on Arc: Czar can't rely on ENS or EAS on-chain there. Store identity claims in Czar's own registry, or anchor hashes on Arc (A8-01–A8-07).
2. Never call `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e` on Arc mainnet as if it were ENS (A8-01).
3. For "builder owns repo → address", the cheapest trust-minimised path is a `FUNDING.json`-style file on the default branch, verified by Czar's own checker or a signer it controls. Copy Drips' payload shape, not its deployment (A8-08, A8-09).
4. Signed gists and GitHub key endpoints allow keyless verification with no oracle, but they only prove account control, not repo ownership (A8-10, A8-11).
5. Passport GitHub stamps prove activity, not ownership, and aren't on Arc (A8-12).
6. npm and PyPI provenance can prove "this package came from repo X's workflow Y at commit Z". Combine it with a repo-ownership claim to pay the right builder (A8-14–A8-16). Don't require it, since many packages lack it (A8-15).

### A9. Infrastructure on Arc

| # | Fact | Grade | Source (URL or path, version, date) |
|---|---|---|---|
| A9-01 | **Arc docs list 7 data indexers:** Alchemy, Envio, Goldsky, Pinax, The Graph, Thirdweb (Insight) and Zerion. | CONFIRMED (docs) | https://docs.arc.io/arc/tools/data-indexers.md |
| A9-02 | **Goldsky:** "Arc \| 5042 / 5042002 \| M+T \| M+T \| M+T \| M+T". Turbo, Edge RPC, Compose and Subgraphs are supported on mainnet and testnet. Some testnet Turbo datasets lack Fast Scan. | CONFIRMED (docs) | https://docs.goldsky.com/chains/supported-networks |
| A9-03 | **The Graph:** mainnet `arc` is tagged STUDIO / EXTENDED. Testnet `arc-testnet` (`eip155:5042002`) is in Subgraph Studio (dev endpoint 3,000 queries/day). Per the docs, "guaranteed indexing via The Graph Network is not yet available for Arc Testnet". | CONFIRMED (docs) | https://thegraph.com/docs/en/supported-networks/ ; https://thegraph.com/docs/en/supported-networks/arc-testnet/ |
| A9-04 | **Envio HyperIndex:** "Arc \| 5042 \| https://5042.hypersync.xyz" and "Arc Testnet \| 5042002 \| https://5042002.hypersync.xyz" (HyperSync, not RPC-only). | CONFIRMED (docs) | https://docs.envio.dev/docs/HyperIndex/supported-networks |
| A9-05 | **Ponder** (`ponder` `0.18.2`) indexes any EVM chain from config: `createConfig({ chains: { <name>: { id, rpc, ws?, pollingInterval?, ethGetLogsBlockRange? } } })`. `viem` `2.57.7` ships `arc` (5042) and `arcTestnet` (5042002) chain definitions with Multicall3 and explorer `apiUrl`. | CONFIRMED (package types) | `ponder@0.18.2` `dist/types/config/index.d.ts` ; `viem@2.57.7` `chains/definitions/arc.ts`, `arcTestnet.ts` |
| A9-06 | **Public RPC limits:** Arc docs publish no requests-per-second limit. They do publish: `eth_getLogs` "Block range limit: 10,000 blocks" (error `-32012`); a load-balanced primary endpoint can return `-32014` near head ("safely retry"); `rpc.mainnet.arc.io` "accepts anonymous requests with open CORS". | CONFIRMED (docs); GAP (rate limit) | https://docs.arc.io/arc/references/rpc-endpoints.md |
| A9-07 | Other RPCs per the docs: mainnet Alchemy (`arc-mainnet.g.alchemy.com/v2/KEY`), Blockdaemon, dRPC and QuickNode (`rpc.{blockdaemon,drpc,quicknode}.mainnet.arc.io`). Testnet: the same minus Alchemy. Docs list WebSocket at `wss://rpc.{mainnet,testnet}.arc.io`. | CONFIRMED (docs) | same |
| A9-08 | **`rpc.testnet.arc.network` (the Circle CLI hostname in part 1 A3) does not resolve** (empty answer from system and 1.1.1.1 resolvers). `rpc.testnet.arc.io` works. Arc docs list only `rpc.testnet.arc.io`. | CONFIRMED (DNS + cast, 2026-10-18) | `dig rpc.testnet.arc.network` ; `cast chain-id` errors in this session |
| A9-09 | **Both explorers are Blockscout.** Frontend `NEXT_PUBLIC_GIT_TAG: "v2.12.0"` on both; testnet backend `{"backend_version":"v12.0.1"}`. Both have `NEXT_PUBLIC_HAS_USER_OPS: "true"`. | CONFIRMED (frontend config + API) | `https://explorer.{arc.io,testnet.arc.io}/assets/envs.js` → `[EXP]/explorer-*-envs-excerpt.txt` |
| A9-10 | **Testnet explorer API is keyless but rate-limited.** `/api/v2/stats`, `/api/v2/addresses/<a>` and `/api?module=block&action=eth_block_number` returned 200. A later request returned HTTP 429: `"Too many requests. Increase limits now at https://dev.blockscout.com"`. | CONFIRMED (curl) | `[EXP]/explorer-api-probe.txt` |
| A9-11 | **Mainnet `explorer.arc.io/api/...` returns a Cloudflare "Just a moment..." challenge (HTTP 403) to non-browser clients**, with or without browser UA and JSON Accept headers. Keyless server-side use of the mainnet explorer API is blocked. The keyed path is the Blockscout PRO API: `https://api.blockscout.com/5042/...` returns HTTP 402 `"Proceed with API key or make a X402 payment to continue"`. Its `payment-required` header offers `exact` 2000 base units of USDC on `eip155:8453` (Base) or `eip155:42220` (Celo), not Arc. Not paid. | CONFIRMED (curl) | `[EXP]/explorer-api-probe.txt` |
| A9-12 | **Arc Foundry:** repo `circlefin/arc-foundry` (Apache-2.0), latest release `v0.8.0-2` (2026-09-18). Assets: `aarch64-apple-darwin`, `aarch64-unknown-linux-gnu`, `x86_64-unknown-linux-gnu` tarballs plus `.sha256`. The README says it is "**not** installable through `foundryup`" and recommends renaming binaries to `arc-forge`, `arc-cast` and `arc-anvil`. Intel Mac, Windows and musl need a source build (`cargo build --release`). Chisel is "Not yet supported on Arc". | CONFIRMED (GitHub API + README) | `gh api repos/circlefin/arc-foundry/releases` ; README @ main `d497beea` ; https://docs.arc.io/arc/tutorials/install-arc-foundry.md |
| A9-13 | Installed into a temporary directory (sha256 `90e3eefb…db87` matched). `anvil --version` → `anvil Version: 1.7.1-dev`, `Commit SHA: d497beea7096ff2a8e583c8b307941f24a61b06b`. The Arc switch is `-n, --network <NETWORK>` with `[possible values: ethereum, optimism, tempo, arc]`; start with `arc-anvil --network arc`. Fork with `arc-anvil --fork-url $ARC_TESTNET_RPC_URL [--fork-block-number N]`. Replay with `arc-cast run <TX_HASH>`. Project setting `[profile.arc] network = "arc"`. Arc docs warn against `foundry-rs/foundry-toolchain` in CI. | CONFIRMED (ran binary + docs) | `[EXP]/arc-anvil-smoke.txt` ; https://docs.arc.io/arc/tutorials/troubleshoot-with-arc-foundry.md |
| A9-14 | Local `arc-anvil --network arc` reproduces Arc rules. Chain ID defaults to `31337` (not 5042). Dev account native balance is `1e24` (18 decimals) while `USDC.balanceOf` at `0x3600…` is `1e12` (6 decimals), the same balance. A value transfer to `0x0` fails with `Zero address not allowed`. P256 at `0x100` works. | CONFIRMED (local experiment) | `[EXP]/arc-anvil-smoke.txt` |
| A9-15 | Common singletons present on both networks: Multicall3 `0xcA11…CA11`, Arachnid CREATE2 `0x4e59…956C`, Permit2 `0x0000…8BA3` (all listed in Arc docs). Also, not in Arc docs: Safe singleton factory `0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7` and CreateX `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`. | CONFIRMED (eth_getCode, mainnet block `26616061`, testnet block `67853245`) | `[EXP]/address-probe.txt` ; https://docs.arc.io/arc/references/contract-addresses.md |

#### Design implications
1. For Czar's own indexer, Ponder works on Arc (A9-05). Hosted fallbacks are Goldsky and Envio on both networks, and The Graph Studio (A9-02–A9-04).
2. Page `eth_getLogs` in ≤9,999-block chunks (~85 min of chain) and retry `-32014` (A9-06).
3. Don't plan on keyless server-side use of the mainnet explorer API. Use our own indexer or a keyed provider; testnet Blockscout is fine for dev with backoff on 429 (A9-10, A9-11).
4. Replace every `rpc.testnet.arc.network` reference with `rpc.testnet.arc.io` (A9-08).
5. Use `arc-anvil --network arc --chain-id 5042002` (or fork testnet) in tests and CI. Install from the pinned, checksummed release, not `foundryup` or `foundry-toolchain` (A9-12–A9-14).
6. CREATE2 factories (Arachnid, Safe, CreateX) exist on both networks, so Czar contracts can be deployed at the same address on testnet and mainnet (A9-15).

---

## B. Observer surfaces (P1)

#### Sources for B1–B3

- **Date checked:** 2026-10-18 (all sources below)
- **Method:** raw Markdown docs pulled with `curl` (Claude Code: `https://code.claude.com/docs/en/<page>.md`; Cursor: `https://cursor.com/docs/<page>.md`), Codex source cloned at a release tag, Codex docs pages converted from HTML. Local files inspected for **keys only**, never content.

Source tags used in the tables:

| Tag | Source |
|---|---|
| [CC-HOOKS] | https://code.claude.com/docs/en/hooks (Hooks reference) |
| [CC-PLUG] | https://code.claude.com/docs/en/plugins/manifest-reference (same content as `/docs/en/plugins-reference`) |
| [CC-MEM] | https://code.claude.com/docs/en/memory |
| [CC-SET] | https://code.claude.com/docs/en/settings |
| [CC-DIR] | https://code.claude.com/docs/en/claude-directory |
| [CC-MCP] | https://code.claude.com/docs/en/mcp |
| [CC-TOOLS] | https://code.claude.com/docs/en/tools-reference |
| [CC-REL] | https://code.claude.com/docs/en/plugins/relevance |
| [CC-HINT] | https://code.claude.com/docs/en/plugins/cli-hints |
| [CC-MODS] | https://code.claude.com/docs/en/plugins/mods/overview and `/plugins/mods/reference` |
| [CC-LOCAL] | Own inspection of `~/.claude/projects/` on this machine, Claude Code `2.1.302` (keys only) |
| [CX-SRC] | `openai/codex` at tag `rust-v0.163.0`, commit `83086188ae0614bd882818ff1aa23f3194962012` (latest non-prerelease, published 2026-10-15) |
| [CX-HOOKS] | https://developers.openai.com/codex/hooks (redirects to https://learn.chatgpt.com/docs/hooks) |
| [CX-AGENTS] | https://developers.openai.com/codex/guides/agents-md (redirects to https://learn.chatgpt.com/docs/agent-configuration/agents-md) |
| [CX-CFG] | https://developers.openai.com/codex/config-advanced and `/codex/config-reference` (redirect to learn.chatgpt.com/docs/config-file/...) |
| [CX-SKILLS] | https://developers.openai.com/codex/skills |
| [CX-LOCAL] | Own inspection of one file under `~/.codex/sessions/` written by local `codex-cli 0.162.1` (keys only) |
| [CU-HOOKS] | https://cursor.com/docs/hooks |
| [CU-3P] | https://cursor.com/docs/reference/third-party-hooks |
| [CU-RULES] | https://cursor.com/docs/rules |
| [CU-MCP] | https://cursor.com/docs/mcp |
| [CU-PLUG] | https://cursor.com/docs/plugins |
| [CU-EXT] | https://cursor.com/help/customization/extensions |

Grades follow the brief: **CONFIRMED** = official docs, source at a tag, or own inspection read this session. **STRONG/WEAK SIGNAL** = inference or secondary sources. **GAP** = searched, not found.

### B1. Claude Code

**Version.** `claude --version` → `2.1.302 (Claude Code)`. The newest version gate mentioned anywhere in the pages I pulled is `v2.1.299`, so the docs match the installed version.

#### B1a. Hook events (full list)

| # | Fact | Grade | Source |
|---|---|---|---|
| B1-01 | There are **33 hook events**: `SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`, `SessionEnd`. | CONFIRMED | [CC-HOOKS] "Hook lifecycle" table |
| B1-02 | **Common input fields** on every event: `session_id`, `prompt_id` (absent until first user input), `transcript_path`, `cwd`, `scratchpad_dir` (v2.1.257+), `permission_mode` (not on every event), `effort` (object with `level`; tool-use context events only), `hook_event_name`. Inside a subagent or teammate: also `agent_id` and `agent_type`. | CONFIRMED | [CC-HOOKS] "Common input fields" |
| B1-03 | `transcript_path` is written **asynchronously** and may not yet include the latest messages when the hook fires. Docs say to use `last_assistant_message` on `Stop`/`SubagentStop` instead of reading the transcript. | CONFIRMED | [CC-HOOKS] "Common input fields" |
| B1-04 | Event-specific input fields (beyond the common ones): `SessionStart`: `source` (`startup`/`resume`/`clear`/`compact`/`fork`), `model` (optional), `agent_type`, `session_title`, plus on resume `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd`. `Setup`: `trigger` (`init`/`maintenance`). `InstructionsLoaded`: `file_path`, `memory_type` (`User`/`Project`/`Local`/`Managed`), `load_reason` (`session_start`/`nested_traversal`/`path_glob_match`/`include`/`compact`), `globs`, `trigger_file_path`, `parent_file_path`. `UserPromptSubmit`: `prompt`. `UserPromptExpansion`: `expansion_type`, `command_name`, `command_args`, `command_source`, `prompt`. `MessageDisplay`: `turn_id`, `message_id`, `index`, `final`, `delta`. | CONFIRMED | [CC-HOOKS] per-event "input" sections |
| B1-05 | Tool events: `PreToolUse`: `tool_name`, `tool_input`, `tool_use_id`. `PermissionRequest`: `tool_name`, `tool_input`, `permission_suggestions`. `PostToolUse`: `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms`. `PostToolUseFailure`: `tool_name`, `tool_input`, `tool_use_id`, `error`, `is_interrupt`, `duration_ms`. `PostToolBatch`: `tool_calls` array of `{tool_name, tool_input, tool_use_id, tool_response}`. `PermissionDenied`: `tool_name`, `tool_input`, `tool_use_id`, `reason`. | CONFIRMED | [CC-HOOKS] |
| B1-06 | Other events: `Notification`: `message`, `title`, `notification_type`. `SubagentStart`: `agent_id`, `agent_type`. `SubagentStop`: `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `background_tasks`, `session_crons`. `TaskCreated`/`TaskCompleted`: `task_id`, `task_subject`, `task_description`, `teammate_name`, `team_name` (deprecated). `Stop`: `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`. `StopFailure`: `error`, `error_details`, `last_assistant_message`. `TeammateIdle`: `teammate_name`, `team_name`. `ConfigChange`: `source`, `file_path`. `CwdChanged`: `old_cwd`, `new_cwd`. `DirectoryAdded`: `directory`, `source`. `FileChanged`: `file_path`, `event` (`change`/`add`/`unlink`). `WorktreeCreate`: `name`. `WorktreeRemove`: `worktree_path`. `PreCompact`: `trigger`, `custom_instructions`. `PostCompact`: `trigger`, `compact_summary`. `PreModelSwitch`: `from_model`, `to_model`, `requested_model`, `source`, `context_tokens`, `prompt_cache_warm`, `cache_ttl`, `estimated_cache_write_usd`, `pricing`. `SessionEnd`: `reason`. `Elicitation`: `mcp_server_name`, `message`, `mode`, `requested_schema` or `url`. `ElicitationResult`: `mcp_server_name`, `action`, `content`, `mode`. | CONFIRMED | [CC-HOOKS] |
| B1-07 | There is **no** `$CLAUDE_MODEL` env var. Only `SessionStart` may carry `model`; `PreModelSwitch`/`PostModelSwitch` carry `from_model`/`to_model`. | CONFIRMED | [CC-HOOKS] "Common input fields" |

#### B1b. Output, decisions, matchers, timeouts, handler types, locations

| # | Fact | Grade | Source |
|---|---|---|---|
| B1-08 | **Five handler types:** `command`, `http` (POST JSON to `url`), `mcp_tool` (call a tool on a configured MCP server), `prompt` (single-turn model check), `agent` (subagent with tools; "experimental and may change"). | CONFIRMED | [CC-HOOKS] "Hook handler fields" |
| B1-09 | **Common handler fields:** `type`, `if` (one permission-rule pattern, tool events only), `timeout` (seconds), `statusMessage`, `once` (skill frontmatter only). Command: `command`, `args` (exec form, no shell), `async`, `asyncRewake`, `shell` (`bash`/`powershell`). HTTP: `url`, `headers`, `allowedEnvVars`, `onFailure` (`continue`/`block`, v2.1.295+). MCP tool: `server`, `tool`, `input` (supports `${tool_input.file_path}` style substitution). Prompt/agent: `prompt` (`$ARGUMENTS` placeholder), `model`. | CONFIRMED | [CC-HOOKS] |
| B1-10 | **Timeout defaults:** 600 s for `command`/`http`/`mcp_tool`; 30 s for `prompt`; 60 s for `agent`. Lowered to 30 s on `UserPromptSubmit`, `PreModelSwitch`, `PostModelSwitch`; 10 s on `MessageDisplay`. All `SessionEnd` hooks share a **1.5 s budget**, raised to the largest per-hook `timeout` you set, **max 60 s**. No upper limit documented for other events. | CONFIRMED | [CC-HOOKS] "Common fields" |
| B1-11 | A timed-out or crashing hook is **fail-open** by default (the action goes ahead). `onFailure: "block"` (command and http hooks, v2.1.295+) makes it fail-closed. Exit `2` = block on events that can block; other non-zero = non-blocking error. | CONFIRMED | [CC-HOOKS] "Exit code output", "Block the action when a hook fails" |
| B1-12 | **JSON output:** universal fields `continue`, `stopReason`, `suppressOutput` (accepted, **no effect**), `systemMessage`, `terminalSequence`. Top-level `decision: "block"` + `reason` for `UserPromptSubmit`, `UserPromptExpansion`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Stop`, `SubagentStop`, `ConfigChange`, `PreCompact`. `PreToolUse` uses `hookSpecificOutput.permissionDecision` (`allow`/`deny`/`ask`/`defer`), `permissionDecisionReason`, `updatedInput`, `additionalContext`. `PostToolUse` can return `updatedToolOutput`. | CONFIRMED | [CC-HOOKS] "JSON output", "Decision control" |
| B1-13 | `additionalContext`, `systemMessage`, `initialUserMessage` and plain stdout are each **capped at 10,000 characters**; overflow goes to a file in the session directory with a 2,000-char preview. No setting raises it. | CONFIRMED | [CC-HOOKS] "JSON output" |
| B1-14 | Plain stdout on exit 0 becomes context Claude sees **only** for `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `PostModelSwitch`. For other events it goes to the debug log only. | CONFIRMED | [CC-HOOKS] "Exit code 0" |
| B1-15 | **Matcher syntax:** `"*"`, `""` or omitted = all. Only letters/digits/`_`/`-`/space/`,`/`\|` = exact string or list. Any other character = **unanchored JavaScript regex** (`Edit.*` also matches `NotebookEdit`). `FileChanged` and `StopFailure` use a narrower exact-match set. Events with no matcher support: `UserPromptSubmit`, `PostToolBatch`, `Stop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `WorktreeCreate`, `WorktreeRemove`, `MessageDisplay`, `CwdChanged`. | CONFIRMED | [CC-HOOKS] "Matcher patterns" |
| B1-16 | **Config locations:** `~/.claude/settings.json` (user), `.claude/settings.json` (project, shareable), `.claude/settings.local.json` (local), managed policy settings, plugin `hooks/hooks.json`, skill frontmatter (active from invocation to session end), subagent frontmatter (only while that subagent runs). Hooks from all levels **merge**; they do not replace each other. Identical handlers in several settings files run once. | CONFIRMED | [CC-HOOKS] "Hook locations" |
| B1-17 | Settings precedence (highest first): managed (`managed-settings.json`, MDM, or claude.ai console) → `--settings` CLI → `.claude/settings.local.json` → `.claude/settings.json` → `~/.claude/settings.json`. | CONFIRMED | [CC-SET] "Settings precedence" |
| B1-18 | Admins can set `allowManagedHooksOnly` (blocks user, project, local and plugin hooks, except plugins force-enabled by managed `enabledPlugins`). `disableAllHooks` in user/project settings cannot disable managed hooks. HTTP hooks are subject to `allowedHttpHookUrls` and `httpHookAllowedEnvVars`. | CONFIRMED | [CC-HOOKS] "Hook locations" |
| B1-19 | Project-level frontmatter hooks in a **subagent** run only after the workspace trust dialog is accepted (since v2.1.218). Skill frontmatter hooks register on invocation, even in an untrusted `-p` run. | CONFIRMED | [CC-HOOKS] "Hooks in skills and agents" |
| B1-20 | Hook processes have no controlling terminal (`/dev/tty` unavailable). To notify the user, return `systemMessage` or `terminalSequence` (allowlisted OSC 0/1/2/9/99/777 and BEL). | CONFIRMED | [CC-HOOKS] |

#### B1c. What hooks can see: skills, MCP, subagents

| # | Fact | Grade | Source |
|---|---|---|---|
| B1-21 | **Skills are visible through the `Skill` tool.** `Skill` is a listed built-in tool ("Executes a skill within the main conversation"), so `PreToolUse`/`PostToolUse` can match `Skill`. | CONFIRMED | [CC-TOOLS] tool table; [CC-HOOKS] "UserPromptExpansion" |
| B1-22 | **Blind spot:** a user typing `/skillname` directly **bypasses `PreToolUse`**. `UserPromptExpansion` covers that path (matcher = `command_name`; input includes `command_source`, e.g. `plugin`). To see every skill use you need **both** `PreToolUse` on `Skill` and `UserPromptExpansion`. | CONFIRMED | [CC-HOOKS] "UserPromptExpansion" |
| B1-23 | Docs give no input-field table for the `Skill` tool. In local transcripts, `Skill` `tool_use.input` had key `skill`, and its `toolUseResult` had keys `commandName`, `success`. The tool schema exposed to me this session lists `skill` and `args`. | CONFIRMED (own inspection, 2.1.302); docs GAP | [CC-LOCAL] |
| B1-24 | **No dedicated "skill invoked" settings-hook event.** The mods API has `skill.prompt` (fires when a skill's text is expanded; fields `e.skill`, `e.text`, and since v2.1.299 `e.source`, `e.pluginName`, `e.path`, `e.frontmatter`). | CONFIRMED | [CC-MODS] reference "Prompts and what Claude reads" |
| B1-25 | **MCP calls are visible** in `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`. Tool name format `mcp__<server>__<tool>`. Plugin-bundled servers use `mcp__plugin_<plugin-name>_<server-name>__<tool>` (characters outside `A-Za-z0-9_-` become `_`). A matcher of just `mcp__memory` (no `.*`) matches nothing. | CONFIRMED | [CC-HOOKS] "Match MCP tools"; [CC-MCP]; observed `mcp__plugin_telegram_telegram__*` names in this session |
| B1-26 | **Subagents are visible:** `SubagentStart` / `SubagentStop` (matcher = agent type, e.g. `Explore`, `^my-plugin:reviewer$`). Tool calls made **inside** a subagent fire the same `PreToolUse`/`PostToolUse` hooks with `agent_id` and `agent_type` set. `SubagentStop` gives `agent_transcript_path`. | CONFIRMED | [CC-HOOKS] "Hook locations", "SubagentStart", "SubagentStop" |
| B1-27 | The `Agent` tool's `PostToolUse` response carries run stats: `status`, `agentId`, `content`, `resolvedModel`, `modelsUsed`, `totalTokens` (final request only, not whole run), `totalDurationMs`, `totalToolUseCount`, `usage`. | CONFIRMED | [CC-HOOKS] "PreToolUse input" → "Agent" table |
| B1-28 | `EndConversation` tool calls skip both `PreToolUse` and `PostToolUse`. | CONFIRMED | [CC-HOOKS] "Hook lifecycle" |

#### B1d. Transcripts

| # | Fact | Grade | Source |
|---|---|---|---|
| B1-29 | Transcript path: `~/.claude/projects/<project>/<session>.jsonl`. Subagent transcripts: `~/.claude/projects/<project>/<session>/subagents/`. Large tool outputs: `.../<session>/tool-results/`. `<project>` = working dir with every non-alphanumeric character replaced by `-` (e.g. `-Users-zar-Code-ai-on-chain-czar-v0`). | CONFIRMED | [CC-DIR] "Application data"; [CC-LOCAL] |
| B1-30 | Retention: deleted after `cleanupPeriodDays` (default **30**, minimum 1). Transcripts are **plaintext, not encrypted at rest**; anything a tool read (including secrets) lands there. `CLAUDE_CODE_SKIP_PROMPT_HISTORY` or `-p --no-session-persistence` turn writing off. | CONFIRMED | [CC-DIR] |
| B1-31 | Observed JSONL format (one JSON object per line, keys only). Top-level `type` values seen: `user`, `assistant`, `system`, `attachment`, `mode`, `permission-mode`, `ai-title`, `last-prompt`, `api-request`, `api-request-blob`, `api-request-shape`, `atis-latch`. `user`/`assistant` lines carry `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `gitBranch`, `version`, `isSidechain`, `message`; `user` lines also `promptId`, `toolUseResult`, `sourceToolAssistantUUID`. `message.content` blocks: `text`, `thinking`, `tool_use` (`id`, `name`, `input`, `caller`), `tool_result` (`tool_use_id`, `content`, `is_error`), `tool_addition`. | CONFIRMED (own inspection, 2.1.302) | [CC-LOCAL] |
| B1-32 | Subagent transcript files are `agent-<id>.jsonl` plus `agent-<id>.meta.json` (keys `agentType`, `name`, `model`, `permissionMode`, `spawnDepth`, `teamName`, …). Subagent lines carry `agentId` and `isSidechain: true`. | CONFIRMED (own inspection) | [CC-LOCAL] |
| B1-33 | **No official schema for the transcript JSONL** exists in the docs; the format is undocumented and the many internal line types (`api-request-blob`, `atis-latch`) suggest it changes between versions. | STRONG SIGNAL | [CC-DIR] (searched for schema/format/stable; none) + [CC-LOCAL] |

#### B1e. Plugin packaging

| # | Fact | Grade | Source |
|---|---|---|---|
| B1-34 | Manifest at `.claude-plugin/plugin.json`; **optional** (without it, components load from the standard layout). Only `name` is required (kebab-case; no spaces, `@`, `:`). | CONFIRMED | [CC-PLUG] |
| B1-35 | Manifest fields: `$schema`, `name`, `displayName`, `version`, `description`, `author` (`name` + optional `email`, `url`), `homepage`, `repository`, `license`, `keywords`, `metadata`, `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`, `defaultEnabled`, `dependencies`, `settings`, `userConfig`, `types`, `channels`, `skills`, `commands`, `agents`, `hooks`, `mcpServers`, `lspServers`, `outputStyles`, `workflows`, `experimental` (`themes`, `monitors`, `evals`). Unknown top-level keys are stripped with a validate warning. | CONFIRMED | [CC-PLUG] "Fields" |
| B1-36 | Standard layout: `skills/<name>/SKILL.md`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `output-styles/`, `workflows/`, `themes/`, `monitors/monitors.json`, `bin/` (added to Bash `PATH`), `settings.json`. All at plugin root, **not** inside `.claude-plugin/`. A `CLAUDE.md` at plugin root is **not loaded**. | CONFIRMED | [CC-PLUG] "Standard layout" |
| B1-37 | Path variables: `${CLAUDE_PLUGIN_ROOT}` (changes on update; don't write state there), `${CLAUDE_PLUGIN_DATA}` = `~/.claude/plugins/data/<id>/` (survives updates; deleted on last uninstall unless `--keep-data`), `${CLAUDE_PROJECT_DIR}`. Hook commands get all three plus `CLAUDE_PLUGIN_OPTION_<KEY>` in their env. These vars are **not** in the env of Bash-tool commands. | CONFIRMED | [CC-PLUG] "Environment variables" |
| B1-38 | Plugin `hooks/hooks.json` uses the same shape as settings hooks plus optional top-level `description`; plugin hooks merge with user and project hooks. | CONFIRMED | [CC-HOOKS] "Reference scripts by path" |
| B1-39 | `claude plugin validate <dir>` (with `--strict` for CI) is the authoritative manifest check; it also checks `.mcp.json` entries (v2.1.281+). Names starting `claude-`, `anthropic-`, `cc-plugin-` etc. are reserved (error). | CONFIRMED | [CC-PLUG] |
| B1-40 | **Mods** (on by default since v2.1.287) are plugins whose `hooks/hooks.json` has `modules: ["./register.js"]`: in-process JS/TS handlers with events such as `tool.call`, `tool.check`, `prompt.submit`, `skill.prompt`, `turn.start/step/complete`, `session.start/end/append/measure`, `agent.spawn`, `telemetry.log`, and `classic.<Event>` mirrors of every settings-hook event. Limits include 10 s per hook, `$.store` 4 MiB, `$.http.fetch` 4 MiB / 30 s. | CONFIRMED | [CC-MODS] |

#### B1f. CLAUDE.md load order and limits

| # | Fact | Grade | Source |
|---|---|---|---|
| B1-41 | Load order (broad → specific; later = read last): managed policy (`/Library/Application Support/ClaudeCode/CLAUDE.md` on macOS, `/etc/claude-code/CLAUDE.md` Linux, `C:\Program Files\ClaudeCode\CLAUDE.md` Windows) → user `~/.claude/CLAUDE.md` → project `./CLAUDE.md` or `./.claude/CLAUDE.md` → local `./CLAUDE.local.md`. | CONFIRMED | [CC-MEM] "Choose where to put CLAUDE.md files" |
| B1-42 | Files from the working directory **and every parent** load at launch, ordered root → cwd; in each directory `CLAUDE.local.md` comes after `CLAUDE.md`. Subdirectory files load **lazily** when Claude reads/writes a file there. All are concatenated, not overridden. `--add-dir` dirs don't load CLAUDE.md unless `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`. | CONFIRMED | [CC-MEM] "How CLAUDE.md files load" |
| B1-43 | Imports: `@path/to/file`, relative to the importing file, **max depth 4 hops**. Imports outside the working dir in project files need a one-time approval dialog. Imports inside code spans/fences are ignored. Block HTML comments are stripped. | CONFIRMED | [CC-MEM] "Import additional files" |
| B1-44 | Size: a CLAUDE.md up to **4 MiB** loads in full; a larger file is **skipped**. Recommended under 200 lines; a startup warning appears for long files and for a combined total over a limit (combined limit value not stated). Auto-memory `MEMORY.md`: only first **200 lines or 25 KB** load. | CONFIRMED | [CC-MEM] "Storage location", "My CLAUDE.md is too large" |
| B1-45 | `AGENTS.md` (v2.1.277+): read **only when no** `CLAUDE.md`/`.claude/CLAUDE.md`/`CLAUDE.local.md` exists in cwd or above (default `claude-md-or-agents-md`). Configurable via `pluginConfigs."cc-plugin-agents-md@builtin".options.instructionFiles` = `claude-md-or-agents-md` / `claude-md-and-agents-md` / `claude-md` / `managed-only`. `AGENTS.override.md`, `AGENTS.local.md`, `.agents/` are **not** read. | CONFIRMED | [CC-MEM] "AGENTS.md" |
| B1-46 | `InstructionsLoaded` hook fires per instruction file loaded (`memory_type`, `load_reason`), so a hook can audit what instructions entered context. It does **not** fire for an `AGENTS.md` read directly. | CONFIRMED | [CC-HOOKS]; [CC-MEM] "Where AGENTS.md differs" |

#### B1g. Plugin suggestion features

| # | Fact | Grade | Source |
|---|---|---|---|
| B1-47 | **`relevance` block** in a `marketplace.json` plugin entry: `topic` (≤64 chars) and `signals` with `cwd` (≤10 globs), `cli` (≤10 command names, exact match on the **first token** only), `hosts` (≤20 bare hostnames from URLs in Bash commands), `filesRead` (≤10 globs; also matches written/edited files and loaded CLAUDE.md), `manifestDeps` (≤10 `{file, pattern}` regex pairs; manifests >512 KB skipped). | CONFIRMED | [CC-REL] |
| B1-48 | Relevance suggestions show **only** if an admin lists the marketplace in managed `pluginSuggestionMarketplaces` (plus a source in `extraKnownMarketplaces`/`strictKnownMarketplaces` for non-official marketplaces). Matching is local; nothing is reported to Anthropic or the operator. Never auto-installs. | CONFIRMED | [CC-REL] |
| B1-49 | Relevance frequency limits: at most once every 3 sessions; session-start notice stops after 2 shows; Discover-tab pin only the first time. Turned off by `spinnerTipsEnabled: false`. | CONFIRMED | [CC-REL] "Preview what the user sees" |
| B1-50 | **CLI hint:** a CLI writes `<claude-code-hint v="1" type="plugin" value="name@marketplace" />` on its own stderr line when `CLAUDECODE` (or `CLAUDE_CODE_CHILD_SESSION`, v2.1.172+) is set. Works **only for plugins in an official Anthropic marketplace** (e.g. `claude-plugins-official`; **not** `claude-community`). | CONFIRMED | [CC-HINT] |
| B1-51 | CLI hint restrictions: interactive local attended sessions only (not `-p`, subagents, hook output, cloud, Remote Control, teammates); analytics must be on (off with `DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, Bedrock etc.); one prompt per session, one ever per plugin, none after 100 plugins prompted; user can opt out forever; 30 s no answer = No. | CONFIRMED | [CC-HINT] |

#### Design implications

- A Czar observer for Claude Code can be a plugin with `hooks/hooks.json` + `.mcp.json` + skills in one bundle (B1-34..B1-38).
- To log every skill use, hook **both** `PreToolUse` matcher `Skill` and `UserPromptExpansion` (B1-21, B1-22).
- To log MCP payments/tool calls, match `mcp__.*` and also `mcp__plugin_.*` for plugin servers (B1-25).
- Subagent activity needs no extra wiring: tool hooks fire inside subagents with `agent_id` (B1-26); use `SubagentStop.agent_transcript_path` for the full record.
- Use `async: true` command hooks or `http` hooks to a local daemon so logging never slows the agent; never make a logging hook blocking (B1-09, B1-10, B1-11).
- `SessionEnd` has a 1.5 s default budget: flush logs elsewhere, not only at session end (B1-10).
- Do not parse transcripts as a primary data source; the format is undocumented and lags (B1-03, B1-33). Prefer hook payloads.
- Transcripts are plaintext and may contain secrets; Czar must not copy them wholesale (B1-30).
- Relevance suggestions need an org admin, and CLI hints need an official-marketplace listing; neither is a free distribution channel for a new third-party plugin (B1-48, B1-50).
- Mods are a stronger, in-process observer (turn, token, telemetry events) but are code running with full user permissions; treat as a later option (B1-40).

### B2. Codex CLI

Source pinned at `rust-v0.163.0` (commit `83086188ae0614bd882818ff1aa23f3194962012`). Locally installed: `codex-cli 0.162.1`.

| # | Fact | Grade | Source |
|---|---|---|---|
| B2-01 | **Global AGENTS.md:** in Codex home (`~/.codex` or `$CODEX_HOME`), Codex reads `AGENTS.override.md` if non-empty, else `AGENTS.md`. Only the first non-empty one is used. | CONFIRMED | [CX-SRC] `codex-rs/codex-home/src/instructions/mod.rs` `load_from_codex_home`; [CX-AGENTS] |
| B2-02 | **Project AGENTS.md:** Codex finds the project root by walking up from cwd to the first `project_root_markers` entry (default `.git`). It then checks each directory from root **down to cwd** (never past the root). In each directory it takes the **first** existing file among `AGENTS.override.md`, `AGENTS.md`, then any `project_doc_fallback_filenames`. Files are concatenated root-first, so closer files come last. No root found → only cwd is checked. | CONFIRMED | [CX-SRC] `codex-rs/core/src/agents_md.rs` (module doc, `agents_md_paths`, `candidate_filenames`); [CX-AGENTS] |
| B2-03 | **Size limit:** `project_doc_max_bytes`, default `32 * 1024` (32 KiB) (`DEFAULT_PROJECT_DOC_MAX_BYTES`). It is a **combined** budget across project files; the file that crosses it is **truncated** (warning `project doc exceeds remaining budget; truncating`), later files are dropped. Empty files are skipped. | CONFIRMED | [CX-SRC] `codex-rs/config/src/config_toml.rs:75`, `agents_md.rs` `read_agents_md` |
| B2-04 | **Untrusted projects get no project AGENTS.md** (`if config.active_project.is_untrusted()` returns before reading). | CONFIRMED | [CX-SRC] `agents_md.rs` `load_project_instructions` |
| B2-05 | User and project docs are joined with the separator `\n\n--- project-doc ---\n\n`. | CONFIRMED | [CX-SRC] `agents_md.rs` `AGENTS_MD_SEPARATOR` |
| B2-06 | **Hooks exist and are on by default.** Feature key `hooks` (stage `Stable`, `default_enabled: true`); `codex_hooks` is a deprecated alias. Turn off with `[features] hooks = false`. | CONFIRMED | [CX-SRC] `codex-rs/features/src/lib.rs` (`Feature::CodexHooks`, key `"hooks"`); [CX-HOOKS] |
| B2-07 | **12 hook events:** `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`. | CONFIRMED | [CX-SRC] `codex-rs/config/src/hook_config.rs` `HookEventsToml` |
| B2-08 | **Hook locations:** `hooks.json` next to each active config layer, or inline `[hooks]` in `config.toml`. Main ones: `~/.codex/hooks.json`, `~/.codex/config.toml`, `<repo>/.codex/hooks.json`, `<repo>/.codex/config.toml`; plus plugin `hooks/hooks.json` (or `hooks` in `.codex-plugin/plugin.json`) and managed `requirements.toml`. All sources run; higher layers don't replace lower. | CONFIRMED | [CX-SRC] `codex-rs/hooks/src/engine/discovery.rs` `discover_handlers`/`load_hooks_json`; [CX-HOOKS] |
| B2-09 | **Trust gate:** every non-managed hook (including plugin hooks) must be reviewed and trusted in `/hooks`; trust is stored against a hash, so any change re-requires review. `--dangerously-bypass-hook-trust` skips this for one run. Project hooks load only if the project `.codex/` layer is trusted. | CONFIRMED | [CX-HOOKS]; [CX-SRC] `HookStateToml { enabled, trusted_hash }` |
| B2-10 | **Handler types:** `command` (`command`, `commandWindows`/`command_windows`, `timeout`, `async`, `statusMessage`, `additionalContextLimit`) and `mcp_tool` (`server`, `tool`, `input`, `timeout`, `statusMessage`). `prompt` and `agent` are parsed but **skipped** ("not supported yet"). | CONFIRMED | [CX-SRC] `hook_config.rs` `HookHandlerConfig`; `discovery.rs` |
| B2-11 | **Timeouts:** default 600 s; `SessionEnd` and `Interrupt` default 1 s, max 3 s (`SESSION_END_DEFAULT_TIMEOUT_SEC = 1`, `SESSION_END_MAX_TIMEOUT_SEC = 3`). `SessionEnd` always runs synchronously and has no MCP tool hooks. Up to 8 background hooks per session. | CONFIRMED | [CX-SRC] `discovery.rs` `normalize_command_hook`, `hooks/src/events/session_end.rs`; [CX-HOOKS] |
| B2-12 | **Matcher** is a regex string; `"*"`, `""` or omitted = all. Honoured on `PreToolUse`/`PostToolUse`/`PermissionRequest` (tool name), `SessionStart` (source), `SessionEnd` (reason, always `other`), `Pre/PostCompact` (`manual`/`auto`), `SubagentStart/Stop` (agent type). Ignored on `UserPromptSubmit`, `Stop`, `Interrupt`. | CONFIRMED | [CX-HOOKS] "Matcher patterns" |
| B2-13 | **Common input:** `session_id` (subagent hooks use the **parent** session id), `transcript_path` (may be null), `cwd`, `hook_event_name`, `model`; turn events add `turn_id`; most add `permission_mode` (`default`/`acceptEdits`/`plan`/`dontAsk`/`bypassPermissions`). Docs: transcript format "isn't a stable interface for hooks". | CONFIRMED | [CX-HOOKS] "Common input fields"; [CX-SRC] `hooks/schema/generated/*.input.schema.json` |
| B2-14 | Per-event input (from generated schemas): `PreToolUse`: `tool_name`, `tool_input`, `tool_use_id`, `agent_id`, `agent_type`. `PostToolUse`: same + `tool_response`. `PermissionRequest`: `tool_name`, `tool_input`. `UserPromptSubmit`: `prompt`. `SessionStart`: `source`. `SessionEnd`: `reason`. `SubagentStart`: `agent_id`, `agent_type`. `SubagentStop`: `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `stop_hook_active`. `Stop`: `last_assistant_message`, `stop_hook_active`. `Pre/PostCompact`: `trigger`. | CONFIRMED | [CX-SRC] `codex-rs/hooks/schema/generated/` |
| B2-15 | **Output** mirrors Claude Code: `continue`, `stopReason`, `systemMessage`, `suppressOutput` (parsed, not implemented); `PreToolUse` deny via `hookSpecificOutput.permissionDecision: "deny"` or legacy `decision: "block"` or exit 2; rewrite via `permissionDecision: "allow"` + `updatedInput`. `ask` is parsed but **not supported** (hook marked failed, call continues). | CONFIRMED | [CX-HOOKS] "PreToolUse" |
| B2-16 | `additionalContext` over ~2,500 tokens (per handler `additionalContextLimit`) spills to `<temp_dir>/hook_outputs/<session_id>/<uuid>.txt` with a preview. | CONFIRMED | [CX-HOOKS] "Large hook output"; [CX-SRC] `HookHandlerConfig` doc comment |
| B2-17 | **Tool coverage:** `PreToolUse`/`PostToolUse` see shell (`Bash`, incl. `exec_command`), `apply_patch` (matchable as `apply_patch`, `Edit`, `Write`), **MCP tools** (`mcp__<server>__<tool>`), and other local function tools (`update_plan`; `spawn_agent` also matches `Agent`). **Hosted tools such as `WebSearch` are not seen.** Docs: "a useful guardrail, not a complete enforcement boundary". | CONFIRMED | [CX-HOOKS] "Tool coverage" |
| B2-18 | Codex sets `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` (plus its own `PLUGIN_ROOT`, `PLUGIN_DATA`) for plugin hook commands, for compatibility with Claude Code plugin hooks. | CONFIRMED | [CX-HOOKS] "Plugin-bundled hooks" |
| B2-19 | **Skills have no hook event.** Skills are listed by name/description/path in the prompt; Codex then reads `SKILL.md` itself. Explicit use is `$skill-name` in the prompt. So a skill use shows up only indirectly (a file read via a shell tool call, or `$name` in `UserPromptSubmit.prompt`). | STRONG SIGNAL (no skill event in source; mechanism from docs) | [CX-SKILLS]; [CX-SRC] `HookEventsToml` |
| B2-20 | **`notify` (legacy):** `notify = ["python3", "/path/to/notify.py"]` in `config.toml` (`Option<Vec<String>>`). Codex spawns the argv with **one extra final argument**: a JSON string. Only event: `agent-turn-complete`. stdin/stdout/stderr are null; fire-and-forget. Source has `TODO: Remove this hook ... when legacy notify support is removed`. | CONFIRMED | [CX-SRC] `codex-rs/hooks/src/legacy_notify.rs`, `config_toml.rs:247`; [CX-CFG] |
| B2-21 | `notify` payload (exact keys, kebab-case): `{"type":"agent-turn-complete","thread-id":"…","turn-id":"…","cwd":"…","client":"codex-tui" (optional),"input-messages":["…"],"last-assistant-message":"…"}`. | CONFIRMED | [CX-SRC] `legacy_notify.rs` test `expected_notification_json` |
| B2-22 | **MCP client config:** `[mcp_servers.<id>]` in `config.toml`. Raw keys: `command`, `args`, `env`, `env_vars`, `cwd`, `http_headers`, `env_http_headers`, `url`, `bearer_token`, `bearer_token_env_var`, `http_headers_helper`, `environment_id`, `auth`, `startup_timeout_sec`, `startup_timeout_ms`, `tool_timeout_sec`, `enabled`, `required`; resolved config also has `startup_readiness`, `supports_parallel_tool_calls`, `tool_input_schema_max_bytes`, `omit_tools_from`, `default_tools_approval_mode`, `enabled_tools`, `disabled_tools`, `scopes`, `oauth`, `oauth_resource`, per-tool settings. | CONFIRMED | [CX-SRC] `codex-rs/config/src/mcp_types.rs` `RawMcpServerConfig`, `McpServerConfig` |
| B2-23 | **Session logs:** `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread_id>.jsonl`; archived ones under `~/.codex/archived_sessions/`. | CONFIRMED | [CX-SRC] `codex-rs/rollout/src/lib.rs` (`SESSIONS_SUBDIR = "sessions"`, `ARCHIVED_SESSIONS_SUBDIR`), `rollout_file_name.rs`; [CX-LOCAL] path observed |
| B2-24 | Rollout line format: `{timestamp, ordinal?, type, payload, metadata?}`. `type` values (source enum `RolloutItemWire`, snake_case): `session_meta`, `response_item`, `inter_agent_communication`, `inter_agent_communication_metadata`, `compacted`, `turn_context`, `token_usage_record`, `world_state`, `retained_context`, `security_risk_score`, `event_msg`, `realtime_item`. Observed `session_meta` payload keys include `id`, `session_id`, `cwd`, `cli_version`, `originator`, `model_provider`, `git`, `source`; `token_usage_record` has `usage`, `turn_token_usage`, `thread_token_usage`. | CONFIRMED | [CX-SRC] `codex-rs/history/src/rollout_payload.rs`, `history/src/lib.rs` `RolloutLine`; [CX-LOCAL] |

#### Design implications

- Codex hooks use nearly the same JSON contract as Claude Code (same event names, `hookSpecificOutput`, exit 2), so one hook script can serve both with small branching on `hook_event_name`/`turn_id` (B2-07, B2-13, B2-15).
- A Czar Codex hook will **not run until the user trusts it in `/hooks`**, and re-trusts after every change; onboarding must include this step (B2-09).
- Codex `SessionEnd` gets at most 3 s: do not rely on it for upload (B2-11).
- Codex cannot see hosted web search; spend/usage tracking via hooks is partial (B2-17).
- Prefer hooks over `notify`; `notify` is legacy, turn-complete only, and marked for removal (B2-20).
- Token usage per turn is in rollout `token_usage_record` lines; reading rollouts is possible but the format is "not a stable interface" (B2-13, B2-24).
- Keep Czar's own AGENTS.md text short: 32 KiB is shared across all project files and the overflow is cut silently (B2-03).

### B3. Cursor

Cursor is **not installed** on this machine (`/Applications/Cursor.app` absent), so nothing below is tested. All rows are DOCS-level from cursor.com (graded CONFIRMED per brief = official docs read this session).

| # | Fact | Grade | Source |
|---|---|---|---|
| B3-01 | **Cursor has agent hooks today.** Config file `hooks.json` with `{"version": 1, "hooks": {...}}`. | CONFIRMED | [CU-HOOKS] |
| B3-02 | Locations (all run; merge priority high→low): Enterprise `/Library/Application Support/Cursor/hooks.json` (macOS), `/etc/cursor/hooks.json` (Linux/WSL), `C:\ProgramData\Cursor\hooks.json` → Team (dashboard, Enterprise only) → Project `<project-root>/.cursor/hooks.json` (trusted workspaces) → User `~/.cursor/hooks.json`. Plugins can also install hooks. On conflicts `deny` beats `ask` beats `allow`. | CONFIRMED | [CU-HOOKS] "Configuration" |
| B3-03 | **Agent events:** `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse`, `afterAgentThought`. **Tab events:** `beforeTabFileRead`, `afterTabFileEdit`. **App event:** `workspaceOpen` (can return `pluginPaths`). | CONFIRMED | [CU-HOOKS] "Hook categories" |
| B3-04 | **Common input:** `conversation_id`, `generation_id`, `model`, `model_id`, `model_params`, `hook_event_name`, `cursor_version`, `workspace_roots`, `user_email`, `transcript_path` (null if transcripts disabled). | CONFIRMED | [CU-HOOKS] "Common schema" |
| B3-05 | Per-script options: `command`, `type` (`command`/`prompt`), `timeout` (seconds; default "platform default"), `loop_limit` (default 5 for Cursor hooks), `failClosed` (default `false`), `matcher` (regex). Exit 0 = use JSON; exit 2 = deny; other = fail-open. Permission hooks block on invalid JSON even without `failClosed`. | CONFIRMED | [CU-HOOKS] "Per-Script Configuration Options" |
| B3-06 | Key payloads: `preToolUse` `tool_name`, `tool_input`, `tool_use_id`, `cwd` → returns `permission` (`allow`/`deny`; `ask` not enforced), `user_message`, `agent_message`, `updated_input`. `postToolUse` adds `tool_output` (JSON string), `duration`. `beforeMCPExecution`/`afterMCPExecution`: `tool_name`, `tool_input` (string), `mcp_server_name` (key in `mcp.json`), `mcp_server_url` or `command`, and after: `result_json`, `duration`. `afterShellExecution`: `command`, `output`, `duration`, `sandbox`. | CONFIRMED | [CU-HOOKS] "Hook events" |
| B3-07 | Subagents: `subagentStart` (`subagent_id`, `subagent_type`, `task`, `parent_conversation_id`, `tool_call_id`, `subagent_model`, `is_parallel_worker`, `git_branch`) can allow/deny; `subagentStop` (`status`, `summary`, `duration_ms`, `message_count`, `tool_call_count`, `modified_files`, `agent_transcript_path`). Tool matcher for MCP in `preToolUse` uses `MCP:<tool_name>`. | CONFIRMED | [CU-HOOKS] |
| B3-08 | `sessionStart` input `session_id` (= `conversation_id`), `is_background_agent`, `composer_mode`; can return `env` and `additional_context`. `sessionEnd`: `reason` (`completed`/`aborted`/`error`/`window_close`/`user_close`), `duration_ms`, `final_status`. `afterAgentResponse`: `text`. `afterAgentThought`: `text`, `duration_ms`. | CONFIRMED | [CU-HOOKS] |
| B3-09 | Hook env vars: `CURSOR_PROJECT_DIR`, `CURSOR_VERSION`, `CURSOR_USER_EMAIL`, `CURSOR_TRANSCRIPT_PATH`, `CURSOR_CODE_REMOTE`, `CLAUDE_PROJECT_DIR` (alias). | CONFIRMED | [CU-HOOKS] "Environment Variables" |
| B3-10 | **Cursor runs Claude Code hooks too**, from `.claude/settings.local.json`, `.claude/settings.json`, `~/.claude/settings.json`, when "Include Third-Party Plugins, Skills, and Other Configs" is on — **on by default**. Mapped names: `PreToolUse`→`preToolUse`, `PostToolUse`→`postToolUse`, `UserPromptSubmit`→`beforeSubmitPrompt`, `Stop`→`stop`, `SubagentStop`→`subagentStop`, `SessionStart`→`sessionStart`, `SessionEnd`→`sessionEnd`, `PreCompact`→`preCompact`. Claude-style `hookSpecificOutput` responses are accepted. | CONFIRMED | [CU-3P] |
| B3-11 | **Rules:** project rules are `.mdc` files in `.cursor/rules/` (subfolders allowed); plain `.md` there is **ignored**. Frontmatter fields: `description`, `globs`, `alwaysApply`. Four modes: Always Apply, Apply Intelligently (description), Apply to Specific Files (globs), Apply Manually (`@rule`). Also User Rules (settings UI), Team Rules (dashboard). Guidance: keep rules under 500 lines (no hard limit stated). | CONFIRMED | [CU-RULES] |
| B3-12 | **AGENTS.md** supported in project root **and subdirectories** (nested files combine with parents; more specific wins). | CONFIRMED | [CU-RULES] "AGENTS.md" |
| B3-13 | **MCP config:** `.cursor/mcp.json` (project) and `~/.cursor/mcp.json` (global), top key `mcpServers`. Stdio fields `type`, `command`, `args`, `env`, `envFile`; remote uses `url` (+ `headers`, static OAuth). Interpolation: `${env:NAME}`, `${userHome}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${pathSeparator}`/`${/}`. | CONFIRMED | [CU-MCP] |
| B3-14 | The **only documented Cursor-specific extension API** is `vscode.cursor.mcp.registerServer()` (programmatic MCP registration). | CONFIRMED | [CU-MCP] "Extension API reference" |
| B3-15 | **No documented extension API to observe agent activity.** The supported observation route is hooks (separate processes). An extension could install hooks and receive their output over a file or local socket. | GAP (searched) / STRONG SIGNAL for the workaround | [CU-MCP], [CU-EXT], cursor.com/llms.txt; WebSearch below |
| B3-16 | Cursor plugins: `.cursor-plugin/plugin.json` bundles rules, skills, agents, commands, MCP servers, hooks; Cursor also loads "Agent Plugins" standard plugins (`plugin.json` at root, skills + MCP only). | CONFIRMED | [CU-PLUG] |
| B3-17 | Extensions come from Open VSX via Cursor's proxy `marketplace.cursorapi.com`; enterprises can allowlist extensions, require signatures, set install cooldowns. | CONFIRMED | [CU-EXT] |

#### Design implications

- A Czar Claude Code hook placed in `~/.claude/settings.json` will **also fire inside Cursor** by default, with Cursor's payload shape (`conversation_id`, no `session_id` on most events). Czar hook scripts must detect the host (e.g. `cursor_version` field or `CURSOR_VERSION` env) and not assume Claude Code fields (B3-04, B3-09, B3-10).
- Cursor has dedicated `beforeMCPExecution`/`afterMCPExecution` with `mcp_server_name` and `result_json`, the cleanest place to see paid MCP/x402 calls in Cursor (B3-06).
- Cursor hook input includes `user_email`; Czar must treat it as personal data and not upload it by default (B3-04).
- Do not plan a VS Code extension as the Cursor observer; plan a native `~/.cursor/hooks.json` (or Cursor plugin) feeding the local daemon (B3-15, B3-16).
- For instructions, ship an `AGENTS.md` snippet (read by Codex, Cursor, and Claude Code under conditions) plus a `.mdc` rule for Cursor (B1-45, B2-02, B3-11, B3-12).

#### Sources for B4–B6 and C

- All facts checked 2026-10-18 unless noted.
- Repos read at: Hermes `NousResearch/hermes-agent@9e01b44dd23978f9ff40b7837467f3a9f1582130` (2026-10-18), OpenClaw `openclaw/openclaw@ca5ac6f5b69aa8704b653fade36e2fa59937c7fb` (2026-10-18).
- Local macOS used for man pages: macOS 26.3.1 (build 25D771280a).

### B4. Chrome extension (Manifest V3)

#### Permissions and what they expose

| # | Fact | Grade | Source (URL or path, version, date) |
|---|---|---|---|
| B4-01 | `Tab.url`, `Tab.title` (and `pendingUrl`, `favIconUrl`) are "only present if the extension has the "tabs" permission or has host permissions for the page." | CONFIRMED | https://developer.chrome.com/docs/extensions/reference/api/tabs (last updated 2026-09-24) |
| B4-02 | Most of `chrome.tabs` needs **no** permission ("Most features don't require any permissions to use"). The `"tabs"` permission only unlocks the four sensitive fields (incl. for `tabs.query()`). | CONFIRMED | same page |
| B4-03 | Install warnings: `"tabs"` → "Read your browsing history"; `"history"` → "Read and change your browsing history on all signed-in devices"; `"webNavigation"` → "Read your browsing history"; `"nativeMessaging"` → "Communicate with cooperating native applications"; `"scripting"`, `"activeTab"`, `"storage"` → no warning listed. | CONFIRMED | https://developer.chrome.com/docs/extensions/reference/permissions-list (last updated 2026-09-09) |
| B4-04 | `chrome.history` (permission `"history"`): `search`, `getVisits`, `addUrl`, `deleteUrl`, `deleteRange`, `deleteAll`; events `onVisited` (fires before the page has loaded), `onVisitRemoved`. `HistoryItem` = `id`, `lastVisitTime`, `title`, `typedCount`, `url`, `visitCount`. `VisitItem` = `id`, `isLocal`, `referringVisitId`, `transition`, `visitId`, `visitTime`. `search` `maxResults` defaults to 100; `startTime` defaults to 24 hours ago. | CONFIRMED | https://developer.chrome.com/docs/extensions/reference/api/history (last updated 2026-09-11) |
| B4-05 | `chrome.webNavigation` (permission `"webNavigation"`) events: `onBeforeNavigate`, `onCommitted`, `onCompleted`, `onCreatedNavigationTarget`, `onDOMContentLoaded`, `onErrorOccurred`, `onHistoryStateUpdated`, `onReferenceFragmentUpdated`, `onTabReplaced`. `onCommitted` gives `tabId`, `frameId` (0 = main frame), `url`, `transitionType`, `transitionQualifiers`, `timeStamp`. Page does not say a host permission is needed. | CONFIRMED | https://developer.chrome.com/docs/extensions/reference/api/webNavigation (last updated 2026-10-04) |
| B4-06 | `chrome.scripting` needs `"scripting"` **plus** host permissions or `"activeTab"`. Methods: `executeScript`, `insertCSS`, `removeCSS`, `registerContentScripts`, `getRegisteredContentScripts`, `updateContentScripts`, `unregisterContentScripts`. Worlds: `ISOLATED` (default) and `MAIN` (shares page JS). | CONFIRMED | https://developer.chrome.com/docs/extensions/reference/api/scripting (last updated 2026-09-11) |
| B4-07 | `activeTab` gives temporary access to the current tab only after a user gesture (action click, context menu, `commands` shortcut, omnibox suggestion). Access "lasts while the user is on that page". No install warning. | CONFIRMED | https://developer.chrome.com/docs/extensions/develop/concepts/activeTab (last updated 2012-09-21 — old page) |
| B4-08 | `host_permissions` are match patterns; `optional_permissions` / `optional_host_permissions` are "Granted by the user at runtime, instead of at install time." Docs recommend optional permissions where possible. | CONFIRMED | https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions (last updated 2024-02-05) |
| B4-09 | Adding a warning-triggering permission in an update: "the extension will be disabled until the user accepts the new permission." | CONFIRMED | https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings (last updated 2024-02-05) |
| B4-10 | Exact install-warning text for broad host permissions (`<all_urls>`, `*://*/*`) | GAP | not on the three pages above; see GAPs |

#### Chrome Web Store policies

| # | Fact | Grade | Source |
|---|---|---|---|
| B4-11 | Limited Use: "Collection and use of web browsing activity is prohibited, except to the extent required for a user-facing feature" … "described prominently in the Product's Chrome Web Store page and in the Product's user interface." | CONFIRMED | https://developer.chrome.com/docs/webstore/program-policies/policies (last updated 2025-05-22); same text at …/limited-use (2022-11-01) |
| B4-12 | Limited Use: "Extensions may only collect, use, or transmit user data that is necessary for the extension's disclosed single purpose". Transfers to third parties allowed only if necessary for the single purpose, to comply with law, to protect against malware/spam/phishing/fraud/abuse, or in a merger/acquisition with prior consent. "All other transfers, uses, or sale of user data is completely prohibited", incl. personalized ads, data brokers, creditworthiness/lending. Humans may read user data only with explicit consent, for aggregated anonymized ops, security, or law. | CONFIRMED | https://developer.chrome.com/docs/webstore/program-policies/limited-use (last updated 2022-11-01) |
| B4-13 | Developers must publicly state compliance with Limited Use (e.g. on the website or privacy policy linked from the listing). | CONFIRMED | same |
| B4-14 | Disclosure: "If your Product handles any user data, then prior to installation, it must:" prominently disclose what is collected and how it is used, and "Obtain the user's affirmative and informed consent for such use." New data practices after install must be prominently disclosed. | CONFIRMED | https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements (last updated 2022-11-01) |
| B4-15 | User Data FAQ: "The prominent disclosure and consent must occur within the Product's user interface." and "The disclosure, however, must not be located only in a privacy policy, terms of service, or similar document." | CONFIRMED | https://developer.chrome.com/docs/webstore/program-policies/user-data-faq (page shows "Last updated 2016-04-23", text references 2019 enforcement — date stamp unreliable) |
| B4-16 | FAQ: "an extension can only collect and transmit web browsing activity to the extent required for a user-facing feature"; "Data collection for unrelated advertising, profiling, or generalized market research purposes is not considered necessary." | CONFIRMED | same FAQ |
| B4-17 | Products that handle user data must post a privacy policy in the Developer Dashboard. | CONFIRMED | same FAQ |
| B4-18 | Use of Permissions: "Request access to the narrowest permissions necessary to implement your Product's features or services." "If more than one permission could be used to implement a feature, you must request those with the least access to data or functionality." "Don't attempt to "future proof" your Product by requesting a permission that might benefit services or features that have not yet been implemented." | CONFIRMED | https://developer.chrome.com/docs/webstore/program-policies/permissions (last updated 2022-11-01) |

#### Native messaging

| # | Fact | Grade | Source |
|---|---|---|---|
| B4-19 | Extension needs the `"nativeMessaging"` permission. | CONFIRMED | https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging (last updated 2026-09-16) |
| B4-20 | Host manifest fields: `name` (lowercase alphanumerics, `_` and `.`; no leading/trailing dot, no `..`), `description`, `path` (absolute on macOS/Linux), `type` (only `stdio`), `allowed_origins` ("can't contain wildcards"). | CONFIRMED | same |
| B4-21 | macOS manifest locations — Chrome system: `/Library/Google/Chrome/NativeMessagingHosts/<name>.json`; Chromium system: `/Library/Application Support/Chromium/NativeMessagingHosts/<name>.json`; Chrome user: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/<name>.json`; Chromium user: `~/Library/Application Support/Chromium/NativeMessagingHosts/<name>.json`. | CONFIRMED | same |
| B4-22 | Framing: JSON, UTF-8, "preceded with 32-bit message length in native byte order." | CONFIRMED | same |
| B4-23 | Size limits: host → Chrome "1 MB"; Chrome → host "64 MiB". | CONFIRMED | same |
| B4-24 | `runtime.connectNative()` keeps the host process running "until the port is destroyed"; `runtime.sendNativeMessage()` — "Chrome starts a new native messaging host process for each message." | CONFIRMED | same |

#### Design implications
- Use `webNavigation` + `tabs` for URL/title events, not `history` — `history` carries the scarier "read and change … on all signed-in devices" warning (B4-03, B4-05).
- `activeTab` + `scripting` reads a page only on user click with no warning; any always-on page content capture needs host permissions (B4-06, B4-07).
- Put broad capture behind `optional_host_permissions` so install warnings stay small and later adds don't disable the extension (B4-08, B4-09).
- Czar must show an in-extension consent screen before collecting browsing activity; a privacy policy alone fails review (B4-14, B4-15).
- Sending browsing data to sellers/agents is a "transfer"; it must be necessary for the disclosed single purpose — scope Czar's listing purpose to cover it, and never use it for ads (B4-11, B4-12).
- Use `connectNative` (one long-lived port) to the Czar daemon; chunk daemon→extension messages under 1 MB (B4-23, B4-24).
- Ship both user-level Chrome and Chromium manifest paths in the installer; `allowed_origins` must list the exact extension ID (B4-20, B4-21).

### B5. `SOUL.md` in Hermes Agent and OpenClaw

#### Hermes Agent (`NousResearch/hermes-agent@9e01b44`)

| # | Fact | Grade | Source |
|---|---|---|---|
| B5-01 | File name `SOUL.md`, global per instance: `~/.hermes/SOUL.md`, or `$HERMES_HOME/SOUL.md`. Windows default home `%LOCALAPPDATA%\hermes`. | CONFIRMED | `website/docs/guides/use-soul-with-hermes.md`; `hermes_constants.py:51-58` (`_platform_default_hermes_home`) |
| B5-02 | `SOUL.md` is the agent identity, "slot #1 in the system prompt"; it replaces the built-in `DEFAULT_AGENT_IDENTITY`. Missing/empty → default identity. Seeded on first run if absent; never overwritten. | CONFIRMED | `agent/system_prompt.py:550-556` (`_identity_parts`); `agent/prompt_builder.py:1541` (`load_soul_md`); guide above |
| B5-03 | Project context is separate: only ONE type loads, first found wins: `.hermes.md`/`HERMES.md` (walk to git root) → `AGENTS.md` chain (git root → cwd; per dir first non-empty of `AGENTS.override.md`, `AGENTS.md`, `agents.md`) → `CLAUDE.md` (cwd) → `.cursorrules` + `.cursor/rules/*.mdc`. `SOUL.md` is never read from the project dir. | CONFIRMED | `agent/prompt_builder.py:1749-1779` (`build_context_files_prompt` docstring + code), `_agents_md_candidates` |
| B5-04 | Prompt order: stable tier (identity = SOUL.md, guidance, skills pins) → context tier (system message, project context files) → volatile tier (skills index, memory, user profile, timestamp, runtime env). | CONFIRMED | `agent/system_prompt.py:736-800` (`build_system_prompt_parts`) |
| B5-05 | Size limit per context file (incl. SOUL.md): `CONTEXT_FILE_MAX_CHARS = 20_000` floor; dynamic cap = 6% of model window (chars), ceiling 500,000; config key `context_file_max_chars` overrides. Over limit → keep 70% head + 20% tail with a truncation marker. | CONFIRMED | `agent/prompt_builder.py:1044-1066`, `_truncate_content` |
| B5-06 | SOUL.md is scanned for prompt-injection patterns; a hit only warns for a user-authored file, but BLOCKS if the file was installed by a profile distribution (`distribution.yaml` owns it). | CONFIRMED | `agent/prompt_builder.py` `load_soul_md` (manifest / `user_authored` branch) |
| B5-07 | Related files: `MEMORY.md` (agent notes) and `USER.md` (user profile) under `$HERMES_HOME/memories`; default limits `memory_char_limit` 2200 and `user_char_limit` 1375 chars. | CONFIRMED | `tools/memory_tool.py:2,39-40,56` |
| B5-08 | Hermes ships an OpenClaw migration that copies `workspace/SOUL.md` → Hermes `SOUL.md`. | CONFIRMED | `optional-skills/migration/openclaw-migration/scripts/openclaw_to_hermes.py:1280-1285` |

#### OpenClaw (`openclaw/openclaw@ca5ac6f`)

| # | Fact | Grade | Source |
|---|---|---|---|
| B5-09 | Files live in the agent workspace: default `~/.openclaw/workspace` (`OPENCLAW_WORKSPACE_DIR` or `agents.defaults.workspace` override; named profile `~/.openclaw-<profile>/workspace`). | CONFIRMED | `docs/gateway/config-agents/workspace-and-bootstrap.md` |
| B5-10 | Bootstrap files in prompt order: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md` (brand-new workspaces only), `MEMORY.md` (when present). | CONFIRMED | `src/agents/workspace-bootstrap-policy.ts:10-36` (`WORKSPACE_BOOTSTRAP_FILENAMES`, "Canonical bootstrap filenames in prompt order"); `docs/concepts/system-prompt.md:164-175` |
| B5-11 | When a session runs in another folder, that folder's `AGENTS.md` is appended as project context; `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, `BOOTSTRAP.md` are NOT loaded from it. | CONFIRMED | `docs/concepts/system-prompt.md:166` |
| B5-12 | Limits: per file `agents.defaults.bootstrapMaxChars` = 20000; total `agents.defaults.bootstrapTotalMaxChars` = 60000; `USER_BOOTSTRAP_MAX_CHARS = 4_000`. Truncation adds a fixed notice. | CONFIRMED | `docs/concepts/system-prompt.md:189-194`; `src/agents/embedded-agent-helpers/bootstrap.ts:86-90` |
| B5-13 | Sub-agent sessions inject only `AGENTS.md`. | CONFIRMED | `docs/concepts/system-prompt.md:198` |
| B5-14 | Hook event `agent:bootstrap` can mutate/replace injected bootstrap files (e.g. swap `SOUL.md`). | CONFIRMED (docs) | `docs/concepts/system-prompt.md:200` |
| B5-15 | Config: `agents.defaults.skipBootstrap` (stop auto-creating files), `agents.defaults.skipOptionalBootstrapFiles` (`SOUL.md`, `USER.md`, `IDENTITY.md`), `agents.defaults.contextInjection` (`"always"` default, `"continuation-skip"`, `"never"`). `HEARTBEAT.md` is accepted but a no-op. `TOOLS.md` is still a defined constant but not in the bootstrap list. | CONFIRMED | `docs/gateway/config-agents/workspace-and-bootstrap.md`; `workspace-bootstrap-policy.ts:12` |
| B5-16 | `memory/*.md` daily files are not injected; read on demand via `memory_search` / `memory_get`. | CONFIRMED (docs) | `docs/concepts/system-prompt.md:184` |

#### Design implications
- No shared standard: Hermes keeps one global `SOUL.md` in `~/.hermes/`; OpenClaw keeps it in the workspace next to `AGENTS.md`. A Czar export must target each path separately (B5-01, B5-09).
- Keep any exported work soul under 20,000 chars — both tools truncate there by default; OpenClaw also caps `USER.md` at 4,000 (B5-05, B5-12).
- Hermes blocks distribution-installed SOUL.md on injection-scanner hits — Czar-written souls must avoid quoted attack phrases (B5-06).
- OpenClaw sub-agents don't see `SOUL.md` — put rules that sub-agents must follow in `AGENTS.md` (B5-13).
- Watching file changes in `~/.hermes/` and `~/.openclaw/workspace/` is a cheap observer for these harnesses (B5-01, B5-09).

### B6. Local daemon and encrypted storage

#### Background service

| # | Fact | Grade | Source |
|---|---|---|---|
| B6-01 | Per-user agents go in `~/Library/LaunchAgents` (user) or `/Library/LaunchAgents` (admin); daemons in `/Library/LaunchDaemons`. | CONFIRMED | `man launchd.plist` FILES, macOS 26.3.1 |
| B6-02 | Plist keys: `Label` (required), `Program` or `ProgramArguments` (one required), `RunAtLoad` (default false; "should be avoided"), `KeepAlive` (bool or dict; implies `RunAtLoad`), `ThrottleInterval` (default: not spawned more than once every 10 s), `ProcessType` (`Background`, `Standard`, …; unset = light limits), `StandardOutPath`, `StandardErrorPath`, `EnvironmentVariables`, `WorkingDirectory`, `MachServices`, `Sockets`, `LimitLoadToSessionType`. `BundleProgram` is "only supported for plists that are installed using SMAppService." | CONFIRMED | `man launchd.plist`, macOS 26.3.1 |
| B6-03 | `launchctl bootstrap | bootout domain-target [service-path …]` loads/removes services; `gui/<uid>/[service-name]` targets the user's GUI domain; `enable | disable` persists across boots; `kickstart [-kp]` runs now (`-k` kills first). `load | unload` are legacy: "Recommended alternative subcommands: bootstrap | bootout | enable | disable". | CONFIRMED | `man launchctl`, macOS 26.3.1 |
| B6-04 | `SMAppService` (macOS 13.0+): `agent(plistName:)`, `daemon(plistName:)`, `loginItem(identifier:)`, `mainApp`; `register()`, `unregister()`, `status`, `openSystemSettingsLoginItems()`. It replaces installing plists in `~/Library/LaunchAgents`. | CONFIRMED | https://developer.apple.com/documentation/servicemanagement/smappservice (JSON endpoint read 2026-10-18) |
| B6-05 | Agent plist "must correspond to a property list in the calling app's `Contents/Library/LaunchAgents` directory." | CONFIRMED | https://developer.apple.com/documentation/servicemanagement/smappservice/agent(plistname:) |
| B6-06 | `SMAppService.Status`: `notRegistered`, `enabled`, `requiresApproval` (user must act in System Settings), `notFound`. | CONFIRMED | https://developer.apple.com/documentation/servicemanagement/smappservice/status-swift.enum |
| B6-07 | systemd user units: user config path `~/.config/systemd/user` (`$XDG_CONFIG_HOME/systemd/user`); also `/etc/systemd/user`, `/usr/lib/systemd/user` and others. | CONFIRMED | https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html (systemd 262) |
| B6-08 | `loginctl enable-linger`: "a user manager is spawned for the user at boot and kept around after logouts." | CONFIRMED | https://www.freedesktop.org/software/systemd/man/latest/loginctl.html (systemd 262) |
| B6-09 | Windows Task Scheduler can start a task "When a user logs on" (also at boot, idle, etc.); Task Scheduler 2.0 needs Vista+. | CONFIRMED | https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-start-page (ms.date 2024-07-15) |

#### Encrypted storage and keychain

| # | Fact | Grade | Source |
|---|---|---|---|
| B6-10 | SQLCipher latest release `v4.19.0` (2026-09-08), BSD-3-Clause (Community Edition); 256-bit AES, HMAC, PBKDF2 key derivation; raw 64-hex-char key option. Commercial/Enterprise/FIPS editions exist. | CONFIRMED | `gh api repos/sqlcipher/sqlcipher` + README; https://www.zetetic.net/sqlcipher/open-source/ |
| B6-11 | SQLite3 Multiple Ciphers latest `v2.6.1` (2026-10-12), MIT. Ciphers: wxSQLite3 AES-128/256, sqleet ChaCha20-Poly1305, SQLCipher AES-256, System.Data.SQLite RC4, Ascon-128 v1.2, AEGIS family. | CONFIRMED | `gh api repos/utelle/SQLite3MultipleCiphers`; https://utelle.github.io/SQLite3MultipleCiphers/docs/ciphers/cipher_overview/ |
| B6-12 | npm `better-sqlite3-multiple-ciphers` `13.0.3` (MIT), bundles better-sqlite3 13.0.3, SQLite 3.53.4, SQLite3MC **2.4.0** (behind upstream 2.6.1); prebuilt binaries; README: "authored and maintained by a sole developer". Beta `13.0.4-beta.0`. | CONFIRMED | `npm view`; repo README + release notes v13.0.3 |
| B6-13 | npm `@journeyapps/sqlcipher` `6.0.0` (BSD-3-Clause, 2026-04-29): fork of node-sqlite3, bundles SQLCipher 4.14.0; macOS and Linux only; no prebuilt binaries ("Windows and prebuilt binary publishing are intentionally unsupported in this phase"). | CONFIRMED | `npm view`; https://github.com/journeyapps/node-sqlcipher README |
| B6-14 | npm `@signalapp/sqlcipher` `4.1.0` is **AGPL-3.0-only**. | CONFIRMED | `npm view` |
| B6-15 | Python: `sqlcipher3` `0.6.4` (2026-10-13, repo `coleifer/sqlcipher3`, Zlib licence); `sqlcipher3-binary` `0.6.0` (2025-12-31). | CONFIRMED | PyPI JSON API; `gh api repos/coleifer/sqlcipher3` |
| B6-16 | `keytar` (`atom/node-keytar`) repo is **archived**; last release `v7.9.0` (2022-02-17). | CONFIRMED | `gh api repos/atom/node-keytar` (`archived: true`) |
| B6-17 | `@napi-rs/keyring` `2.1.1` (MIT, 2026-10-10): Node binding of Rust `keyring-rs`; API `new Entry(service, name)`, `setPassword`, `getPassword`, `deletePassword`, `AsyncEntry`; Linux tries Secret Service, then silently falls back to kernel keyutils unless pinned. | CONFIRMED | `npm view`; repo README |
| B6-18 | Python `keyring` `25.7.0` (MIT): backends macOS Keychain, Freedesktop Secret Service, KWallet, Windows Credential Locker. | CONFIRMED | PyPI; `jaraco/keyring` README |
| B6-19 | macOS CLI: `security add-generic-password -a <account> -s <service> -w` (put `-w` last "to be prompted (recommended)"); `find-generic-password … -w` prints password only; `-T appPath` restricts access; `-A` "insecure, not recommended!". | CONFIRMED | `man security`, macOS 26.3.1 |
| B6-20 | Windows Service (SCM) as an alternative to Task Scheduler | GAP | not searched |

#### Design implications
- macOS: ship the daemon inside the app bundle and register with `SMAppService.agent(plistName:)`; handle `requiresApproval` by calling `openSystemSettingsLoginItems()` (B6-04..06).
- CLI-only install: write `~/Library/LaunchAgents/<Label>.plist`, then `launchctl bootstrap gui/$UID <plist>`; avoid `load` (B6-03).
- Use `KeepAlive` + `ProcessType=Background`; mind the 10 s throttle on crash loops (B6-02).
- Linux: user unit + `enable-linger` if it must run without a login session (B6-07, B6-08).
- Node encrypted DB: `better-sqlite3-multiple-ciphers` is the only option with prebuilds on all three OSes; note single maintainer and lagging SQLite3MC version (B6-12, B6-13).
- Avoid `@signalapp/sqlcipher` unless AGPL is acceptable (B6-14).
- Don't use `keytar` (archived); use `@napi-rs/keyring` and pin the Linux store to Secret Service so keys never land in a weaker store silently (B6-16, B6-17).
- Never pass a key with `security … -w <secret>` on the command line (B6-19).

---

## C. Intelligence components (P2)

### C1. Embeddings and vector storage

| # | Fact | Grade | Source |
|---|---|---|---|
| C1-01 | OpenAI `text-embedding-3-small` $0.02 / 1M tokens, default 1536 dims; `text-embedding-3-large` $0.13 / 1M, 3072 dims; `text-embedding-ada-002` $0.10. `dimensions` param shortens vectors. Max input 8192 tokens. No newer embedding model listed; no batch price on page. | CONFIRMED | https://developers.openai.com/api/docs/pricing ; https://developers.openai.com/api/docs/guides/embeddings |
| C1-02 | Voyage `voyage-4-large` $0.12, `voyage-4` $0.06, `voyage-4-lite` $0.02, `voyage-code-4` $0.12, `voyage-context-4` $0.12 per 1M; 200M free tokens on voyage-4 family; Batch API 33% off. | CONFIRMED | https://docs.voyageai.com/docs/pricing |
| C1-03 | voyage-4 family: 32,000-token context, default 1024 dims, options 256/512/1024/2048; `float`, `int8`, `uint8`, `binary`, `ubinary` outputs. | CONFIRMED | https://docs.voyageai.com/docs/embeddings |
| C1-04 | Open-weight `voyageai/voyage-4-nano`: Apache-2.0 on Hugging Face (32k context, 1024 default). | CONFIRMED | HF API `voyageai/voyage-4-nano` sha `433ece5e27a1`; Voyage docs |
| C1-05 | Cohere `embed-v4.0`: dims 256/512/1024/1536 (default 1536), 128k context, text+images. Newer `embed-v5.0-pro` and `embed-v5.0-fast`: dims 256–2048 (default 2048), 128k context. | CONFIRMED | https://docs.cohere.com/docs/cohere-embed |
| C1-06 | Cohere per-token price for embed models | GAP | cohere.com/pricing shows only Model Vault per-instance rates |
| C1-07 | Google `gemini-embedding-2`: $0.20 / 1M text tokens standard, $0.10 batch, free tier for text on standard. Text/image/video/audio/PDF input, 8,192 tokens, default 3072 dims, MRL 128–3072 (768/1536/3072 recommended). `gemini-embedding-001`: text only, 2,048 tokens. | CONFIRMED | https://ai.google.dev/gemini-api/docs/pricing (2026-10-16); https://ai.google.dev/gemini-api/docs/embeddings (2026-10-09) |
| C1-08 | `Qwen/Qwen3-Embedding-{0.6B,4B,8B}`: Apache-2.0, 32K context, dims 1024 / 2560 / 4096, MRL, instruction-aware. Card claims 8B was No.1 on MTEB multilingual as of 2025-06-05 (70.58). | CONFIRMED (card); MTEB claim = vendor self-report | HF model cards (0.6B sha `97b0c614be4d`) |
| C1-09 | `BAAI/bge-m3`: MIT, 1024 dims, 8192 tokens, dense + sparse + ColBERT. | CONFIRMED | HF card sha `5617a9f61b02` |
| C1-10 | `nomic-ai/nomic-embed-text-v1.5`: Apache-2.0, 768 dims (MRL to 512/256/128), 8192 seq len. `nomic-embed-text-v2-moe` Apache-2.0. | CONFIRMED | HF cards |
| C1-11 | EmbeddingGemma: current docs describe **EmbeddingGemma 2** (740M, multimodal, 768 dims, MRL 128/256/512/768, 8,192 tokens, 100+ languages) "licensed under the Apache 2.0 License". The older `google/embeddinggemma-300m` HF repo is gated with licence `gemma`. | CONFIRMED | https://ai.google.dev/gemma/docs/embeddinggemma (2026-10-06, marked deprecated → gemma.ai); HF API |
| C1-12 | `sqlite-vec` `0.1.9` (npm + PyPI, release 2026-03-31), MIT OR Apache-2.0. README: "_`sqlite-vec` is a pre-v1, so expect breaking changes!_". `vec0` virtual tables; float, int8, binary vectors; metadata/aux/partition columns. Mozilla Builders sponsored. Last repo push 2026-05-18. | CONFIRMED | `npm view`, PyPI, `gh api repos/asg017/sqlite-vec` + README |
| C1-13 | `pgvector` latest tag `v0.8.7` (README install refs v0.8.7), PostgreSQL-style licence. Index types `HNSW` and `IVFFlat`; indexable `vector` ≤2,000 dims, `halfvec` ≤4,000, `bit` ≤64,000, `sparsevec` ≤1,000 non-zero; storage up to 16,000 dims. Distances: L2, inner product, cosine, L1, Hamming, Jaccard. | CONFIRMED | `gh api repos/pgvector/pgvector/tags`; README; LICENSE |

#### Design implications
- Matching objectives to service capabilities is short text: cheapest hosted options are `text-embedding-3-small` or `voyage-4-lite` at $0.02/1M (C1-01, C1-02).
- For local/offline matching: `Qwen3-Embedding-0.6B`, `bge-m3`, `nomic-embed-text-v1.5`, `voyage-4-nano` are all MIT/Apache — check EmbeddingGemma version before shipping, licences differ (C1-04, C1-08..11).
- Pick 1024 or fewer dims; it fits pgvector HNSW (≤2,000) and keeps sqlite-vec tables small (C1-13).
- `sqlite-vec` is pre-v1: pin exact version and plan re-index on upgrade (C1-12).
- Store model ID + dims with every vector; switching models means re-embedding.

### C2. PII and secret redaction

| # | Fact | Grade | Source |
|---|---|---|---|
| C2-01 | Presidio `2.2.364` (PyPI `presidio-analyzer` / `presidio-anonymizer`, 2026-07-22), MIT, Python `>=3.10,<3.15`. | CONFIRMED | PyPI JSON; `gh api` releases |
| C2-02 | **Presidio has moved:** `microsoft/presidio` now resolves to `data-privacy-stack/presidio`; docs moved to https://presidio.dataprivacystack.org/ . Site: "Presidio is transitioning to a community-owned project". | CONFIRMED | `gh api repos/microsoft/presidio` returns `data-privacy-stack/presidio`; site home page |
| C2-03 | Modules: Analyzer, Anonymizer, Image Redactor, Structured. Disclaimer: "there is no guarantee that Presidio will find all sensitive information." | CONFIRMED | https://presidio.dataprivacystack.org/ |
| C2-04 | Languages: English out of the box; other languages need an NLP engine model (spaCy, Stanza, transformers) and per-language recognizers (context words are language-specific). | CONFIRMED | https://presidio.dataprivacystack.org/analyzer/languages/ |
| C2-05 | Global entities: `CREDIT_CARD`, `CRYPTO`, `DATE_TIME`, `EMAIL_ADDRESS`, `IBAN_CODE`, `IP_ADDRESS`, `MAC_ADDRESS`, `NRP`, `LOCATION`, `PERSON`, `PHONE_NUMBER`, `MEDICAL_LICENSE`, `URL`; plus country sets (US, UK, ES, IT, PL, SG, AU, IN, FI, KR, NG, PH, CA, SE, ZA, TH, TR, DE) and medical NER entities (needs `transformers` extra). No API-key/secret recognizers listed. | CONFIRMED | https://presidio.dataprivacystack.org/supported_entities/ |
| C2-06 | `gitleaks` latest `v8.30.1` (2026-03-21), MIT; default config `config/gitleaks.toml` at v8.30.1 has **222** `[[rules]]`. `detect`/`protect` deprecated since v8.19.0. | CONFIRMED | `gh api` release + file count at tag (commit `83d9cd68…`) |
| C2-07 | `trufflehog` latest `v3.99.2` (2026-10-08), **AGPL-3.0**. README: "classifies over 800 secret types" and can "log in to confirm if that secret is live" (verification). `proto/detector_type.proto` at v3.99.2 has 1,069 enum entries (36 marked deprecated); `pkg/detectors/` has 888 directories. | CONFIRMED | `gh api` at tag (commit `e76dff8a…`) |
| C2-08 | `detect-secrets` (Yelp) latest `v1.5.0` (2024-05-06), Apache-2.0; 28 `.py` files in `detect_secrets/plugins`. No release in ~2.5 years. | CONFIRMED | `gh api`; PyPI |

#### Design implications
- Two layers needed: a secrets scanner (gitleaks rules) and a PII recogniser (Presidio); Presidio has no secret detectors (C2-05, C2-06).
- gitleaks (MIT) rules can be embedded; trufflehog is AGPL — run it as a separate binary, don't link it, and never enable live verification on user data (it sends the secret to the provider) (C2-06, C2-07).
- Presidio is English-only by default and makes no completeness promise — treat redaction as best-effort and add an allow/deny review step before data leaves the machine (C2-03, C2-04).
- Point dependency URLs at `data-privacy-stack/presidio`; watch governance change (C2-02).
- `detect-secrets` looks stale; don't make it primary (C2-08).

### C3. Prompt-injection defences

| # | Fact | Grade | Source |
|---|---|---|---|
| C3-01 | OWASP LLM01:2025 Prompt Injection mitigations: (1) Constrain model behavior, (2) Define and validate expected output formats, (3) Implement input and output filtering, (4) Enforce privilege control and least privilege access, (5) Require human approval for high-risk actions, (6) Segregate and identify external content, (7) Conduct adversarial testing and attack simulations. | CONFIRMED | https://genai.owasp.org/llmrisk/llm01-prompt-injection/ (2025 version) |
| C3-02 | OWASP Top 10 for Agentic Applications, "Version 2026", December 2025 (published 2025-12-09). Entries: ASI01 Agent Goal Hijack, ASI02 Tool Misuse and Exploitation, ASI03 Identity and Privilege Abuse, ASI04 Agentic Supply Chain Vulnerabilities, ASI05 Unexpected Code Execution (RCE), ASI06 Memory & Context Poisoning, ASI07 Insecure Inter-Agent Communication, ASI08 Cascading Failures, ASI09 Human-Agent Trust Exploitation, ASI10 Rogue Agents. | CONFIRMED | PDF https://genai.owasp.org/download/52117/ (sha256 `a2db94cd…fcb5c`), resource page https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/ |
| C3-03 | ASI01 mitigations (9): treat all natural-language inputs as untrusted and route through LLM01 safeguards; least privilege + human approval for high-impact/goal-changing actions; lock and version system prompts; validate user and agent intent at run time, pause on goal shift; consider "intent capsule" (signed envelope binding goal + constraints per cycle); sanitize all connected sources (RAG, email, files, APIs, browsing, peer agents) with CDR / prompt-carrier detection; log and baseline goal state + tool patterns and alert on drift; red-team goal override and test rollback; include agents in insider-threat program. | CONFIRMED | same PDF pp. 10–11 |
| C3-04 | Anthropic docs, indirect prompt injection: put untrusted content only in `tool_result` blocks; say what the content is and where it came from; state an untrusted-content policy in the system prompt; JSON-encode untrusted strings; don't put your own instructions in tool results; least privilege + sandboxed tools; screen tool outputs with a small model (Claude Haiku 5.5) using structured outputs; red-team; continuous monitoring. Anthropic runs extra classifiers on computer-use and browser-use tool results. | CONFIRMED | https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks (read 2026-10-18) |
| C3-05 | Anthropic research (2025-11-24): RL training on injections in simulated web content; classifiers scan "all untrusted content that enters the model's context window"; human + automated red teaming. "A 1% attack success rate—while a significant improvement—still represents meaningful risk." "No browser agent is immune to prompt injection". | CONFIRMED | https://www.anthropic.com/research/prompt-injection-defenses |
| C3-06 | OpenAI "Safety in building agents": keep untrusted variables out of developer messages (pass via user messages); structured outputs between nodes (enums, fixed schemas); clear guidance + examples; use GPT-5 / GPT-5-mini at agent nodes; tool approvals for every MCP operation (reads and writes); input guardrails (PII redaction, jailbreak detection) as a first, incomplete layer; trace graders and evals; combine techniques — they "reduce but do not eliminate risk". | CONFIRMED | https://developers.openai.com/api/docs/guides/agent-builder-safety (no date shown) |
| C3-07 | OpenAI "Understanding prompt injections" and "Continuously hardening ChatGPT Atlas" posts: Atlas post says prompt injection is "unlikely to ever be fully 'solved.'" | WEAK SIGNAL | openai.com returned HTTP 403 to WebFetch; quote only seen in search snippet |
| C3-08 | Google layered defence (blog 2025-06-13): model resilience (adversarial training of Gemini 2.5), prompt-injection content classifiers, security thought reinforcement, markdown sanitization + suspicious URL redaction (Safe Browsing), user confirmation framework for risky actions, end-user mitigation notifications. | CONFIRMED | https://blog.google/security/mitigating-prompt-injection-attacks/ |
| C3-09 | CaMeL, "Defeating Prompt Injections by Design" (arXiv 2503.18813; v1 2025-03-24, v2 2025-06-24; authors incl. Debenedetti, Shumailov, Carlini, Tramèr): a system layer extracts control and data flow from the trusted query so untrusted data cannot change program flow; capabilities block exfiltration over unauthorized flows at tool-call time. AgentDojo: 77% tasks solved with provable security vs 84% undefended. | CONFIRMED (abstract) | https://arxiv.org/abs/2503.18813 |
| C3-10 | Google DeepMind white paper "Lessons from Defending Gemini Against Indirect Prompt Injections" (May 2025) says no single defence gives full immunity. | WEAK SIGNAL | search snippet only; https://storage.googleapis.com/deepmind-media/Security%20and%20Privacy/Gemini_Security_Paper.pdf not read |

#### Design implications
- Every source agrees: no defence is complete. Czar's money controls must hold even if the model is fully hijacked — on-chain spending limits and envelopes are the real boundary (C3-03, C3-05, C3-06).
- Seller text, x402 descriptions and agent replies go in `tool_result` blocks, JSON-encoded, labelled with source (C3-04).
- Run a small-model injection screen on seller text before the planner sees it (C3-04, C3-08).
- Human approval for goal-changing or high-value actions (new payee, over-envelope spend) (C3-01, C3-03, C3-06).
- Use structured outputs between the reader and the planner so seller text can't become free-form instructions; CaMeL-style split (planner never reads raw untrusted text) is the strongest published pattern (C3-06, C3-09).
- Work soul is memory: ASI06 Memory & Context Poisoning applies — gate what observers can write into it (C3-02).
- Log goal state and tool sequences and alert on drift (C3-03).

---

## D. App surfaces (P2)

#### Sources for D–F

- **Date checked:** 2026-10-18 (every row below)
- **Method:** raw docs pulled with `curl` (Markdown where the site serves it), spec repos cloned at a commit, npm tarballs packed with `--ignore-scripts` and read from their source maps, read-only HTTP probes. No logins, no keys, no payments.
- **Experiment log:** `research/evidence/experiments/gt2-df-readonly-probes/` (README + raw outputs + CLI diff)

Source tags:

| Tag | Source |
|---|---|
| [PKD] | https://passkeys.dev/device-support/ ("Last Updated: Sep 21, 2026"; W3C Web Identity & Credentials Adoption CG + FIDO Alliance) |
| [PKD-IOS] / [PKD-AND] | https://passkeys.dev/docs/reference/ios/ (updated Oct 31, 2025), `/android/` (updated Aug 29, 2026) |
| [APPLE-PK] | https://developer.apple.com/documentation/authenticationservices/supporting-passkeys (via the page's JSON data endpoint) |
| [GOOG-PK] | https://developers.google.com/identity/passkeys/supported-environments ("Last updated 2025-05-19") |
| [WK18] | https://webkit.org/blog/15865/webkit-features-in-safari-18-0/ |
| [WK26] | https://webkit.org/blog/17333/webkit-features-in-safari-26-0/ |
| [WK-PUSH164] | https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ |
| [WK-MWP] | https://webkit.org/blog/12945/meet-web-push/ |
| [WK-DWP] | https://webkit.org/blog/16535/meet-declarative-web-push/ |
| [MCP] | `modelcontextprotocol/modelcontextprotocol` at commit `1155ca460e5097019f32769b38dcba194432e2fb` (2026-10-18), folder `docs/specification/2026-07-28/` and `schema/2026-07-28/schema.ts`; `https://modelcontextprotocol.io/specification/latest` → 307 to `/specification/2026-07-28` |
| [MCP-SEC] | same commit, `docs/docs/2026-07-28/tutorials/security/security_best_practices.mdx` |
| [GH-STAR] | https://docs.github.com/en/rest/activity/starring (via `docs.github.com/api/article/body`) |
| [GH-RL] | https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api |
| [GH-GQL] | https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api |
| [GH-REPOS] | https://docs.github.com/en/rest/repos/repos, `/rest/repos/forks`, `/rest/releases/releases` |
| [GH-AUP] | https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies |
| [GH-TOS] | https://docs.github.com/en/site-policy/github-terms/github-terms-of-service ("Effective date: April 27, 2026") |
| [GH-CL1] | https://github.blog/changelog/2026-06-30-upcoming-access-restrictions-to-public-api-endpoints-and-ui-views/ |
| [GH-CL2] | https://github.blog/changelog/2026-09-04-new-api-endpoint-provides-privacy-safe-star-history-data/ |
| [PROBE] | own read-only probes, `research/evidence/experiments/gt2-df-readonly-probes/raw/` (2026-10-18T14:18–14:27Z) |
| [FAKE] | He et al., arXiv `2412.13459` v2 (6 Sep 2025), ICSE '26, HTML at https://arxiv.org/html/2412.13459v2 |
| [CC-MAN] | https://code.claude.com/docs/en/plugins-reference.md (Plugin manifest reference) |
| [CC-MKT] | https://code.claude.com/docs/en/plugins/marketplace-reference.md |
| [CC-SK] | https://code.claude.com/docs/en/skills.md |
| [AS] | https://agentskills.io/specification.md |
| [CLI-x] | `@circle-fin/cli@x` npm tarball, sources rebuilt from `dist/index.js.map` |
| [NPM] | `npm view <pkg> dist-tags time --json` (2026-10-18) |
| [X402] | `x402-foundation/x402` main at `faa1c694c66a3732aaabbce93bdae140e521a67d` (2026-10-15): `typescript/packages/core/CHANGELOG.md`, `typescript/.changeset/*.md` |
| [CRN] | https://developers.circle.com/release-notes/agent-stack-2026.md, `/release-notes/gateway-2026.md` |
| [CPOL] | https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/custom-policies.md |
| [CLIST] | https://developers.circle.com/agent-stack/agent-marketplace/get-listed.md |
| [ONR] | https://docs.arc.io/app-kit/onramp.md and `/app-kit/references/onramp-hosting-requirements.md` |
| [ONR-T] | https://www.arc.io/legal/onramp ("September 16, 2026") |

### D1. Passkeys (WebAuthn) in mobile web and installed PWAs

| # | Fact | Grade | Source |
|---|---|---|---|
| D1-01 | **Synced passkeys:** Android 9+, iOS/iPadOS 16+, macOS 13+, ChromeOS 129+. Windows: "Planned". | STRONG SIGNAL (community matrix by FIDO/W3C CG members) | [PKD] |
| D1-02 | On Apple platforms passkeys are **iCloud Keychain** credentials, verified by Face ID / Touch ID (or a confirmation on macOS). A native app must have an associated domain with the `webcredentials` service type, or the request errors. | CONFIRMED (official docs) | [APPLE-PK] |
| D1-03 | On Android, **Google Password Manager** is the default passkey provider and "syncs passkeys and makes them available on other platforms". Users can pick another provider on Android 14+. Chrome on Android 9+ supports passkeys. | CONFIRMED (official docs, page dated 2025-05-19) | [GOOG-PK] |
| D1-04 | **Autofill / conditional UI** (`mediation: "conditional"` on get): iOS 16.1+ (all browsers), Safari 16.1+ on macOS, Chrome 108+, Firefox 122+, Edge 122+. | STRONG SIGNAL | [PKD] |
| D1-05 | **Passkey upgrades** (`mediation: "conditional"` on create): Safari 18.0 added it. Matrix lists iOS 18+, Chrome 136+ desktop, Chrome 142+ Android. | CONFIRMED for Safari (WebKit blog); STRONG SIGNAL for others | [WK18], [PKD] |
| D1-06 | **Related Origin Requests** (one passkey across a small set of domains): Safari 18.0 added it. Matrix lists iOS 18+, Chrome/Edge 128+, Firefox 152+. | CONFIRMED for Safari; STRONG SIGNAL for others | [WK18], [PKD] |
| D1-07 | Safari 18.0 added the WebAuthn `prf` extension (derive a symmetric key from a passkey). Safari 26.0 added the WebAuthn Signal API (`PublicKeyCredential.signal*`). | CONFIRMED (WebKit blog) | [WK18], [WK26] |
| D1-08 | **User verification:** on iOS and Android the screen lock (passcode/PIN plus Face ID/Touch ID/fingerprint) is the UV method. With `userVerification` `required` or `preferred` the result is the same, so the server can expect the UV flag to be true. iOS with no passcode forces the user to set one. | STRONG SIGNAL | [PKD-IOS], [PKD-AND] |
| D1-09 | **Embedded web views:** iOS `WKWebView` needs the host app's associated domain to use passkeys; Android WebView has its own rules. `ASWebAuthenticationSession` (iOS) and Custom Tabs (Android) are the supported system web views. | CONFIRMED (Apple, web view section); STRONG SIGNAL (matrix) | [APPLE-PK], [PKD] |
| D1-10 | **iOS 26 / iPadOS 26: every site added to the Home Screen opens as a web app by default**, with or without a manifest. "There are now zero requirements for 'installability' in Safari." | CONFIRMED (WebKit blog) | [WK26] |
| D1-11 | **Passkeys inside an installed Home Screen web app (standalone) on iOS:** no Apple or WebKit page found that states support or limits. Only a third-party demo asks users to try it from the Home Screen. | GAP (WEAK SIGNAL that it works) | searches listed below |
| D1-12 | Device-bound passkey **attestation** is not available on the default platform authenticators (n/a on Android, iOS, macOS in the matrix). Synced passkeys give no hardware proof. | STRONG SIGNAL | [PKD] |

#### Design implications
- Czar's mobile approval surface can rely on synced passkeys on iOS 16+ and Android 9+ (D1-01..03). Plan for iOS 18+ if we want related origins or passkey upgrades (D1-05, D1-06).
- Do not treat a passkey as proof of a specific device; there is no attestation on synced passkeys (D1-12).
- Test passkey ceremonies inside the installed iOS web app before committing to a PWA-only approval flow (D1-11 is a GAP).
- Avoid in-app browsers / `WKWebView` for approvals unless we ship a native app with associated domains (D1-02, D1-09).

### D2. Web push for installed PWAs on iOS

| # | Fact | Grade | Source |
|---|---|---|---|
| D2-01 | **Minimum iOS/iPadOS 16.4.** Web Push works for **Home Screen web apps** only (Push API + Notifications API + Service Workers). | CONFIRMED (WebKit blog) | [WK-PUSH164] |
| D2-02 | The permission request must be "in response to direct user interaction — such as tapping on a 'subscribe' button". Users then manage it per web app in Notifications Settings. | CONFIRMED | [WK-PUSH164] |
| D2-03 | Uses Apple Push Notification service. No Apple Developer Program membership needed. Allow `*.push.apple.com` if you control server push endpoints. | CONFIRMED | [WK-PUSH164] |
| D2-04 | **No silent push.** Subscriptions must set `userVisibleOnly: true`; if a push does not show a notification, WebKit revokes the subscription. | CONFIRMED | [WK-MWP], [WK-DWP] |
| D2-05 | Badging API (`setAppBadge`, `clearAppBadge`) and Focus modes work for Home Screen web apps from 16.4. Manifest `id` identifies the app (and syncs Focus settings). | CONFIRMED | [WK-PUSH164] |
| D2-06 | **Declarative Web Push:** iOS/iPadOS 18.4 (and macOS 15.5). A push message whose JSON has `"web_push": 8030` is shown without a service worker; `window.pushManager` can subscribe without one. A service worker can optionally rewrite the message; no "silent push penalty" applies. | CONFIRMED (WebKit blog) | [WK-DWP] |
| D2-07 | Intelligent Tracking Prevention can delete service worker registrations of sites not visited for a while; with classic Web Push that kills the subscription. Declarative Web Push survives that. | CONFIRMED | [WK-DWP] |
| D2-08 | **EU history:** iOS 17.4 betas removed Home Screen web apps in the EU (DMA); on 2024-03-01 Apple reversed this and kept them on WebKit. | STRONG SIGNAL (9to5Mac, MacRumors, TechCrunch, The Register quoting Apple's developer page) | WebSearch results; Apple's own page not re-read |
| D2-09 | From iOS 26, any site added to the Home Screen opens as a web app (D1-10), so the user can get a push-capable web app without the site shipping a manifest. Whether push needs a manifest in that case: not stated. | CONFIRMED (first half); GAP (second half) | [WK26] |

#### Design implications
- The iOS approval prompt needs the user to install Czar to the Home Screen first; plain Safari tabs get no push (D2-01). Onboarding must include that step.
- The "Enable notifications" button must be a real tap handler that calls the permission request (D2-02).
- Every push must show a visible notification; no background wake-ups for sync (D2-04). Use Declarative Web Push JSON so a crashed or deleted service worker still shows the approval (D2-06, D2-07).
- Push alone is not a reliable approval channel; keep an in-app pending-approvals list as the source of truth.

### D3. MCP specification

| # | Fact | Grade | Source |
|---|---|---|---|
| D3-01 | **Current revision is `2026-07-28`** (docs nav: "Version 2026-07-28 (latest)"; `/specification/latest` redirects there). Earlier: `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`. | CONFIRMED (spec repo + live redirect) | [MCP] |
| D3-02 | **MCP is now stateless.** `2026-07-28` removes the `initialize` handshake and the `Mcp-Session-Id` header. Every request carries `_meta` keys `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities`. Servers **MUST** implement `server/discover`. Versions `2025-11-25` and older are called "Legacy"; dual-era support is described. | CONFIRMED | [MCP] `changelog.mdx`, `basic/versioning.mdx` |
| D3-03 | **Transports:** stdio and Streamable HTTP. HTTP+SSE is formally Deprecated (since `2025-03-26`). `2026-07-28` also removes SSE resumability (`Last-Event-ID`), the HTTP GET stream (replaced by `subscriptions/listen`), `ping` and `logging/setLevel`. Streamable HTTP POSTs need `Mcp-Method` / `Mcp-Name` headers and `MCP-Protocol-Version`. | CONFIRMED | [MCP] `changelog.mdx`, `deprecated.mdx`, `basic/transports/streamable-http.mdx` |
| D3-04 | **Server-initiated requests are gone.** Elicitation, sampling and roots now use Multi Round-Trip Requests: the server returns `InputRequiredResult` (`resultType: "input_required"`) and the client retries with `inputResponses`. Every result has a required `resultType`. | CONFIRMED | [MCP] `changelog.mdx`, `basic/patterns/mrtr.mdx` |
| D3-05 | **Deprecated in `2026-07-28`:** Roots, Sampling, Logging, and Dynamic Client Registration (replaced by Client ID Metadata Documents). Earliest removal: first revision on or after 2027-07-28. Tasks moved to extension `io.modelcontextprotocol/tasks`. | CONFIRMED | [MCP] `deprecated.mdx`, `changelog.mdx` |
| D3-06 | **Authorization (HTTP only):** OAuth 2.1 (draft-ietf-oauth-v2-1-13). Servers **MUST** publish Protected Resource Metadata (RFC 9728). Clients **MUST** send `resource` (RFC 8707) in authorization and token requests; servers **MUST** check the token audience. PKCE; tokens only in the `Authorization` header, never the query string. Clients **MUST** validate `iss` (RFC 9207) when present. | CONFIRMED | [MCP] `basic/authorization/index.mdx` |
| D3-07 | **stdio servers "SHOULD NOT" use the OAuth flow** and "instead retrieve credentials from the environment". | CONFIRMED | [MCP] `basic/authorization/index.mdx` lines 21–22 |
| D3-08 | **Local HTTP servers:** **MUST** validate `Origin` (DNS rebinding); **SHOULD** bind to `127.0.0.1`, not `0.0.0.0`; **SHOULD** authenticate all connections. | CONFIRMED | [MCP] `basic/transports/streamable-http.mdx` lines 58–65 |
| D3-09 | **Human in the loop:** "there SHOULD always be a human in the loop with the ability to deny tool invocations"; apps SHOULD show confirmation prompts. This is a client duty, not a server guarantee. | CONFIRMED | [MCP] `server/tools.mdx` lines 33–40 |
| D3-10 | **Tool annotations:** `readOnlyHint` (default false), `destructiveHint` (default true), `idempotentHint` (default false), `openWorldHint` (default true), `title`. Clients **MUST** treat annotations as untrusted unless the server is trusted. | CONFIRMED | [MCP] `schema/2026-07-28/schema.ts` ~L1915–1953, `server/tools.mdx` L305–306 |
| D3-11 | **Elicitation modes:** `form` and `url`. Servers **MUST NOT** use form mode for "passwords, API keys, access tokens, or payment credentials" and **MUST** use URL mode for them. Clients **MUST** show which server asks, and for URL mode show the target host and get consent before navigating. | CONFIRMED | [MCP] `client/elicitation.mdx` lines 12–45 |
| D3-12 | Security best practices (2026-07-28 edition): local server compromise section — clients with one-click install **MUST** show the exact command and get explicit approval; local servers **SHOULD** use stdio, or restrict HTTP with an auth token or unix sockets. Also covers token passthrough (forbidden), confused deputy, SSRF, "state handle hijacking". | CONFIRMED | [MCP-SEC] |
| D3-13 | No payment-specific mechanism exists in the core spec. Only the elicitation rule on "payment credentials" (D3-11) touches payments. | CONFIRMED (searched spec for "payment") | [MCP] |

#### Design implications
- Czar's local payment MCP server should use **stdio** and take credentials from the environment, not OAuth (D3-07, D3-12).
- If it must use HTTP: bind `127.0.0.1`, check `Origin`, require a token (D3-08).
- Never rely on the client to ask the user before a payment: approval must be enforced by Czar itself (vault limits, envelope, passkey approval), since human-in-the-loop is only a SHOULD and annotations are untrusted (D3-09, D3-10).
- Mark pay tools `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true` (D3-10); make them idempotent anyway via a client-supplied payment id.
- Use URL-mode elicitation (open Czar's approval page) for any step that touches keys or authorizes a spend (D3-11, D3-04).
- Target `2026-07-28` but expect clients (Claude Code, Cursor, Codex) still on legacy versions; the SDK must be dual-era (D3-02). Which revision each client speaks: not checked here.

---

## E. Supply side (P2)

### E1. GitHub API and fake-star research

| # | Fact | Grade | Source |
|---|---|---|---|
| E1-01 | **The stargazer list is no longer public.** GitHub restricted `GET /repos/{owner}/{repo}/stargazers` and `GET /repos/{owner}/{repo}/subscribers` (and the `/stargazers`, `/stargazers/you_know`, `/watchers` pages) to **admins and collaborators**, citing spam scraping. `/users/{username}/subscriptions` is deprecated and returns empty. | CONFIRMED (GitHub changelog + live probe) | [GH-CL1], [GH-CL2], [PROBE] |
| E1-02 | **Live behaviour today:** list stargazers → `401 Requires authentication` without a token; `404 Not Found` with a non-owner token (`repo` scope), on any API version. On an owned repo it returns 200. GraphQL `repository.stargazers` returns `totalCount: 0` and no edges, while `stargazerCount` is still 155. | CONFIRMED (experiment) | [PROBE] `gh-status.txt`, `gh-graphql-stargazers.json` |
| E1-03 | The `application/vnd.github.star+json` media type (adds `starred_at`) still exists in the docs, but it only helps owners/collaborators now (E1-02). | CONFIRMED | [GH-STAR], [PROBE] |
| E1-04 | **New aggregate endpoints:** `GET /repos/{owner}/{repo}/stargazers/count` → `{ "count": n }` (current stars, unstars excluded). `GET /repos/{owner}/{repo}/stargazers/history` → weekly buckets `{ week, total, days[7] }`, newest first, `per_page` max 30, `page` max 100 (about 3,000 weeks). No identities. Both work unauthenticated. Announced 2026-09-04. | CONFIRMED (docs + live call) | [GH-STAR], [GH-CL2], [PROBE] |
| E1-05 | **Loophole still open:** `GET /repos/{owner}/{repo}/events` still returns `WatchEvent` (= star) entries with the actor's login (57 of the last 100 events on facebook/react). GH Archive is built from this public event stream. GitHub may close this later. | CONFIRMED (experiment); future status unknown | [PROBE] `gh-events-watchevent-count.txt` |
| E1-06 | **Forks:** `GET /repos/{owner}/{repo}/forks`, `sort` = `newest` (default), `oldest`, `stargazers`, `watchers`. Works with a non-owner token. | CONFIRMED (docs + live) | [GH-REPOS], [PROBE] |
| E1-07 | **Contributors:** `GET /repos/{owner}/{repo}/contributors`, sorted by commit count; data may be "a few hours old"; only the first 500 author emails map to users, the rest are anonymous (`anon=1` to include). | CONFIRMED | [GH-REPOS] |
| E1-08 | **Releases:** `GET /repos/{owner}/{repo}/releases`; each release has `immutable` (boolean) and assets with `download_count`. | CONFIRMED (docs + live) | [GH-REPOS], [PROBE] |
| E1-09 | **REST primary limits:** 60 req/h unauthenticated; 5,000 req/h per user token; 15,000 req/h for GitHub Enterprise Cloud-owned apps; `GITHUB_TOKEN` 1,000 req/h per repo. | CONFIRMED | [GH-RL] |
| E1-10 | **Secondary limits:** ≤100 concurrent requests (REST+GraphQL shared); ≤900 points/min per REST endpoint, ≤2,000 points/min for GraphQL; ≤90 s CPU per 60 s (≤60 s GraphQL); ~80 content-creating requests/min, 500/h. "Subject to change without notice"; no way to check status; `403`/`429` with `retry-after`. | CONFIRMED | [GH-RL] |
| E1-11 | **GraphQL primary limit:** 5,000 points/h per user (10,000 for Enterprise Cloud-owned apps; App installations up to 12,500); query `rateLimit { cost remaining }` to see cost. | CONFIRMED | [GH-GQL] |
| E1-12 | **Terms:** abuse or "excessively frequent" API use can suspend API access; you "may not share API tokens to exceed GitHub's rate limitations"; no use of API data for spam or selling personal info. AUP bans "rank abuse, such as automated starring or following" and "coordinated inauthentic activity". Researchers may use public **non-personal** data only if publications are open access. | CONFIRMED | [GH-TOS] §H, [GH-AUP] §7 |
| E1-13 | **Fake-star paper:** He, Yang, Burckhardt, Kapravelos, Vasilescu, Kästner, "Six Million (Suspected) Fake Stars in GitHub" (v1 Dec 2024 was titled "4.5 Million…"), ICSE '26. StarScout over GH Archive, Jul 2019–Dec 2024: **6.0 M suspected fake stars**; after post-processing 18,617 repos with fake-star campaigns, 301k accounts, 3.81 M stars. Surged in 2024. | CONFIRMED (paper read) | [FAKE] |
| E1-14 | **Two signatures used:** (1) *low activity* — account's only event is one star (plus ≤1 other event same repo, same day); (2) *lockstep* — CopyCatch clusters of ≥50 accounts × ≥10 repos where each repo gets ≥25 of those stars within 30 days. Post-processing keeps repos with a ≥50-star anomalous month and >10% fake stars. | CONFIRMED | [FAKE] §3.2 |
| E1-15 | **What is hard vs easy to fake (paper's findings):** fake-star accounts and repos are skewed to starring and "rarely engage in activities that are considerably harder to fake (e.g., issues, pull requests, comments)". Lockstep accounts can look long-lived like normal users (harder to catch). Stars barely correlate with downloads/installs. Fake stars give a short boost (<2 months, ~5x weaker than real stars) and hurt later. Prices $0.10–$2.00 per star. Suggested better signals: real adoption (network centrality), weighting stars by stargazer activity/authenticity, shadow-banning suspicious stars. | CONFIRMED (paper text) | [FAKE] §4, §5, appendix |
| E1-16 | GitHub's own ranking fields that remain public per repo: `stargazers_count`, `forks_count`, `watchers_count` (repo object), and the new star history. | CONFIRMED (live) | [PROBE] |

#### Design implications
- Czar cannot build per-stargazer reputation from the API anymore (E1-01, E1-02). Use `stargazers/history` for velocity and spike detection (E1-04), not identities.
- A star spike with no matching issues/PRs/comments from non-owners is the paper's main red flag; weight those harder-to-fake signals (E1-15). Release `download_count` and fork activity are useful extras (E1-06, E1-08).
- Do not depend on the `WatchEvent` loophole (E1-05); treat it as possibly closing.
- Budget: one supply-side scan per repo ≈ a few calls; with 5,000/h per token and the "no token sharing to beat limits" rule, cache results and scan on demand (E1-09, E1-12).
- Do not store or resell personal data of GitHub users; keep only aggregate signals (E1-12).

### E2. Claude Code plugin and skill formats

| # | Fact | Grade | Source |
|---|---|---|---|
| E2-01 | **Plugin manifest** is `.claude-plugin/plugin.json`. Only `name` is required (kebab-case; no spaces, `@`, `:`, separators). Unknown top-level keys are stripped with a validator warning. | CONFIRMED | [CC-MAN] |
| E2-02 | **Provenance/metadata fields in `plugin.json`:** `displayName`, `version` (not checked against semver; pins users to it), `description`, `author` (`name` required, optional `email`, `url`), `homepage` (must parse as URL), `repository` (not validated), `license` (SPDX), `keywords`, `metadata` (free-form, ignored by Claude Code). Directory-listing fields `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`. Components: `skills`, `commands`, `agents`, `hooks`, `mcpServers`, `lspServers`, `outputStyles`, `workflows`, `userConfig`, `channels`, `dependencies`, `settings`, `defaultEnabled`, `experimental.*`. | CONFIRMED | [CC-MAN] Fields table |
| E2-03 | `claude plugin validate` warns on missing `version`, `description` or `author`; `--strict` turns warnings into failures. Names that pass as Anthropic's own (`claude-*`, `anthropic-*`, `official` beside `claude`) are errors. | CONFIRMED | [CC-MAN] |
| E2-04 | **Marketplace file** is `.claude-plugin/marketplace.json`. Required: `name`, `owner` (`name` required; `email`, `url` optional), `plugins`. Optional: `$schema`, `description`, `version`, `metadata.{description,version,pluginRoot}`, `forceRemoveDeletedPlugins`, `allowCrossMarketplaceDependenciesOn`, `renames`. Many reserved names (e.g. `claude-plugins-official`, `agent-skills`, names starting `claudeai-`). | CONFIRMED | [CC-MKT] |
| E2-05 | **Plugin entry fields:** `name`, `source` (required), `description`, `version`, `category`, `tags`, `strict` (default true), `relevance`, `dependencies`, `defaultEnabled`, `displayName`, `metadata`, `headers`, `headersHelper`, plus any `plugin.json` field except the directory-listing ones. Entry display fields (`displayName`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`) override `plugin.json`; `plugin.json` `version` overrides the entry. | CONFIRMED | [CC-MKT] |
| E2-06 | **Sources:** relative path, `github` (`repo`, `ref`, `sha`), `url` (git), `git-subdir`, `npm` (`package`, `version`, `registry`; install scripts never run), `archive` (`url`, `sha256`), `command`. | CONFIRMED | [CC-MKT] |
| E2-07 | **No signing.** The only integrity tools are pinning: a full 40-char commit `sha` for git sources and `sha256` for archives (download refused on mismatch). Author fields are self-declared and unverified (`repository` "Not validated"). | CONFIRMED (searched docs for sign/attest/provenance: none) | [CC-MKT], [CC-MAN] |
| E2-08 | **SKILL.md frontmatter (Claude Code):** `name`, `description` (recommended; with `when_to_use` truncated at 1,536 chars in listings), `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context`, `agent`, `background`, `hooks`, `paths`, `shell`, `metadata`, `license`, `compatibility`. No `author` or `version` field. | CONFIRMED | [CC-SK] Frontmatter reference |
| E2-09 | **Agent Skills open standard exists** (agentskills.io); Claude Code says its skills follow it. The spec's fields: `name` (required, ≤64, lowercase/digits/hyphens, must match the folder name), `description` (required, ≤1024), `license`, `compatibility` (≤500), `metadata` (string→string map; spec example uses `author`, `version`), `allowed-tools` (experimental). claude.ai uploads and the Skills API reject any other key. | CONFIRMED | [AS], [CC-SK] |

#### Design implications
- Builder identity for a skill/plugin must come from Czar's own registry (e.g. a signed claim tied to a wallet or GitHub account), not from `author` fields, which anyone can type (E2-02, E2-07).
- Store a pinned commit `sha` or `sha256` with every recipe/skill Czar pays for, so "what was paid for" is exact (E2-06, E2-07).
- Put Czar-specific data (builder wallet, revenue split id) in `metadata` (plugin and SKILL.md) — Claude Code ignores it, so it is safe; in SKILL.md it must be string→string for portability (E2-02, E2-09).

---

## F. Re-verified since 2026-10-09 (P2)

### F1. `@circle-fin/cli`

| # | Fact | Grade | Source |
|---|---|---|---|
| F1-01 | **Latest is `1.2.2`** (published 2026-10-14T20:14Z). `1.2.1` came 2026-10-09T21:35Z. Part 1 used `1.2.0` (2026-10-06). | CONFIRMED | [NPM] |
| F1-02 | `1.2.1` changes only Terms/telemetry plumbing: `terms` verbs `show`, `accept`, `reset` registered; `terms` and `telemetry` commands don't emit telemetry; `telemetry` runs before Terms acceptance. | CONFIRMED (source diff) | [CLI-1.2.1] |
| F1-03 | **`1.2.2`: `services pay` now supports the `upto` scheme and Permit2 transfers** (`UptoEvmScheme` from `@x402/evm`). This **changes part 1 W9** ("skips `upto` and Permit2"). | CONFIRMED (source diff) | [CLI-1.2.2] `src/x402-client.ts` L515, `src/commands/services/pay.ts` |
| F1-04 | For `upto`/Permit2 the CLI first checks the wallet's USDC allowance to Permit2 and **fails closed**: "Circle CLI will not create an approval automatically." `upto` needs a valid `extra.facilitatorAddress` and x402 v2. | CONFIRMED | [CLI-1.2.2] `pay.ts` L468–493, `x402-client.ts` L105+ |
| F1-05 | For `upto`, output shows `authorizedMaximum`; `actualAmount` comes from the seller's receipt, labelled "seller-reported receipt; not independently confirmed", and is dropped if above the maximum. | CONFIRMED | [CLI-1.2.2] `pay.ts` L565+ |
| F1-06 | **New flag `--payment-id <id>`** (16–128 chars `[a-zA-Z0-9_-]`) for a manual retry; only with x402 v2 and only if the 402 advertises the `payment-identifier` extension. Otherwise a random id is generated when the extension is present. Required extensions other than `payment-identifier` are refused. | CONFIRMED | [CLI-1.2.2] `pay.ts` L433–466, `x402-client.ts` |
| F1-07 | Offer selection: only registered USDC offers on the requested chain; "Never switch chains to find support." | CONFIRMED | [CLI-1.2.2] `pay.ts` L397–410 |
| F1-08 | `services inspect` now lists every payment option with `scheme`, `assetTransferMethod` (`gateway`, `eip3009`, `permit2`), `amountKind` (`price` / `authorized_maximum`), `clientSupport`, and `prerequisites: "not_checked"`. | CONFIRMED | [CLI-1.2.2] `commands/services/inspect.ts` |
| F1-09 | **Arc testnet default RPC changed** to `https://rpc.testnet.arc.io` (was `https://rpc.testnet.arc.network` in 1.2.0). Updates part 1 A3. | CONFIRMED | [CLI-1.2.2] `src/chain-map.ts` L198 |
| F1-10 | **No change to `gateway` commands, policies or passkey flags** from 1.2.0 to 1.2.2 (only the 8 files above differ). Passkeys still need `CIRCLE_EXPERIMENTAL_AUTH_PASSKEY=1`; Auth V2 is on by default (`CIRCLE_EXPERIMENTAL_AUTH_V2=0` opts out); `CIRCLE_EXPERIMENTAL_CREDIT=1` gates borrow commands. | CONFIRMED (diff + source) | [CLI-1.2.2] `src/feature-flags.ts` |
| F1-11 | Still pins `@circle-fin/x402-batching` `3.5.0`. Engines `node >=20.18.2`. | CONFIRMED | [CLI-1.2.2] `package.json` |
| F1-12 | Circle's release notes have no entry after 2026-09-16 for Agent Stack (last CLI entry: 1.0.0, 2026-08-13). The 1.2.x changes are undocumented there. | CONFIRMED | [CRN] |

### F2. x402 SDK versions

| # | Fact | Grade | Source |
|---|---|---|---|
| F2-01 | `@circle-fin/x402-batching` latest is still **`3.5.0`** (2026-09-16). No release since. | CONFIRMED | [NPM] |
| F2-02 | `@x402/core` and `@x402/evm` latest are still **`2.28.0`** (2026-09-29). No release since. So **no breaking changes since part 1**. | CONFIRMED | [NPM] |
| F2-03 | `@x402/core` `2.28.0` changelog: "Bumped to align version with dependent packages". Breaking change worth knowing from `2.25.0`: `x402ResourceServer.buildPaymentRequirements()` now throws when no scheme server is registered (was an empty `accepts`). `2.23.0` added client `spendControls` (default: only known stablecoins, `$1` cap per payment) and made `createSIWxPayload` require a `requestUrl` 3rd argument. | CONFIRMED | [X402] `typescript/packages/core/CHANGELOG.md` |
| F2-04 | **Unreleased on `main`** (pending changesets): `@x402/evm` minor "auth-capture v1.1" marked **Breaking** (`extra.autoCapture` rejected; error codes renamed `invalid_auth_capture_evm_*`); `@x402/core` patch requiring payment for `HEAD` on GET routes; `@x402/fastify` payment-gate bypass fix. | CONFIRMED (repo files); release date unknown | [X402] `typescript/.changeset/` |

### F3. Agent Wallet spending policies on testnet

| # | Fact | Grade | Source |
|---|---|---|---|
| F3-01 | **Still mainnet only.** Docs: "Policies apply to mainnet agent wallets only." / "Spending policies require a mainnet agent wallet. Testnet is not supported." | CONFIRMED (docs) | [CPOL] |
| F3-02 | CLI 1.2.2 still rejects testnets in `wallet limit`, `limit set`, `limit reset`: "Policy writes are only available on mainnet chains. '<chain>' is a testnet." Comment: the human proxy (`/proxy/live-user/...`) "has no testnet counterpart". | CONFIRMED (source) | [CLI-1.2.2] `commands/wallet/limit-set.ts` L180–190, `limit.ts` L185, `limit-reset.ts` L97 |

### F4. Discovery API

| # | Fact | Grade | Source |
|---|---|---|---|
| F4-01 | `GET …/v2/x402/discovery/resources?limit=5` → 200, `total` 2,858, same cache header (`public, max-age=3600, stale-while-revalidate=600`). | CONFIRMED (called) | [PROBE] |
| F4-02 | **Fields unchanged** from part 1: `resource, type, x402Version, lastUpdated, accepts[…], metadata.provider{name, website, docsUrl, openApiUrl, description, category, tags}, metadata{path, method, description, mimeType, input, output, siwx, supportsVanillax402, supportsCircleGateway}`. Still no ranking/reputation field. | CONFIRMED | [PROBE] |
| F4-03 | **`category=DATA_ENRICHMENT` still 400** (enum lists only 6 categories). **`sort` still ignored** (`sort=price`, `sort=-lastUpdated` give the same alphabetical order as no sort). `scheme=upto` still 400. `type=mcp` total 0. | CONFIRMED | [PROBE] `discovery-status.txt` |
| F4-04 | **Self-serve listing wizard is not live.** Page still says "Listings are reviewed and approved manually today" and "A self-serve, automated submission flow is coming"; form `https://forms.gle/7YFzvdmMcn1JH5tF6`. | CONFIRMED (docs) | [CLIST] |

### F5. Arc Onramp Kit

| # | Fact | Grade | Source |
|---|---|---|---|
| F5-01 | Package `@circle-fin/onramp-kit` (latest `1.0.4`, modified 2026-10-15); also inside App Kit. Calls: `kit.onramp.fetchSession`, `kit.onramp.mountIframe`. Hosted widget handles KYC, payment and settlement; sessions valid 30 minutes. Needs a server-side Circle API key. | CONFIRMED (docs + npm) | [ONR], [NPM] |
| F5-02 | **Debit card, Apple Pay, Google Pay:** USDC and EURC on Arc, "in the US, UK, select EU countries, and other countries worldwide". Needs KYB in Circle Console and `referrerDomain` on the session. | CONFIRMED (docs) | [ONR] |
| F5-03 | **Bank transfer:** USDC only, "select US states and select EU countries". **Credit cards aren't supported.** | CONFIRMED (docs) | [ONR] |
| F5-04 | Providers: Transak (cards, Apple Pay, Google Pay), BVNK / Lead Bank (virtual accounts, bank transfers), Socure (KYC). Users 18+; organisations may not be non-profits. Circle charges no fee; providers may. | CONFIRMED (terms page) | [ONR-T] |
| F5-05 | **No country or state list is published** anywhere read: terms say availability "varies by region and is subject to each provider's eligibility requirements". India: not mentioned. | GAP | [ONR], [ONR-T] |
| F5-06 | Sandbox `https://onramp-sandbox.arc.io` + `https://api-test.circle.com`; production `https://onramp.arc.io` + `https://api.circle.com`. | CONFIRMED | [ONR] host requirements |

#### Design implications (F)
- Part 1 W9 is outdated: with CLI 1.2.2 an `upto` seller can charge less than the signed maximum, and the real amount is only seller-reported. Czar must cap by the authorized maximum and reconcile from chain, not from the receipt (F1-03..05).
- Use `--payment-id` (or the `payment-identifier` extension) for safe retries of a paid call (F1-06).
- Use `https://rpc.testnet.arc.io` as the testnet default to match CLI 1.2.2 (F1-09).
- Czar's own limits stay mandatory; Circle policies still can't be tested on testnet (F3-01, F3-02).
- Discovery: keep probing before paying and keep our own ranking; nothing changed (F4-01..04).
- Onramp: show "availability depends on your country" and let the widget decide; don't promise India or any country (F5-02..05). A Circle API key and KYB are needed before card/Apple Pay/Google Pay work (F5-01, F5-02).
- Watch `@x402/evm` next release for the auth-capture breaking change (F2-04).

---

## What these facts force in Czar's design

**Payments**
1. **The vault can be the payer for vanilla x402 `exact` on Arc.** It must be a deployed ERC-1271 contract (no ERC-6492) and must accept the `bytes` signature form that Circle's relayer uses (A1-12, A1-13, A1-17, A1-18).
2. **`isValidSignature` is `view` and runs again at settle time.** The vault must check the transfer fields itself and can't decrement an envelope inside that call. Record spending from `Transfer` events or a pre-reserve tx, and treat a failed `/settle` after `/verify` passed as a normal case (A1-09, A1-19).
3. **Nanopayments need an executor EOA.** The vault funds it with `depositFor` and can pull back unspent balance within ~2 s as an ERC-1271 delegate through a same-chain burn intent. That relies on Circle's API being up (A2-02, A2-09, A2-10, A2-16, A2-19).
4. **Revoking a delegate doesn't cancel intents it already signed.** Keep executor balances small and short-lived (A2-05).
5. **Show payment state as "pending" until `completed`.** Use `received` as the receipt and budget 0–16 min for settlement. Sellers are paid into their Gateway balance and need a 0.0035 USDC transfer to withdraw (A2-24 – A2-28, A2-17).
6. **Budget `upto` payments at the cap, not the expected price.** The seller alone sets the final amount, and the CLI reports it as seller-claimed. Reconcile from chain (A3-12, A3-16, F1-05).
7. **`upto` from the vault is possible in principle.** Permit2 checks ERC-1271, but the vault would need a standing Permit2 allowance, and Circle's `upto` needs a seller API key. This path is untested (A3-15, A3-17, A3-38).
8. **`batch-settlement` is an on-Arc channel standard that allows contract payers, but Circle doesn't offer it.** Using it means running a facilitator ourselves (A3-22 – A3-24, A3-18).
9. **Use a payment id (`payment-identifier` / `--payment-id`) on every paid call** so retries don't double-charge (F1-06).

**Contracts and chain**
10. **Deploy a Czar-owned ERC-8183 instance for anything with hooks or mainnet.** The Arc testnet instance is controlled by a single EOA, has never whitelisted a hook, and has no mainnet twin. Pick the EIP-reference ABI or `base-contracts` and add the `expectedBudget` check (A4-05 – A4-13).
11. **Use 0xSplits V2.2 for revenue splits** (Pull or Push, deployed on both networks). Not V1, and not the subgraph. Index split events ourselves and note that the audit predates v2.2 (A7-01 – A7-05).
12. **Passkey approvals can be verified on-chain.** The P-256 precompile at `0x100` costs 6900 gas. Treat empty output as invalid (A6-01 – A6-03).
13. **Smart-account path:** Circle Modular Wallets or any EntryPoint v0.7/v0.8 account with Pimlico, Alchemy or ZeroDev bundlers. Don't rely on one bundler. EIP-7702 is accepted but not yet seen in live use (A6-05, A6-10, A6-13, A6-15 – A6-17, A6-22 – A6-26).
14. **There is no ENS or EAS on Arc.** Keep identity claims in Czar's registry and anchor hashes on Arc. Never treat the ENS registry address on Arc mainnet as ENS (A8-01 – A8-07).
15. **Builder ownership claims combine three proofs:** a `FUNDING.json`-style file checked by Czar, a signed gist or a GitHub key for account control, and npm/PyPI provenance for "this package came from that repo". Provenance identifies a repo and workflow, not a person (A8-08 – A8-16).
16. **Run Czar's own indexer** (Ponder, or Goldsky/Envio). Page `eth_getLogs` in chunks of 10,000 blocks or fewer, and don't depend on keyless access to the mainnet explorer API (A9-02 – A9-06, A9-11).
17. **Test with pinned `arc-anvil --network arc`** from the checksummed release, not `foundryup` (A9-12 – A9-14).
18. **Pin the contract implementations Czar is tested against and alert on `Upgraded`.** ERC-8004, ERC-8183, GatewayWallet and USDC are each upgradeable by a small set of keys (A4-08, A5-12, A2-23, A1-02).
19. **Read ERC-8004 reputation only from trusted client addresses.** Feedback needs no permission from the agent (A5-07, A5-09).

**Observers**
20. **Claude Code observer = one plugin** (hooks, MCP and skills). To catch every skill use, hook both `PreToolUse:Skill` and `UserPromptExpansion`. Match `mcp__.*` and `mcp__plugin_.*`. Use async or HTTP hooks so observation never blocks the agent (B1-21 – B1-26, B1-34 – B1-38).
21. **Prefer hook payloads to transcripts.** Transcripts are plaintext, undocumented and written asynchronously. Never copy them wholesale (B1-03, B1-30, B1-33, B2-13).
22. **Hook scripts must detect which tool is running them.** Cursor runs `~/.claude/settings.json` hooks by default with its own payload shape, and every Cursor payload carries `user_email`, which counts as personal data (B3-04, B3-10).
23. **Codex onboarding must include `/hooks` trust,** repeated after every hook change. Codex `SessionEnd` gets at most 3 s, and Claude Code's gets 1.5 s by default. Flush data continuously (B2-09, B2-11, B1-10).
24. **Plugin suggestions are not a free distribution channel.** `relevance` needs an admin allowlist, and CLI hints need an official Anthropic marketplace (B1-48, B1-50).
25. **Chrome extension:**
    - Use `tabs` and `webNavigation`, not `history`.
    - Put broad capture behind optional host permissions, because adding a permission later disables the extension until the user accepts it.
    - Show in-extension consent before collecting anything; a privacy policy alone isn't enough.
    - Talk to the daemon over `connectNative`, with daemon→extension messages under 1 MB.

    (B4-03, B4-08, B4-09, B4-14, B4-15, B4-23, B4-24)
26. **Soul exports must target each tool's path:** `~/.hermes/SOUL.md` and `~/.openclaw/workspace/SOUL.md`. Keep exports under 20,000 characters and avoid text that trips Hermes's injection scanner (B5-01, B5-05, B5-06, B5-09, B5-12).
27. **Local daemon:**
    - macOS: an `SMAppService` agent, or a `launchctl bootstrap` plist.
    - Encrypted storage: `better-sqlite3-multiple-ciphers`, which has one maintainer.
    - Keychain: `@napi-rs/keyring`, not `keytar`.

    (B6-02 – B6-05, B6-12, B6-16, B6-17)

**Intelligence and safety**
28. **Assume the model can be fully hijacked.** On-chain limits and envelopes are the real spending boundary. Seller text goes in labelled, JSON-encoded tool results, gets a small-model screen, and never reaches the planner raw (C3-01 – C3-09).
29. **Redact in two layers:** gitleaks rules (MIT) for secrets, then Presidio (English-only by default) for personal data. Run trufflehog only as a separate AGPL binary and never enable its live verification on user data (C2-02 – C2-07).
30. **Embeddings:**
    - Hosted: `text-embedding-3-small` or `voyage-4-lite`.
    - Local: Qwen3-Embedding, bge-m3 or nomic, which are Apache or MIT licensed.
    - Store vectors at 1,024 dimensions or fewer.
    - Pin `sqlite-vec`, which is pre-1.0 and expects breaking changes.

    (C1-01, C1-02, C1-08 – C1-13)

**App surfaces and supply**
31. **Czar's payment MCP server uses stdio with credentials from the environment.** Approval is enforced by Czar, not the client, because the spec's human-in-the-loop rule is only a SHOULD and tool annotations are untrusted. Steps that touch credentials use URL-mode elicitation. Target MCP `2026-07-28` while still supporting older clients (D3-02, D3-07, D3-09 – D3-11).
32. **iOS approvals need a Home Screen install and a tapped permission request.** Use Declarative Web Push and keep an in-app pending-approvals list as the source of truth. Test passkeys inside the installed web app on a real iPhone before committing to a PWA-only flow (D2-01 – D2-07, D1-11).
33. **GitHub stargazer identities are gone from the API.** Use `/stargazers/history` for spike detection and weight issues, PRs, comments, forks and downloads. Keep only aggregate data (E1-01 – E1-05, E1-12, E1-15).
34. **Plugin and skill `author` fields are self-declared.** Builder identity comes from Czar's registry. Store a pinned commit `sha` or `sha256` for everything Czar pays for, and put Czar data in string-to-string `metadata` (E2-02, E2-07, E2-09).
35. **Circle spending policies are still mainnet-only, so Czar's own limits stay mandatory.** Discovery is unchanged: probe before paying and rank listings ourselves (F3-01, F3-02, F4-01 – F4-04).
36. **Onramp availability depends on country.** Let the widget decide and promise no country. KYB and a Circle API key are prerequisites (F5-01 – F5-05).

## GAPs

Everything we could not verify, grouped by item, with the searches that were run.

**A1. Smart-contract payer for vanilla x402**
- **Mainnet live run.** Not done (no mainnet funds, by rule). Mainnet rests on identical implementation bytecode (A1-02) plus the simulation (A1-11).
- **Signatures longer than 65 bytes** (Safe, Kernel, WebAuthn-style) through Circle's Facilitator aren't tested. Circle uses the bytes overload (A1-18), so length shouldn't matter on-chain, but its off-chain `/verify` might cap length. Closed source; searched `developers.circle.com/llms.txt`, `facilitator-service*.md` (7 pages), `openapi/facilitator-service.yaml`.
- **Keyless trial allowance size:** the docs give no number. One `/settle` was used for this `payTo` (`0xF201E44a8cE66C57175014e120ce73568724dB27`).

**A2. Gateway and contracts**
- **A2-G2 — Why testnet and mainnet implementation bytecode hashes differ** with the same size. Not resolved: mainnet explorer `https://explorer.arc.io/api/v2/smart-contracts/<addr>` returned HTTP 403; did not rebuild with forge.
- **A2-G3 — Whether a delegate can sign nanopayments on mainnet** (only testnet tested). Searched docs pages listed above and `llms.txt` index for "delegate" + nanopayments: no mention.

**A3. x402 protocol details (current spec version)**
- **GAP-A3-1:** Is the `x402BatchSettlement` bytecode on Arc built from the same source as the repo? Code hashes differ across chains (A3-24). Not checked: source verification on the Arc explorers, or immutables diff.
- ~~**GAP-A3-2:** Does Permit2 accept ERC-1271?~~ Resolved by the lead: yes, from source (A3-38). Still open: a live `upto` payment from an ERC-1271 vault.
- **GAP-A3-3:** No x402 spec for an "upto"-style statement from Circle about who may *dispute* an `upto` charge. Searched [CFS] how-it-works, supported-networks, facilitator-service pages; none found.

**A4. ERC-8183 (Agentic Commerce)**
- **GAP-A4-1:** Who controls `0xcBe5B97a069be3E4B5398663790731fb76aB620D` (Circle or someone else)? Not determinable from chain. Searched: Arc contract-addresses page, Arc ERC-8183 tutorial link (not opened), explorer address page (no label returned by API).
- **GAP-A4-2:** Any planned official mainnet ERC-8183 deployment. Searched: Arc docs contract-addresses page (live), WebSearch "ERC-8183 Arc mainnet deployment AgenticCommerce Circle announcement" (only third-party deployments and a press release of 2026-09-16 without ERC-8183 mention in visible text).
- **GAP-A4-3:** Which exact source/commit the Arc testnet implementation `0xA316fd…351a` was built from (EIP reference vs fork). Its ABI matches the EIP reference shape, plus a 3-argument `initialize`; source not diffed.

**A5. ERC-8004 (Trustless Agents)**
- **GAP-A5-1:** Exact block numbers of the Reputation and Validation upgrades on Arc mainnet (only "after 20,817,518" checked this session; tx hashes are in part 1 [OC]). Arc mainnet explorer `api?module=logs` returned non-JSON (Cloudflare challenge, as part 1 [OC] also saw).
- **GAP-A5-2:** Whether deployed bytecode at `0x7274…9c02` / `0x16e0…da34` / `0xdb31…7f99` is compiled from [8004C] master `b9e466c`. Only function selectors were matched, not full bytecode.
- **GAP-A5-3:** A versioned changelog for the contracts. Searched: repo tags (none), README, `UPGRADEABLE_IMPLEMENTATION.md` filename only (not read), `git log`.

**A6–A9. Arc infrastructure**
- **A6 Candide bundler on Arc.** Searched: WebFetch `https://docs.candide.dev/wallet/bundler/rpc-endpoints/` (empty page); WebSearch "Candide bundler supported networks Arc 5042002" (found only old endpoint lists and pricing). Not found.
- **A6 Live, mined EIP-7702 tx on Arc.** Blocked: the CLI faucet needs a Circle-owned wallet (`NOT_FOUND`). A 600-block scan found 0 type-4 txs. Human steps are in `[EXP]/README.md`. The user approved up to 2 testnet USDC for this through the lead, but the researcher would not move funds on a relayed approval. To close it, fund the throwaway address and run the one `cast send` in `a6-a9-arc-probes/README.md`.
- **A6 Who operates the top bundler EOAs** (`0xB1bc…ea1A`, `0x4337…`-prefixed EOAs): not established. Would need provider docs or self-identification.
- **A6 iOS and Android Modular Wallets SDK versions:** docs pages exist; versions not checked.
- **A7 Audit coverage of Splits v2.1 and v2.2:** the only V2 report in `audits/` is at commit `9dde20f6`. No v2.2 report found in the repo or in `splits-docs/security.mdx`.
- **A8 Any EAS deployment on Arc at a non-standard address:** only official lists and well-known addresses were checked.
- **A8 EAS-based "GitHub attester" services other than Human Passport:** none checked, beyond Passport, on any chain; none would be on Arc anyway (A8-07).
- **A9 Public RPC rate limit (requests/second) for `rpc.mainnet.arc.io` / `rpc.testnet.arc.io`:** not published on `rpc-endpoints.md`, `node-providers.md` or `connect-to-arc.md` (grep for "rate", "limit", "throttl").
- **A9 Mainnet explorer API access with a browser session or API key:** not tested (no key; x402 not paid).
- **A9 The Graph Arc mainnet chain ID on the networks page:** not shown in the fetched text (testnet page confirms `eip155:5042002`).

**B1. Claude Code**
- **Skill tool input schema in docs:** not documented. Searched `hooks.md`, `skills.md`, `tools-reference.md` for `Skill` input fields. Filled by own inspection only (B1-23).
- **Transcript JSONL schema:** no official spec. Searched `claude-directory.md` for "format", "schema", "stable"; nothing.
- **Max allowed `timeout` value** (other than `SessionEnd` 60 s cap): not stated in [CC-HOOKS].
- **Combined CLAUDE.md size limit value** that triggers the startup warning: not stated in [CC-MEM].

**B2. Codex CLI**
- Official docs page that states the `~/.codex/sessions/...` path: not found in the fetched pages (`hooks`, `config-advanced`, `config-reference`, `agents-md`, `mcp`; grep `sessions/`). Path is confirmed from source and local files instead.
- Exact `PermissionRequest` output shape beyond allow/deny: I did not read the full docs section; not needed for observation.

**B3. Cursor**
- **Extension API for agent activity:** not found. Tried: cursor.com/llms.txt (grep `extension`, `vscode`, `sdk`, `transcript`); `https://cursor.com/docs/mcp.md` (only `vscode.cursor.mcp.registerServer()`); `https://cursor.com/help/customization/extensions.md`; `https://cursor.com/docs/mcp/extension-api.md` (404); WebSearch "Cursor extension API vscode.cursor agent activity observe composer events extension" (no official API; results: cursor.com/docs/hooks, cursor.com/blog/typescript-sdk, forum posts).
- **Default hook `timeout` value:** docs say only "platform default".
- **Transcript storage path and format in Cursor:** not documented on the hooks page beyond `transcript_path`; subagent example path ends in `.txt`. Not verified (Cursor not installed).
- **Cursor version the docs describe:** not stated on the pages; untested locally.

**B4. Chrome extension (Manifest V3)**
- B4-10 host-permission warning text. Searched: WebFetch of `permissions-list`, `declare-permissions`, `permission-warnings`; WebSearch `developer.chrome.com host permissions warning "Read and change all your data on all websites" "<all_urls>"` — only found that text attached to `debugger`, `pageCapture`, `proxy`, `tabCapture`, `webAuthenticationProxy`.
- Whether `webNavigation` events include `url` without host permissions: docs silent (B4-05). Needs a test extension.

**B5. `SOUL.md` in Hermes Agent and OpenClaw**
- None for the asked fields. Not checked: any official spec of `SOUL.md` content format beyond prose guides (searched `docs/concepts/soul.md`, Hermes guide).

**B6. Local daemon and encrypted storage**
- Windows service options (SCM / `sc.exe`, MSIX background tasks): not searched for lack of time; only Task Scheduler checked.
- SQLCipher Community vs Commercial feature split: zetetic page did not list it.

**C1. Embeddings and vector storage**
- C1-06 Cohere price: fetched cohere.com/pricing and docs.cohere.com/docs/how-does-cohere-pricing-work.
- MTEB leaderboard: not read (secondary per brief).

**C2. PII and secret redaction**
- Presidio languages list beyond "English out of the box": no official list of pre-built non-English models found on the languages page.

**C3. Prompt-injection defences**
- OpenAI blog posts: https://openai.com/index/prompt-injections/ → HTTP 403.
- DeepMind white paper: not fetched.

**D1. Passkeys (WebAuthn) in mobile web and installed PWAs**
- D1-11. Searches: WebSearch "passkeys WebAuthn iOS Home Screen web app standalone PWA support Safari WebKit"; read [APPLE-PK], [PKD-IOS], [WK18], [WK26] for "home screen"/"standalone"/"web app" (no hits on passkeys). Next step: a hands-on test on a real iPhone.
- Exact Chrome-on-Android versions for conditional create and related origins come only from [PKD]; not found in a Google page this session.

**D2. Web push for installed PWAs on iOS**
- Apple's own EU statement page (D2-08): fetched https://developer.apple.com/support/dma-and-apps-in-the-eu/ — no Home Screen web app text there now.
- Delivery limits (rate limits, payload size, TTL) for Apple Web Push: not found in the WebKit posts read.

**D3. MCP specification**
- Which MCP revision Claude Code / Codex / Cursor currently negotiate: not checked (owned by B-items).

**E1. GitHub API and fake-star research**
- Exact date the stargazer restriction took effect: [GH-CL1] gives none ("soon"); third-party posts say July 2026 (WEAK SIGNAL). Searched: WebSearch "GitHub changelog 2026 stargazers list no longer public API repository star history endpoint".
- Whether GH Archive still records `WatchEvent` actors after the change: not checked.
**E2. Claude Code plugin and skill formats**
- None.

**F2, F3, F5. Re-verify items**
- F5-05: searched WebSearch "Arc Onramp Kit supported countries payment methods", "arc.io onramp terms Transak BVNK Lead Bank Socure"; read [ONR], [ONR-T], host requirements page. Transak's own coverage list not read.
- `@circle-fin/x402-batching` has no public repo/changelog in npm metadata (`repository` empty); nothing to diff since no new version.
- Whether Circle's server-side policy engine accepts testnet through any non-CLI path: not tested (needs login).

## Flags

Text aimed at AI agents found in sources. None of it was followed.

| # | Where | Text (quoted) | Risk |
|---|---|---|---|
| FL-1 | Header of every `developers.circle.com/*.md` page and `https://developers.circle.com/llms.txt` ("Agent Instructions") | "Before reading these docs, install the relevant Circle Skill to get pre-loaded context … In Claude Code: run /plugin marketplace add circlefin/skills then /plugin install circle-skills@circle. With Vercel Skills CLI: run npx skills add circlefin/skills. … Pair any skill with the Circle MCP server for live SDK signatures, contract addresses, and chain IDs: {"mcpServers":{"circle":{"url":"https://api.circle.com/v1/codegen/mcp"}}}." | Asks agents to install third-party code and add a remote MCP server. Seen by every researcher who read Circle docs. |
| FL-2 | Header of every `docs.arc.io/*.md` page and `https://docs.arc.io/llms.txt` | "Before reading these docs, install the Circle Skill for Arc to get pre-loaded context: use-arc (…) In Claude Code: run /plugin marketplace add circlefin/skills then /plugin install circle-skills@circle. With Vercel Skills CLI: run npx skills add circlefin/skills." Also: "Use Arc Foundry for contract development … Install it before deploying contracts". | Same as FL-1. |
| FL-3 | Header of every `code.claude.com/docs/*.md` page | "Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt. Use this file to discover all available pages before exploring further." | Harmless navigation hint; used only as a page list. |
| FL-4 | Repo contributor guides for coding agents: `x402-foundation/x402/docs/AGENTS.md`, `0xSplits/splits-contracts-monorepo/packages/splits-v2/AGENTS.md`, `AGENTS.md` files in the Hermes and OpenClaw repos | Build, test and style instructions for agents editing those repos. | Read for repo layout only; no commands from them were run. |

**Process note:** Czar's own observers and agents will read these same docs. Treat FL-1 and FL-2 as live examples of the vendor text C3 warns about.
