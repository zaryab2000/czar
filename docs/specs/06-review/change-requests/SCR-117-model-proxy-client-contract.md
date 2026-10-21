# SCR-117: Specify the server model-client contract and prompt assets

| Field | Value |
|---|---|
| ID | SCR-117 |
| Filed by | Codex, 2026-10-21 |
| Spec and section | `docs/specs/02-data-and-protocol/api/openapi.yaml` `completeModelCall`; `docs/specs/04-components/shared/ai-prompts.md` common rules and P-01/P-04/P-05/P-06/P-07; `docs/specs/04-components/shared/cross-cutting.md` §6.2 |
| Status | Open |

## Problem

- The API defines the daemon request/response but no injected server-side model-client interface, model selection mapping, or required budget/timeout inputs to that client.
- The prompt spec says prompt files live at `models/<id>.md`, but no `models/` prompt assets are present in the build-v1 checkout. The model request carries a prompt ID and hash, but does not define how the server-side client resolves or verifies the system prompt.
- Exact provider token usage is returned after the call. The specs do not define how the server must bound a call by the remaining per-user monthly budget before it reaches the provider, especially under concurrent calls.

## Evidence

- `docs/specs/02-data-and-protocol/api/openapi.yaml` defines `ModelCallRequest` with `prompt`, `promptHash`, `input`, and `schema`, and `ModelCallResponse` with `output` and usage counts (lines 841–865). It does not define an internal model-client interface.
- `docs/specs/04-components/shared/ai-prompts.md` says prompt files live in `models/<id>.md` (line 3); no prompt assets exist in this checkout (`rg --files models` returned no files).
- `docs/specs/04-components/shared/cross-cutting.md` §6.2 sets monthly and per-call token caps, while the returned token usage is known only after the model call.

## Proposed change

Specify the internal client input/output contract, prompt asset source and hash-validation rule, model selection mapping, timeout/cancellation behavior, and how a client honors a remaining total-token budget before a provider request. Preserve the API response shape, no-body-storage rule, and K18 loading boundary assigned to T-040.

## Affected tasks

- T-040 (provider client and K18 injection)
- T-065 (server proxy boundary)
- T-066, T-068, T-111 (daemon prompt callers)

## Decision

- Pending.
