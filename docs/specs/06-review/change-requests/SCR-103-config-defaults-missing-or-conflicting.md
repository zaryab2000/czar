# SCR-103: Seven named parameters have no default, and seven are defined twice or inconsistently

| Field | Value |
|---|---|
| ID | SCR-103 |
| Filed by | Czar builder (tier 1), 2026-10-19 |
| Spec and section | `docs/specs/04-components/` "Named parameters" sections; `shared/cross-cutting.md` §3.2 |
| Status | Open |

## Problem
- T-004 needs a default, unit and reason for every parameter named in spec 04. These have no default anywhere in the specs: `evidence.leaderLockKey`, `evidence.verifyGuideUrl`, `fetch.localMerchantOrigins`, `indexer.startBlock`, `indexer.rpcErrorAlertPerMin`, `merchants.extractAllowlist`.
- Key names the specs imply but never spell out (registered as written below, flagged `derivedKey`): `models.planner.timeoutMs`, `models.drives-helper.timeoutMs`, `models.refusal-classifier.timeoutMs` (from `models.<name>.timeoutMs`); `drives.minutes.placeholder`, `drives.minutes.repeated-error`, `drives.minutes.agent-refusal` (from `drives.minutes.*`).
- Values defined twice or inconsistently:
  1. `models.userMonthlyTokens`: `cross-cutting.md:163` gives "≈ 4.4 M tokens" and "(hard cap 6 M)"; the registry uses 6,000,000.
  2. `daemon.compileAt` (`local-observers-and-daemon.md:310`) and `soul.compileCron` (`local-soul-and-drives.md:166`) name the same 02:00 schedule twice.
  3. `planner.probeTimeoutMs` 5,000 (`server-planning-and-payment.md:165`) and `selection.probeTimeoutMs` 2,000 (`server-acceptance-evidence-selection.md:641`), while CZ-13 says it uses CZ-18's 2 s probe.
  4. `planner.modelTimeoutMs` 20,000 duplicates the P-03 timeout `models.<name>.timeoutMs` (`cross-cutting.md:166`).
  5. The secret-name denylist in `cross-cutting.md:80` has five fragments; `server-autonomy-roi-keys.md:351` omits `seed`. The loader uses all five.
  6. `evidence.pocketReceiptBeforeDestroyMs` (`server-acceptance-evidence-selection.md:507`) explains itself by K4 destruction at close, which RV-004 superseded.
  7. `planner.capabilityToTaskClass` (`server-planning-and-payment.md:146`) is a partial table ending in "…".
- `drives.defaultHourlyValue` 40 is taken from an "e.g. $40/h" example, not a stated default.
- The environment-file format (`local`, `testnet`) is not specified; the loader takes a flat JSON object of key → value.

## Evidence
- `packages/config/src/registry.ts` entries with `noDefault`, `derivedKey` or `partial`; each cites its spec line.

## Proposed change
- Give a default (or state "required, per environment") for each key in the first list.
- Spell out the derived key names, pick one source for each duplicated value, and complete the partial table.
- State the environment-file format in `docs/specs/04-components/shared/cross-cutting.md` §3.2.

## Affected tasks
- T-004 (built; affected keys flagged), T-030 (`indexer.startBlock`), T-043/T-051 (`fetch.localMerchantOrigins`, `merchants.extractAllowlist`), T-057, T-045, T-068

## Decision
- 
