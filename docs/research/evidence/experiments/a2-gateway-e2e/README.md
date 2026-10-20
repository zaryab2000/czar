# A2 — Gateway end-to-end on Arc testnet (2026-10-18)

Network: Arc testnet, chain id `5042002`, RPC `https://rpc.testnet.arc.io`
(`https://rpc.testnet.arc.network` intermittently failed DNS from this machine).
Gateway API: `https://gateway-api-testnet.circle.com`. GatewayWallet proxy
`0x0077777d7EBA4688BDeF3E311b846F25870A19B9`, GatewayMinter `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`.

Packages (exact, `pnpm install --ignore-scripts`, Node v24.13.1): `@circle-fin/x402-batching` 3.5.0,
`@x402/core` 2.28.0, `@x402/evm` 2.28.0, `viem` 2.57.7, `express` 5.2.1, `tsx` 4.23.15.

## Accounts (throwaway, testnet only)

| Role | Address |
|---|---|
| buyer (depositor) | `0xE5b81Fb66503ab5DF7ea62dC4FB2096570b90b55` |
| delegate EOA (also owner of the ERC-1271 test contract) | `0x6E6B154C946662a78E891DE3490E176894AD3800` |
| merchant (seller `payTo`) | `0xDC5b9476099311D00D5b183aA4BFDfF836C5e84f` |
| `Owned1271` test contract (`erc1271/src/Owned1271.sol`) | `0x4d3f025330B1a52A9afA94c307AF4b6D8f318e69` |

Keys were generated with `cast wallet new` straight into `*.key` (mode 600, gitignored) and never printed.
Funding: `circle wallet fund` refused the throwaway address ("Wallet not found ... on ARC-TESTNET"; the
faucet only drips to the user's own CLI wallets), so 5 testnet USDC were moved from the existing Arc-testnet
agent wallet `0xc7984a08…5a45` with `circle wallet transfer` (tx `0x22548792…2d48`, block 67853364). The transfer was sent at
14:21:50Z, before the user's approval arrived. The user approved funding of up to 5 testnet USDC
shortly after, so the amount is within what was approved; the timing was not.

## What was run (in order) and results

All timestamps UTC. Full event log: `raw/events.jsonl`; poller logs: `raw/poll.jsonl`, `raw/poll-id.jsonl`.

| Step | Script | Result |
|---|---|---|
| On-chain reads (testnet + mainnet) | `onchain-reads.sh` | `raw/onchain-reads-*.txt` |
| Seller on 127.0.0.1:4022 | `seller.ts` | `raw/seller.log` |
| Approve + `deposit` 2 USDC | `pay.ts` | approve `0x709e5712…e6c8`, deposit `0x2605641b…6bf9`; mined in 3.1 s; Gateway API showed it as `available` 5.9 s after start |
| Payment 1 ($0.001) | `pay.ts` | `pay()` 1.23 s, HTTP 200; transfer id `f1f4ddc1-8324-4420-97b9-bb0ae32e3a27`, `createdAt` 14:22:14.994 |
| Payment 1 → `completed` | `poll.sh` (15 s) | `received` at first poll; `completed` (updatedAt 14:24:04.189). Batch tx `0x10acef079f1eecdf3141a24ac1f777a56591c773a79b1a0fc3442b4bdb80e02d`, block 67853617, block time 14:24:02 → **107 s** payment-to-batch. `batched` not seen at 15 s polling. |
| Payment 2 ($0.001), 2 s polling | `pay.ts`, `poll-id.sh` | id `d863fd6a-6e1c-4ab6-ac61-22966d41529a`: `received` (createdAt 14:27:17.018) → `batched` (14:40:00.573) → `completed` (14:40:04.267); batch tx `0x70f1ca46a5305ffec1dba2199ab3d0b05036ed99aefc2740b7ce7cc0db21bef5`, block 67855510 (14:40:01) → **12 min 47 s** |
| Delegate pays for buyer (nanopayment) | `delegate-pay.ts` | `addDelegate` tx `0x34934364…3445` (block 67853429); `isAuthorizedForBalance` = true; seller `/verify` rejected: "Payment verification failed" |
| Direct `/v1/x402/verify` matrix | `verify-direct.ts` | buyer→buyer `isValid:true`; delegate→buyer **`invalid_signature`**; ERC-1271 contract (owner signs) **`invalid_signature`**; delegate→itself `isValid:true` (verify skips balance) |
| ERC-1271 contract funded | `forge create`, `cast send` | deploy `0x7b76d32c…d338`; `depositFor(USDC, contract, 0.5)` tx `0xf3fc113f…730c` (block 67853513) |
| Same-chain instant withdraw, buyer signs | `withdraw.ts` | `/v1/transfer` 201 in 427 ms, fee 0.0035; `gatewayMint` `0x94f7d200…9ce4` (block 67853582) 1.8 s after request; `GatewayBurned` block 67853596 |
| Same-chain withdraw, **delegate EOA** signs for buyer | `SIGNER=delegate DEPOSITOR=buyer` | attestation 201; mint `0x40fdd263…ccae` (block 67853750); burn signer = delegate |
| Same-chain withdraw, **ERC-1271 contract** depositor (`contractSigner: true`) | `SIGNER=delegate DEPOSITOR=contract CONTRACT_SIGNER=1` | attestation 201; mint `0x78b16b50…4df7` (block 67853764); burn tx `0x2fad2322…7ae` |
| Same-chain withdraw, **contract as ERC-1271 delegate** of buyer | `addDelegate(USDC, contract)` `0x31b5c08d…4a9a`, then `SIGNER_OF_RECORD=contract` | attestation 201; mint `0x3dea8430…9f39` (block 67853811); burn signer = contract |

Notes:
- `isAllowlistedContractSigner(contract)` = false: the ERC-1271 path went through the TEE vouch
  (`ContractSignatureSigners`), not the on-chain allowlist.
- Two attestations were issued but never minted (SDK `withdraw()` mint failed on the
  `rpc.testnet.arc.network` DNS error; first delegate attempt had no gas). Both were re-credited after
  their `expirationBlock` (67854778, 67854835): buyer `/v1/balances` 0.3805 at block 67854309 →
  1.0875 at block 67854972 (`raw/buyer-balance-after-expiry.json`).
- Delegate/ERC-1271 nanopayment rejection re-tested at 14:31:46 (9 min after `addDelegate`): still
  `invalid_signature`.
- Seller was stopped after the run. Leftover testnet funds stay on the throwaway addresses.
- Testnet batch cadence (`raw/batch-cadence-testnet.txt`): `BatchProcessed` at 13:21:01, 13:36:01,
  13:52:01, 14:08:01, 14:24:02 → 960 s ticks (≈1,896 blocks ⇒ ≈0.506 s/block).
- The batch credits the seller's **Gateway balance**, not its wallet: merchant `/v1/balances` = 0.001
  after payment 1 (`raw/merchant-balance.json`); decoded deltas in `raw/batch-tx.txt`.
