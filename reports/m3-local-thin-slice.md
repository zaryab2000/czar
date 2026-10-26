# M3 local thin slice report — T-050a

**Status:** NOT RUN / DEFERRED pending Zaryab's explicit local-stack approval and local-key setup.
**Task:** T-050a / M3-d. **Decision:** D92 local Arc and D94 acceptance boundary.

## Run details

- Date and operator:
- Repository head:
- Command:
  `fnm exec --using=22.22.0 node --experimental-strip-types --disable-warning=ExperimentalWarning apps/server/test/local-thin-slice/process-level.ts`
- Local stack: `NOT RUN / DEFERRED`
- Process result:
- Objective ID / plan ID:
- Public test-owner address / vault address:
- Final objective state (`delivered` or `failed` with `result-quarantined`):
- Result ID:

## On-chain evidence

| Evidence | Transaction hash / value | Result |
|---|---|---|
| Vault creation, if needed | | |
| Test vault USDC funding | | |
| Owner approval / `openEnvelope` | | |
| `Reserved` | | |
| USDC `AuthorizationUsed(vault, nonce_0)` | | |
| `Settled` | | |
| `ReservationFinal(settledCount=1, releasedCount=0)` | | |
| `EnvelopeClosed` | | |

## Persisted evidence

- `evidence_receipts` rows for the envelope: **expected 1**; observed:
- `SL_RECEIPT` / vault `isValidSignature` result (`0x1626ba7e` expected):
- `results` rows for the objective: **expected 1**; observed:
- Objective failure reason, if applicable:
- Signer key material was not included in this report.

## Deferred validation

- T-050a Arc Anvil and D92 stand-in verify/settle/transfer round trip: **NOT RUN / DEFERRED** until approved.
- T-050b testnet unpaid-request-to-402 check: **NOT RUN / DEFERRED** under D92; requires T-121 and G0-04.
- Live Circle/model calls, real devices, and testnet: **NOT RUN / DEFERRED** under D92/D94.

## Notes and failures

- Startup/readiness failures:
- Objective / approval / payment failures:
- Missing or mismatched events:
- Receipt verification failures:
- Other observations:
