# SCR-126 §1 signer process report

## Delivered

- `src/main.ts` opens the guarded local keystore using the keychain passphrase, creates the signer
  with the PostgreSQL audit sink, starts gas refill, and starts the Unix socket server.
- `src/socket.ts` loads the `server`, `merchants`, and `relayer-jobs` tokens from their keychain
  entries, checks tokens with constant-time comparison, enforces the configured caller map, and
  serves `sign` and `createPocketKey` over a user-owned socket with mode `0600`.
- `createSignerClient({ socketPath, service })` reads its service token from the keychain and exposes
  the in-process signer calls.
- Denied socket authentication and caller checks write redacted `kms_denied` rows.

## Verification

- `fnm exec --using=22.22.0 pnpm --filter @czar/signer test` — 84 passed, 1 skipped.
- `fnm exec --using=22.22.0 pnpm -r typecheck` — passed across 14 workspace packages.
- `fnm exec --using=22.22.0 pnpm lint` — passed.
- The local-chain signer test was skipped; this task's socket tests use the existing signer test
  harness and do not start an Arc node or read real keychain entries.

## Integration boundary

`startSignerProcess` takes the signer `Projection`, network deployment values, transaction preparer,
PostgreSQL query executor, refill RPC functions, and the policy-to-service caller map as dependencies.
This repository has no production composition source for those values. SCR-126 §1 does not identify
their source or specify the map from `server` to internal CZ caller IDs. The process wiring is
implemented and tested with injected dependencies; production launch still needs those adapters and
an approved caller map. No deployment values or policy ownership mapping were inferred here.
