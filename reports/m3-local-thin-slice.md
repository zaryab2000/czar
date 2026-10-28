# M3 local thin slice report — T-050a

**Status:** PASS on CLEAN, 2026-10-28. The final objective state is `failed` with `result-quarantined`, which SCR-146 §3.3 accepts as PASS for T-050a because model calls stay off (K18/G0-16).
**Task:** T-050a / M3-d. **Decision:** D92 local Arc and D94 acceptance boundary. SCR-146 §3.3 run 1.

Before any server or merchant request, database query, or transaction, the runner requires
`env/local.toml`, loopback RPC, server, merchant, and Postgres endpoints, and a successful RPC
`anvil_nodeInfo` response. The chain ID check is additional; it does not identify local Anvil
by itself.

## Run details

- **Date and operator:** 2026-10-28T09:16:37Z, builder session on Zaryab's Mac.
- **Repository head:** `local-v1-run` at `9d88349`. That is `local-v1` with `build-v1` `662330c` merged in (sync PR #136), plus these unmerged fixes applied to the working tree:
  - `build-v1`:
    - #139 server binds `127.0.0.1`
    - #142 `czar-search` Bazaar input fields → planner `inputFields`
    - #145 opening watcher reads the Envelope `state`
    - #150 gas refill converts atomic USDC to native wei
    - this PR's runner fix (no `bundler` in the submitted notice)
  - `local-v1`:
    - #138 web port argument
    - #140 signer probe connects
    - #147 interval mining
    - #148 signer search path for the Ponder session schema
    - #149 relayer funding

  Each fix is in its own PR with failing-first evidence.
- **Command:**
  `CZAR_T050A_DATABASE_URL=postgres://postgres@127.0.0.1:15433/czar_clean_<S> fnm exec --using=22.22.0 node --experimental-strip-types --disable-warning=ExperimentalWarning apps/server/test/local-thin-slice/process-level.ts`
  `CZAR_T050A_DATABASE_URL` points at the SCR-151 session database. The runner's default, `/postgres`, isn't where the stack writes.
- **Local stack:** CLEAN, `fnm exec --using=22.22.0 process-compose -p 18090 -f ops/local/process-compose.yaml up`.
  - Chain session `mode=clean S=8c2cb4fb startBlock=0`, database `czar_clean_8c2cb4fb`.
  - `arc-anvil` v0.8.0-2 (commit `d497beea70…`, binary sha256 `fcf7b6a5…8166`; archive pin `90e3eefb…db87`).
- **Process result:** exit 0.
- **Objective ID / plan ID:** `obj_01M60WRCQXSJQ5J25FSW5TFVV3` / `pln_01M60WRD02RBAPP377RHA3P7GR`.
- **Test vault:** `0xd8F6…D7F0`.
- **Final objective state:** `failed` with `result-quarantined` (PASS).
- **Result ID:** `res_01M60WS2XZ2ZZXMAFEZ2RT4232`.

## On-chain evidence

All transactions are on the CLEAN local chain (chain ID 5042002), and every receipt has `status = success`.

| Evidence | Transaction hash / value | Result |
|---|---|---|
| Vault creation, if needed | done by the runner before approval (owner fixture) | OK |
| Test vault USDC funding | done by the runner (`FUNDING_AMOUNT` = 1 USDC) | OK |
| Owner approval / `openEnvelope` | `0x8691e0471667956085a1863a8062642534c5d2adb202a73fe88b488aaa9451bb` (block 349) | `EnvelopeOpened` |
| `Reserved` | `0xd2f0d9d3c679cd799f073a991a7db9f94dd4d6e95e0b07081b9f58a8ccc9c09c` (block 358) | `Reserved`, `StepUsed` |
| USDC `AuthorizationUsed(vault, nonce_0)` | `0x0a3bc571e8c7514f33ff194d0aed16139962d0baa39d24e7f71ac9ae06b76645` (block 362); nonce `0x0fe69b5e784ea8de0633fb326d5e4a691806a78111446b87353bc5c5fc5ea440`; authorizer is the test vault | exactly 1 log for this nonce |
| `Settled` | `0x26bd4ddc14be5a2cf75f44dcfa94e01b17d5c511fae60ca02151e4516939a3d9` (block 363) | `Settled` |
| `ReservationFinal(settledCount=1, releasedCount=0)` | `0x26bd4ddc14be5a2cf75f44dcfa94e01b17d5c511fae60ca02151e4516939a3d9` (block 363) | `settled=1, released=0` |
| `EnvelopeClosed` | `0xc3bf10ff4e7f9a69901ac8244fc2523a82902a8d1c15b381a184b6bc65ff1264` (block 367) | `EnvelopeClosed` |

The event-to-transaction mapping was read from each receipt with `@czar/vault-client`'s `czarVaultAbi`. `AuthorizationUsed` was found with `getLogs` on USDC, filtered by the nonce.

## Persisted evidence

- **`evidence_receipts` rows for the envelope:** expected 1; observed **1**.
- **`SL_RECEIPT` / vault `isValidSignature`:** `0x1626ba7e` expected; observed **verified** (`receiptVerified: true`).
- **`results` rows for the objective:** expected 1; observed **1** (`res_01M60WS2XZ2ZZXMAFEZ2RT4232`).
- **Objective failure reason:** `result-quarantined`. No model call was made, so the result can't pass acceptance and is quarantined. This is the expected pass outcome under SCR-146 §3.3.
- Signer key material was not included in this report.

## Deferred validation

- **T-050a Arc Anvil and D92 stand-in verify/settle/transfer round trip:** **PASS** (this run).
- **T-050b testnet unpaid-request-to-402 check:** **NOT RUN / DEFERRED** under D92. It requires T-121 and G0-04.
- **Live Circle/model calls, real devices, and testnet:** **NOT RUN / DEFERRED** under D92/D94.

## Notes and failures

**Startup and readiness failures before the pass**, each now fixed in the PR named:
- **Signer socket tokens missing.** The runbook step is #131 (merged). Zaryab created the items.
- **Server reachable only on `::1` (#139).** `server.listen(port, "localhost")` resolved to IPv6, and every client uses `127.0.0.1`.
- **Web exited 1 on `next dev -- --port` (#138).**
- **Stale signer socket file (#140).** The `test -S` readiness probe passed before the new signer listened, and `merchant-k10-ready` failed with `ECONNREFUSED`.
- **macOS Keychain prompt.** The keystore passphrase item needed "Always Allow" for `node`. This is an operator step.

**Objective, approval and payment failures before the pass:**
1. **`no-supplier` (#142).** The registered `czar-search` record carried `inputFields: []`, so the planner dropped the web-search step.
2. **Runner sent `bundler: "arc-anvil-test-owner"`** (fixed in this PR). The `notifySubmitted` contract allows only `circle | pimlico | alchemy | zerodev` (`openapi.yaml:632`), and the field is optional. The runner's owner approval is a plain transaction, so it now omits `bundler`.
3. **Objective stuck in `opening` (#145).** The opening watcher required `status`, but the Envelope schema field is `state`.
4. **Signer denied every reserve as `frozen` (#147).** The local chain mined only on demand, so the latest block was older than `signer.freezeStateMaxAgeSec` (30 s).
5. **Signer `signer-error` with `relation "envelopes" does not exist` (#148).** Ponder's tables are in the SCR-151 session schema.
6. **Reserve transaction rejected for lack of gas (#150, #149).** The gas refill sent 6-decimal amounts as 18-decimal wei. The relayer also needed more than 1 native unit to cover 3 USDC of refill targets.

**Missing or mismatched events:** none in the passing run.
**Receipt verification failures:** none.

**Other observations:**
- The runner's default database URL (`/postgres`) predates SCR-151 session databases. Set `CZAR_T050A_DATABASE_URL` to `czar_clean_<S>`.
- The gas refill runs on a 5-minute interval, so a fresh CLEAN stack needs up to 5 minutes before K3 has gas.
