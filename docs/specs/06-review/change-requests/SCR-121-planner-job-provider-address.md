# SCR-121: Planner job-provider address source

| Field | Value |
|---|---|
| ID | SCR-121 |
| Filed by | T-045 builder, 2026-10-21 |
| Spec and section | CZ-13 §4–§6; 02 §12.2 discovery-index item fields |
| Status | Accepted (Zaryab, 2026-10-21; architect ruling under his delegation) |

## Problem

CZ-13 requires a job `PayeeLeaf` and `openJob` provider address for any listed
ERC-8183 provider. The T-045 `ServiceDirectory` port names the discovery-index
resource, `accepts[]`, and `extensions.czar` fields, with `listedPrice` and
`jobDurationSeconds` for jobs, but does not identify the provider's on-chain
address. The §12.2 item fields and `CapabilityCard` also do not carry that
address. An x402 `accepts[].payTo` is a merchant payment recipient and is not
defined as the ERC-8183 provider address.

## Decision requested

Specify a trusted source for the ERC-8183 provider address in the internal
service-directory item used by CZ-13. Keep the address server-side and require
it for `erc8183-job` payee leaves; do not infer it from an x402 `payTo`.

## Affected tasks

- T-045 (planner core)
- T-048 (job payment loop)

## Decision

- 2026-10-21: **Accepted.** The ERC-8183 provider address comes only from the provider's own proof of control, never from an x402 `payTo`:
  - The service-directory record carries `providerAddress` = the address that completed the SL wallet claim (`claim.status` `wallet-verified` or `erc8004-claimed`, SL §5.3), or, for Czar's own providers (`source: czar-registered`, T-108), the address recorded in Czar's key file.
  - CZ-13 plans a job step only for such providers; any other record with `providerAddress` is ignored for jobs.
  - Applied to CZ-13 §5 step 6b and in `apps/server/src/planner` with the test "never plans a job for a provider address the provider has not proven (SCR-121)".
