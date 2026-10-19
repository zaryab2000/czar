# SCR-104: Where the indexer's keyed fallback RPC URL is stored is not specified

| Field | Value |
|---|---|
| ID | SCR-104 |
| Filed by | Czar builder (tier 1), 2026-10-19 |
| Spec and section | `specs/04-components/server-acceptance-evidence-selection.md` CZ-19 §5.1; `cross-cutting.md` §3.3 |
| Status | Open |

## Problem
- CZ-19 §5.1 configures `rpc: [primary, keyed fallback]`, with the fallback "a keyed provider from the Arc docs list" (A9-07). Those providers put the API key in the URL (for example `rpc.drpc.testnet.arc.io/<key>`), so the URL is a secret.
- cross-cutting §3.2 forbids secrets in config and refuses `CZAR_*` variables named like secrets; §3.3 says Phase 1 secrets live in the macOS keychain, but names keychain items only for K11, K12, K18, K19 and the signer. No keychain item, key id or provider is named for the indexer's keyed RPC.
- Which provider (Blockdaemon, dRPC or QuickNode on testnet) is also not chosen.

## Evidence
- CZ-19 §5.1: "fallback a keyed provider from the Arc docs list (A9-07)".
- A9-07 lists the providers; none is selected in specs 01–05.

## Proposed change
- Name the provider and a keychain item for the keyed URL (for example service `dev.czar.indexer`, account `keyed-rpc-url`, read by the indexer process at start), and add it to the key table in spec 01 §7.2.

## Affected tasks
- T-030 (built with the primary endpoint and failover support; the fallback URL is not wired), T-040

## Decision
- 
