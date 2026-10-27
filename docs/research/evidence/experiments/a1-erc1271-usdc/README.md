# Experiment A1: ERC-1271 contract as a USDC EIP-3009 / x402 payer on Arc

- **Date:** 2026-10-18
- **Question:** Can a deployed smart contract (ERC-1271) be the `from` of a USDC `transferWithAuthorization` on Arc, and will Circle's Facilitator Service accept and settle it?
- **Networks:** Arc testnet (chain 5042002, `https://rpc.testnet.arc.io`) and Arc mainnet (chain 5042, `https://rpc.mainnet.arc.io`, read-only `eth_call` only).
- **Keys:** `owner.key` and `seller.key` are throwaway keys made with `cast wallet new` (mode 600, gitignored). No real wallet, no mainnet funds.

## Files

| File | What it is |
|---|---|
| `src/OwnerSig1271.sol` | Minimal ERC-1271 account. `isValidSignature(hash, sig)` returns `0x1626ba7e` when the first 65 bytes of `sig` recover to `owner` (low-s only). |
| `src/SettleProbe.sol` | Simulation helper. Calls the bytes overload of `transferWithAuthorization` and returns balances before/after and `authorizationState`. Used only through `eth_call` code overrides. |
| `sim.sh` | Read-only simulation: `eth_call` with state overrides against the live USDC contract. |
| `x402-flow.mjs` | Local x402 v2 seller (`127.0.0.1:4021`) + buyer. The seller calls Circle's Facilitator `/verify` (and `/settle` in `MODE=settle`) with a keyless `Facilitator-Seller-Proof`. |
| `live.sh` | Live testnet run: deploy the ERC-1271 account, fund it, settle one authorization on-chain, then pay the local seller through the Facilitator. Needs ≥ 1.5 testnet USDC on `owner.addr`. |
| `raw/` | Raw outputs of every run. |

## Run 1: simulation against real USDC (done)

`./sim.sh` (testnet) and `./sim.sh https://rpc.mainnet.arc.io 5042` (mainnet). The ERC-1271 account code is placed at `0x…0A1A11` with a code override, its `owner` slot set to the throwaway owner, and its native balance set to 10 USDC. Everything else, including the USDC proxy, the `NativeFiatTokenV2_2` implementation, the linked `SignatureChecker` library and Arc's native-coin precompiles, is the real on-chain code at the stated block.

| Test | Testnet (block 67853550) | Mainnet (block 26616147) |
|---|---|---|
| T0 `isValidSignature` on the account | `0x1626ba7e` | `0x1626ba7e` |
| T1 bytes overload `transferWithAuthorization(…,bytes)`, contract `from`, owner signature | success: payer 10,000,000 → 9,000,000; payee 0 → 1,000,000; `authorizationState` = true | same |
| T2 same, signature from a different key | revert `FiatTokenV2: invalid signature` | same |
| T3 `v,r,s` overload, contract `from`, owner signature | success (`0x`) | same |
| T4 owner signature, but the payer address has no code (EOA path) | revert `FiatTokenV2: invalid signature` | same |
| T5 contract payer with zero balance | revert `ERC20: transfer amount exceeds balance` | same |

Raw: `raw/sim-testnet.txt`, `raw/sim-mainnet.txt`.

**What this proves:** the deployed USDC code on both networks calls the payer contract's `isValidSignature` when `from` has code, accepts its answer for both overloads, and moves the funds. Run 3 confirms the testnet case with mined transactions. Mainnet is shown by simulation only.

## Run 2: Facilitator `/verify` controls (done, keyless trial, Arc testnet)

`/verify` doesn't consume the keyless-trial allowance (Circle OpenAPI `facilitator-service.yaml`, `VerifyPayment`).

