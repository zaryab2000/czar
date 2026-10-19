# Security and testing (spec 03)

- **Date:** 2026-10-18. **Status:** draft. Covers `CzarVault`, `CzarVaultFactory`, `OpenEvidenceLog`, the job adapter, `CzarJobEscrow` (pre-mainnet), `BuilderEscrow` and `RecipeSplits` (Phase 2).

## 1. Threat model per contract (spec 01 §13 → the check that stops it)

| Threat (spec 01 §13) | Contract | What the attacker tries | Check that stops it |
|---|---|---|---|
| Model hijacked / agent key leaks (K3) | `CzarVault` | pay an unapproved payee | `reserve`/`openJob` require a Merkle proof under `payeeRoot` (02 §5.3); `isValidSignature` ties `to` to the reservation payee (§6.1 step 5) |
| | | inflate an amount | `value ≤ unitAmount`, `unitAmount × count ≤ stepCap ≤ maxStepAmount`, cap check (INV-1, INV-5) |
| | | sign many authorizations | nonce derived per index, `index < count`, USDC nonce single-use (§6.5 proof) |
| | | open envelopes freely | agent-opened envelopes need `cap ≤ autoLimit − usedInPeriod` (INV-9) |
| | | route a pullback elsewhere | `GATEWAY_BURN` fixes `destinationRecipient = vault` (INV-6) |
| | | over-fund a pocket | `funded ≤ cap × pocketCapBps / BPS` and delegate check (INV-7) |
| | | name itself evaluator | `openJob` uses `vault.evaluator` only (JOB-2) |
| | | withdraw | no agent withdraw path (INV-3) |
| Server compromised | all | all of the above plus evidence forgery under K8 | same bounds; guardian pause (`factory.guardianPaused()`) read on every spending path (INV-4); evidence forgery is detectable by recompute (SL §8.5) and moves no funds |
| Pocket key leaks (K4) | `CzarVault` | drain the pocket | loss bounded by `outstanding` ≤ 25% of cap; `requestPullback` immediately; `removeDelegate` by the attacker only blocks the trustless path, not the bound |
| Malicious merchant | `CzarVault` | settle without delivering | bounded per index by `unitAmount`; expiry release of unused indices; evidence (off-chain) |
| | | settle `upfront` early | routing policy; the vault bound is the same |
| Poisoned catalog text | none on-chain | — | off-chain reader/planner split (spec 01 §13.1) |
| Malicious observer input | none on-chain | — | off-chain; the vault only sees hashes |
| Dependency upgraded against Czar | `CzarVault` | USDC changes ERC-1271 semantics; Gateway changes delegate rules; ERC-8183 changes fees | the vault never trusts a dependency for accounting: settle reads `authorizationState`, pullback reads `isTransferSpecHashUsed`, fund reads fees in the same tx; indexer `Upgraded` alerts halt new actions; worst case per path bounded as spec 01 §13 |
| Claim server lies (D17) | `BuilderEscrow` | release to a wrong wallet | timelocked, public, cancellable release (builder-escrow spec) |
| Phished user approval | `CzarVault` | user approves a bad plan | on-chain bound = that envelope's cap; `userMax` per category; freeze |
| Selection Layer operator misconduct | `OpenEvidenceLog` | drop or reorder evidence | per-publisher hash chain, inclusion tickets (off-chain), anyone can publish |
| Reentrancy | `CzarVault`, escrows | re-enter during `depositFor`, `transfer`, `fund`, `gatewayMint` callbacks | `ReentrancyGuardTransient` on every externally-calling function; checks-effects-interactions; USDC and Gateway make no callbacks to the vault except the `view` `isValidSignature` |
| Griefing with `settle`/`finalize` by anyone | `CzarVault` | call early or with wrong indices | `finalize` requires `now > validBefore`; indices validated; loops bounded by `FINALIZE_CHUNK` |
| Griefing `confirmPullback` | `CzarVault` | confirm a non-minted hash | `isTransferSpecHashUsed` must be true |
| Replay of signed messages | `CzarVault` | reuse an `AutonomyRaise` or `OwnerAction` | nonces + deadlines; chainId and vault address in the domain (02 §6.1) |
| Signature malleability | `CzarVault` | high-s variants | low-s rule, `v ∈ {27,28}` |
| Front-running `fund` with a raised budget | adapter | provider raises the budget after the vault read it | read and `fund` in one transaction (JOB-1); Czar instance has `expectedBudget` |
| Bytecode substitution for new users | factory | admin registers malicious vault code | 48 h timelock, published `creationCodeHash`, existing vaults unaffected (FAC-3, FAC-4) |

