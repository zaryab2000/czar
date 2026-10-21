# SCR-121: Planner job-provider address source

| Field | Value |
|---|---|
| ID | SCR-121 |
| Filed by | T-045 builder, 2026-10-21 |
| Spec and section | CZ-13 §4–§6; 02 §12.2 discovery-index item fields |
| Status | Proposed |

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