| Control | Payer | Result |
|---|---|---|
| C1 | owner EOA, unfunded | HTTP 200 in 528 ms, `isValid:false`, `invalidReason:"insufficient_funds"`: the signature passed and the funds check failed |
| C2 | `0xd80fe1aD38eC902df4Db294795D7CD18163A23EE` (the owner's nonce-0 `CREATE` address, where `live.sh` will deploy the account; no code yet), signed by owner | HTTP 200 in 476 ms, `isValid:false`, `invalidReason:"invalid_exact_evm_payload_signature"` |

Raw: `raw/verify-C1-eoa-unfunded.txt`, `raw/verify-C2-undeployed-contract-address.txt`.

C2 is the "before" half of a before/after test. The "after" half is in Run 3.

## Funding

- `circle wallet fund --address 0x4015D942267415f057D2A4735A82DD38Eb55D264 --chain ARC-TESTNET --output json` failed with `Wallet not found for address … on ARC-TESTNET.` (`raw/faucet-owner.json`). The CLI faucet only funds the logged-in user's own Circle wallets.
- With the user's approval (relayed by the research lead), I made one transfer of 2 testnet USDC from the user's Circle testnet wallet `0xc7984a08521f22cf3d2e0972d529258ca5d75a45` to the throwaway owner, using `circle wallet transfer … --token 0x3600…0000 --chain ARC-TESTNET`.
  - Result: tx `0xf57309d49e8cc1c82f97c70ae3761d8ca492ccd105538781941e8a0418de1e0b`, block 67854237, `state: COMPLETE` (`raw/fund-transfer.json`). The CLI wallet sent it as an ERC-4337 UserOp through EntryPoint `0x0000000071727De22E5E9d8BAf0edAc6f37da032`.
  - A first attempt with a non-UUID `--idempotency-key` was rejected with `Service returned error 400: Invalid request body.`, and nothing was sent.

## Run 3: live testnet (done, 2026-10-18 14:29:33Z to 14:29:56Z)

`./live.sh` → `raw/live-run.txt`, `raw/live-deploy.json`, `raw/live-fund.json`, `raw/live-direct-3009.json`, `raw/live-x402-verify.txt`, `raw/live-x402-settle.txt`, `raw/live-tx-summary.txt`, `raw/live-facilitator-settle-calldata.txt`.

| Step | Tx | Block (time UTC) | Result |
|---|---|---|---|
| Deploy `OwnerSig1271(owner)` | `0xe147acdb1baf831a8aa352a732fb3dd9356a13cbf46f4877f1492819912bacda` | 67854276 (14:29:36) | account `0xd80fe1aD38eC902df4Db294795D7CD18163A23EE` (753 bytes of code), gas 241,176 |
| Fund account with 1 USDC (`transfer`) | `0xfae95790c161ef6659272f00ff78b6f8595b5160a514b77874a51cd26a0a2454` | 67854283 | balance 1,000,000 |
| Direct on-chain `transferWithAuthorization(…,bytes)` (`0xcf092995`), `from` = account, relayer = owner EOA, 0.1 USDC → seller | `0x8f5cd4f148c60b2635b3ef606dac7cc8568bb19c6a9818ea29e1c1d3dbf5ef51` | 67854293 (14:29:45) | status 1, gas 121,739; account 1,000,000 → 900,000; seller 0 → 100,000; `authorizationState` = true; send to receipt 3,487 ms |
| Local x402 seller → Facilitator `/verify`, contract payer (`MODE=verify`) | none | — | HTTP 200 in 718 ms, `{"isValid":true,"payer":"0xd80f…23ee"}` |
| Local x402 seller → `/verify` then `/settle` (keyless trial) | `0x78d909c8f9b9ac6827b616d25a1a1070078390492677dc8672597db41c06e66d` | 67854309 (14:29:53) | `/verify` 200 in 500 ms `isValid:true`; `/settle` 200 in 2,621 ms `{"success":true,…,"amount":"100000"}`; buyer got HTTP 200 with a `PAYMENT-RESPONSE` header |

Facts about the Facilitator's settle tx (`raw/live-tx-summary.txt`, `raw/live-facilitator-settle-calldata.txt`):
- Sent by Circle relayer `0x07C2DA3b4189747a34bBD07a6f9f4B78992CfF11` to USDC, selector `0xcf092995`. That is the **bytes** overload, even though the signature is 65 bytes (`…1c`, v = 28).
- Gas used: 96,739.
- Logs:
  - `AuthorizationUsed` (`0x98de5035`) from `0x3600…`
  - a native system `Transfer` from `0xffff…fffe` of `0x016345785d8a0000` = 0.1 × 10¹⁸
  - an ERC-20 `Transfer` from `0x3600…` of `0x186a0` = 100,000
- Final balances: account 800,000; seller 200,000.

The C2 control above used this same address before deployment (`invalid_exact_evm_payload_signature`). After deployment the same kind of call returned `isValid:true`.

## Reproduce

```bash
forge build          # solc 0.8.30, see foundry.toml
./sim.sh             # testnet simulation
./sim.sh https://rpc.mainnet.arc.io 5042
npm install --ignore-scripts   # viem 2.57.2
MODE=verify node x402-flow.mjs                                  # C1
PAYER=$(cat predicted-wallet.addr) MODE=verify node x402-flow.mjs  # C2
./live.sh            # needs funded owner.addr
```
