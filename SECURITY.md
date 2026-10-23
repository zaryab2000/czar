# Security review guidance

This file summarizes existing requirements for code review. It does not assert that controls
are implemented, replace specifications, or certify an audit. Distinguish requirements,
implementation evidence, and unverified gaps.

## Canonical threat model and invariants

Read affected task references and the relevant sections of:

- `docs/specs/01-system-architecture/system-architecture.md`: spending accounting,
  privacy, keys, and threats, especially sections 10, 11, and 13.
- `docs/specs/03-smart-contracts/security-and-testing.md`: threat matrix, invariant index,
  regression tests, and deployment gates.
- `docs/specs/03-smart-contracts/czar-vault.md`: roles, signatures, accounting, invariants,
  and binding section 15; its canonical ABI is `interfaces/ICzarVault.sol`.
- Other affected contract specifications and interfaces in that directory.
- `docs/specs/04-components/shared/cross-cutting.md`: safeFetch, logging, errors, and models.
- `docs/specs/04-components/shared/ai-prompts.md`: model roles and untrusted input handling.
- Affected component specifications and approved SCRs.

## Assets, attackers, and boundaries

Protect user USDC, approved payment intent, signer authority, replay protection, private
local content, credentials, user isolation, and truthful payment/evidence records.
Consider malicious merchants, compromised planners/agents, stolen operational keys, forged
requests, hostile URLs, poisoned catalogs, malformed model replies, and dependency failures.
Do not assume a trusted server makes contract authorization checks unnecessary.

Review changed crossings from owner/passkey to app/server; server to signer/vault;
contracts to USDC/Gateway/job escrow; merchant to fetch/screen/reader; model outputs to
payment decisions; daemon to server; and chain events to indexer/read APIs.

## Contracts, signer, and payments

- Enforce the canonical role matrix and owner-action checks. Agents cannot acquire owner
  withdrawal or unrestricted approval authority.
- Bind signatures to kind, payload, nonce, deadline, chain, and verifying contract. Reject
  replay, wrong-domain signatures, malformed signatures, and unapproved payees/amounts.
- Preserve envelope, step, reservation, pocket, job, and autonomy limits across concurrency,
  retries, expiry, freeze/pause, settlement, refund, and recovery.
- Use USDC six-decimal integer API amounts and specified on-chain integers. Check scaling,
  precision, and arithmetic/accounting drift.
- Settle and attest only from specified chain evidence. HTTP success, merchant assertions,
  and indexer projections alone must not manufacture proof of payment.
- Preserve pullback destinations, refund ownership, single-use nonces, and recovery access.
  Check external calls for reentrancy and unbounded user-controlled work.
- Apply project-specific Arc semantics and pinned tools; do not substitute Ethereum
  assumptions for native USDC, ERC-1271, or Gateway behavior.

## Server, web, and indexer

- Authenticate operations and bind them to the correct user, device, vault, objective,
  and plan. Check object lookup and mutation for access across users.
- Ensure the app signs the displayed plan/payees/amounts using canonical hashes and schemas.
  Re-check stale or substituted approval inputs.
- Preserve idempotency and durable reconciliation across crashes, duplicate callbacks,
  retries, partial transactions, and concurrent workers.
- Route external URLs through specified safeFetch checks: DNS, redirects, address classes,
  credentials, size/time limits, and explicitly allowed local exceptions.
- Preserve indexer replay/reorg handling and configured chain constants. Treat projection
  lag and RPC failures as uncertainty rather than inventing successful chain state.

## Daemon, models, and privacy

- Keep secrets, raw hook payloads, and private local content out of unauthorized storage,
  logs, hosted calls, and responses. Apply the logging allowlist and consent rules.
- Preserve redaction, screening, quarantine, and reader/planner/payer separation. Model
  failures and malformed replies must not bypass the specified boundary.
- Keep merchant text from modifying payment authority or executable instructions.
  Validate structured model replies against schemas and semantic constraints.
- Check filesystem/write-back paths for traversal, unintended overwrite, and loss of
  required approval, provenance, or recovery behavior.

## Findings and accepted constraints

Report a supported attack/failure path with affected file/line, attacker capability, impact,
and remediation. Calibrate severity to reachable impact; never reproduce secrets in findings.
Phase 1 exceptions and deferred features are accepted only when approved decisions say so;
they do not waive fund, authorization, or privacy invariants. Missing live acceptance evidence
is a verification gap. Identify unrelated pre-existing issues separately from PR regressions.

Configured thresholds filter GitHub findings. Inspect the completed full Security Review
report before treating silence as no findings. This file creates no public disclosure inbox
or response-time promise.