## 2. Invariant list

| Id | Where defined |
|---|---|
| INV-1 … INV-11 | `czar-vault.md` §11 |
| FAC-1 … FAC-4 | `czar-vault-factory.md` §9 |
| JOB-1 … JOB-4 | `job-escrow-adapter.md` §8 |
| OEL-1 … OEL-5 | `open-evidence-log.md` |
| CJE-1 … CJE-3 | `czar-job-escrow.md` §9 |
| BE-1 … BE-5, RS-1 … RS-3 | `builder-escrow-and-recipe-splits.md` |

Each is written so a Foundry `invariant_*` test can assert it after every handler call.

## 3. Test plan

### 3.1 Unit tests (per function and per error)

- One test per row of every function table and one per custom error, including the role matrix (`czar-vault.md` §2): every (role × function) cell has a test that expects success or the exact error.
- `isValidSignature`: for each kind and the fallback: happy path; every numbered check failing one at a time (wrong nonce, wrong index, index ≥ count, done bit set, wrong `to`, `value > unitAmount`, `validAfter != 0`, wrong `validBefore`, expired, frozen, paused, wrong digest, wrong signer, high-s, bad `v`); never reverts; returns `0xffffffff` for a bare 65-byte signature against an unregistered digest.
- `GATEWAY_BURN`: each `TransferSpec` field mutated → `INVALID`; cross-chain domain → `INVALID`; `Cancelled` record → `INVALID`.
- Digest reproduction: the five vectors in 02 §6.4 must be reproduced on-chain (`derivedNonce`, USDC digest, burn digest, `transferSpecHash`, `AutonomyRaise`, `OwnerAction`).
- D30: WebAuthn fixtures (a real assertion captured from a test passkey) verified through `executeOwnerAction`; wrong `rpIdHash`, missing UV, wrong challenge → `InvalidPasskeyAssertion`; precompile gas at exactly 6,900 (A6-02).

### 3.2 Fuzz tests (reservation and envelope math)

- Random sequences of `reserve`, `settle`, `finalize` with random `count`, `unitAmount`, indices and simulated USDC nonce consumption; assert INV-1, INV-5, INV-8 and that `reserved` returns to 0 after all reservations are final.
- Random pocket fund / pullback / cancel / confirm sequences; assert INV-7 and that `committedTotal` matches the recomputed sum (INV-2).
- Earned-autonomy raises across period boundaries; assert INV-9 and one raise per period.
- Rounding: `cap × pocketCapBps / BPS` and raise steps never exceed caps by a unit.

### 3.3 Foundry invariant tests

- Handlers: owner, agent, autonomy, guardian, a USDC mock that honours ERC-1271 exactly like `NativeFiatTokenV2_2` (nonce map, `validBefore`, pause, blacklist), a Gateway mock (`depositFor`, `isAuthorizedForBalance`, `isTransferSpecHashUsed`), an ERC-8183 mock for both ABIs.
- Assert every INV/FAC/JOB id after each call. Use `arc-anvil --network arc` as the test node so native-USDC semantics (18/6 decimals, zero-address rule, P-256) are real (A9-13, A9-14).

### 3.4 Fork tests (pinned `arc-anvil`, Arc testnet fork)

