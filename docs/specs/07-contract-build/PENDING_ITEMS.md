# Pending contract-build items

Status as of 2026-10-20. PRDs 01–14 have been implemented and validated locally. This list covers work still needed for the contract milestone; it does not mark a local deployment as a testnet deployment.

| Item | Remaining work | Dependency or decision |
|---|---|---|
| Review the current worktree | Review the uncommitted CI, vault-client, lockfile, local deployment fixture, Gate 0 records and gas-table changes. Commit and push are Zaryab's responsibility. | Current worktree; no build dependency. |
| T-022: Arc fork tests | Write the separate fork-test PRD, pin an Arc testnet block, and test real USDC, Gateway and Circle escrow behavior. | Arc testnet RPC and T-020; see [phase-1-tasks.md](../05-build-plan/phase-1-tasks.md). |
| T-105: server keys | Create the Phase 1 keys in the local encrypted signer keystore and record their public addresses. The local Anvil address fixture is not a substitute. | Zaryab's approval for key creation; see [PRD 13](13-analysis-and-deployment.md). |
| T-027: Arc testnet deployment | After T-022 and T-105, broadcast the reviewed CREATE2 deployment, verify sources, publish hashes and addresses, and check that rerunning makes no transactions. The local Anvil deployment is complete. | Zaryab's written approval for funded testnet activity; see [PRD 13](13-analysis-and-deployment.md). |
| SCR-101: Arc hardfork pin | Record the hardfork used by Arc testnet and pin it for local runs and CI before M1 sign-off. | Chain evidence and the spec-change process. |
| T-019: real WebAuthn fixture | Capture a real-device passkey assertion in `contracts/test/fixtures/`. The existing `vm.signP256` tests cover the verifier locally. | Zaryab's approval for a real-device check; see [PRD 10](10-autonomy-and-owner-actions.md). |
| Extreme-input arithmetic review | Resolve the documented `Panic(0x11)` versus `BadParams` behavior for `reserve`, `fundPocket`, `grantPocketGas` and `raiseAutoLimit`. | Security review and an SCR before changing contract behavior; see [README.md](README.md#4-open-items-that-gate-later-prds). |

The earlier `pnpm audit` also reported seven advisories in the existing indexer dependency tree (four high, three moderate). That dependency review is outside the contract PRDs and remains a separate follow-up.

No new tests, key creation or deployment were performed when this file was written.