- Install `arc-foundry` v0.8.0-2 from the checksummed release tarball, never `foundryup` or `foundry-toolchain` (A9-12, A9-13). Fork `https://rpc.testnet.arc.io` at a recorded block.
- **USDC:** deploy the real vault, fund it, sign a `USDC_3009` envelope signature, call the bytes overload `0xcf092995` of `transferWithAuthorization` from a relayer address as Circle's relayer did (A1-18); assert the transfer, `AuthorizationUsed`, and `authorizationState == true`; then `settle` and `finalize`. Also the `v,r,s` overload is **not** used (envelope signatures are longer than 65 bytes).
- **GatewayWallet:** `grantPocketGas`, pocket `addDelegate(USDC, vault)`, `fundPocket` → `isAuthorizedForBalance` true and `Deposited` event (A2-02, A2-04); negative test: skip `addDelegate` → `DelegateNotSet`.
- **Pullback (AR-5):** build the burn intent from a `PullbackRequested` event, sign with the agent key in the `GATEWAY_BURN` envelope, run the vault's `isValidSignature` through `eth_call` exactly as Circle's TEE would (A2-08), then on the live testnet (not the fork) `POST /v1/transfer` with `contractSigner: true` and mint; assert `isTransferSpecHashUsed` and `confirmPullback`. This is the one test that needs real testnet funds (≤ 1 USDC) and Zaryab's explicit approval; the read-only parts run in CI.
- **ERC-8183 (Circle instance):** `openJob` → `JobCreated`; a test provider `setBudget`; `fundJob` reads budget and fees (both 0, A4-07) and funds; test evaluator `complete` and `reject`; `claimRefund` after expiry by an unrelated address (EIP reference, `erc-8183.md` line 690).
- **AR-3 `/verify` check:** from the fork-deployed vault address, deploy the same bytecode on live testnet (read-only otherwise), build a `PaymentPayload` with the envelope signature and call Circle's `/verify` keyless (A1-15, costs nothing). Record `isValid` and the reason. If rejected, set `vaultSignatureMode = digest` (02 §6.3.4) and repeat with `reserveWithDigests` + 65-byte signature.
- **Mainnet simulation only:** `eth_call` with state overrides against `rpc.mainnet.arc.io` for the USDC path (as A1-11); no mainnet transaction.

### 3.5 Gas tests

- `forge snapshot` on every function in `czar-vault.md` §13; CI fails on > 5% regression; the measured table feeds the routing parameters (`pocketThreshold(n)`).

### 3.6 Static analysis and lint (pinned in CI)

- `slither` (pin version in the build plan) with triage file; `forge fmt --check`; `solhint` optional; `cargo-deny`-style licence check for OpenZeppelin (MIT).
- Custom Slither detectors or grep checks: no `tx.origin`, no `block.prevrandao` (p1-A7), no unbounded loops, every external call behind the reentrancy guard, every function has a custom error path tested.

## 4. Deployment

| Step | Detail |
|---|---|
| 1 | Deploy `OpenEvidenceLog` through Arachnid CREATE2 (`0x4e59b44847b379578588920cA78FbF26c0B4956C`, A9-15) with a fixed salt; same address on both networks. |
| 2 | Deploy `CzarVaultFactory` through CREATE2 with constructor args: network immutables (USDC, GatewayWallet, GatewayMinter, domain 26, job escrow address and kind), initial `defaults` (agent, autonomy, evaluator addresses from KMS), guardian, admin (Ownable2Step pending). |
| 3 | Admin accepts ownership; registers `creationCodeHash` of `CzarVault` version 1 (no timelock for the first version). |
| 4 | Publish bytecode hashes (`creationCodeHash`, runtime code hash of a reference vault) and verified sources on the Arc explorer (testnet API keyless, A9-10; mainnet needs a key, A9-11). |
| 5 | Pre-mainnet: deploy `CzarJobEscrow` proxy with Czar admin timelocks; then a new factory version whose immutables point to it. |
| 6 | Phase 2: `BuilderEscrow`, `RecipeSplits`. |
| 7 | Indexer: subscribe to `Upgraded(address)` on USDC proxy `0x3600…0000` (admin slot per A1-01), GatewayWallet and GatewayMinter proxies, ERC-8183 proxy, ERC-8004 registries (A5-11); page `eth_getLogs` ≤ 9,999 blocks (A9-06); halt the affected path on any event. |

Constructor arguments are recorded per network in the build plan; `maxFeePerGas ≥ 20 Gwei` on every deployment transaction (p1-A6).

## 5. Pre-mainnet checklist

- [ ] External audit of `CzarVault`, `CzarVaultFactory`, adapter and `CzarJobEscrow` configuration (and the deployed base-contracts commit).
- [ ] A2-G2: explain the GatewayWallet mainnet/testnet code-hash difference (rebuild from source at the verified commit, or obtain Circle's confirmation).
- [ ] A2-G3: prove a delegate/contract burn intent on mainnet with a minimal amount after audit, or keep the pocket path testnet-only at launch.
- [ ] AR-4: `cast call` `authorizationState` on mainnet USDC with a known nonce (simulation already shows it, A1-11).
- [ ] AR-3: rerun the `/verify` check against mainnet (`network: eip155:5042`) with a mainnet-deployed vault and no funds at risk.
- [ ] AR-5: live pullback on mainnet with ≤ 1 USDC.
- [ ] `Upgraded` alerts live for every pinned dependency; runbook for halting each path.
- [ ] Gas table measured on mainnet; routing parameters updated.
- [ ] Guardian and admin keys in separate custody; pause drill performed.
