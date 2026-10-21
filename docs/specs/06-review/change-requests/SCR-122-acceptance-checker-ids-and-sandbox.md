# SCR-122: Acceptance checker ids, shape hash, profile and sandbox

| Field | Value |
|---|---|
| ID | SCR-122 |
| Filed by | Architect (Claude), 2026-10-21, from the T-047 pre-build review |
| Spec and section | CZ-16 §3, §5.2, §5.4, §5.7, §5.8 (`server-acceptance-evidence-selection.md`); T-047 (`phase-1-tasks.md`) |
| Status | Accepted (Zaryab, 2026-10-21; architect ruling under his delegation to make T-047 buildable in one pass) |

## Problem

- CZ-16 §5.4 says `profile_id` is "`prof_` + hash of the profile JSON" and `method_version` is "the executor code hash", but neither says which bytes are hashed. Two builds would produce different ids, and a third party could not recompute them.
- The `data-json` profile is described as a table, but no profile JSON exists, so there is nothing to hash and nothing for the planner's `ProfileSource` (T-045) to return.
- The structural check compares the "JSON key-tree" with `shape_hash_advisory`, but the key-tree and its hash are not defined. CZ-18 (T-090) will produce the hash and CZ-16 consumes it; they must agree.
- CZ-16 §3 gives a 50 MB memory budget per check, but no parameter holds it.
- A Node `vm` context alone cannot cap memory or be killed safely on a timeout, and Node's documentation says `vm` is not a security boundary.

## Decision

- **Sandbox.** Each check run happens in a `worker_threads` worker started with `resourceLimits.maxOldGenerationSizeMb = acceptance.sandboxMemoryMb` and terminated at `acceptance.sandboxTimeoutMs` (result `inconclusive`, `limits += ["sandbox-timeout"]`). Inside the worker, the check script runs in a `vm` context created with `codeGeneration: {strings: false, wasm: false}`. The context gets only plain data (strings and JSON values copied in), never host functions or host objects, so it has no `fetch`, `require`, `process`, timers or network. Ajv 8 (2020-12) runs in the worker, outside the `vm` context, because it generates code; it gets no `loadSchema`, so a remote `$ref` is never fetched (02 §11.3 already drops such schemas).
- **New parameter** `acceptance.sandboxMemoryMb` = 50 (CZ-16 §3 budget).
- **Executor and `code_hash`.** The executor is one plain JavaScript file, `apps/server/src/acceptance/executor/checks.js`, loaded as text and run unchanged in the `vm` context; no build step rewrites it. `code_hash` = `keccak256(UTF-8 bytes of that file)` as a `Hash32`. `method_version` in every report equals the profile's `code_hash`.
- **`data-json` profile JSON (Phase 1).** An `AcceptanceProfile` (SL §5.5) with: `task_class: "data-json"`, `version: 1`, `input_generator: {kind: "parametric", spec: {}}`, `checks` = `delivery` (dimension `delivery`, spec `{timeoutMs: "acceptance.deliveryTimeoutMs", maxBodyBytes: "acceptance.maxBodyBytes"}`), `structural` (dimension `structural`, spec `{validator: "ajv@8.20.0", draft: "2020-12", schemaMaxBytes: "acceptance.schemaMaxBytes"}`), `requirement` (dimension `requirement`, spec `{keys: "inputTemplate.expectedKeys"}`); `tolerances: {}`, `abstain_rules: {}`, `cost_estimate_usd: 0`, `receipt_checks: ["delivery", "structural", "requirement"]`, `limits: ["no-correctness-check"]`, `code_hash` as above. Spec values name parameter keys, not numbers, so a parameter change does not change the id.
- **`profile_id`** = `"prof_" + hex(keccak256(jcs(profile without profile_id)))[0:32]` (SL §5.1, with the JCS rule SL §5 applies to every hash). `@czar/hashing` gets `profileId(profile)`.
- **Key-tree and shape hash.** `keyTree(v)`: an object becomes an object with the same keys, each mapped to `keyTree` of its value; an array becomes `[keyTree(v[0])]`, or `[]` when empty; a string, number, boolean or null becomes the string `"string"`, `"number"`, `"boolean"` or `"null"`. `shapeHash(body)` = `keccak256(jcs(keyTree(JSON.parse(body))))`. `@czar/hashing` gets `shapeHash`. CZ-18 writes `service_versions.shape_hash_advisory` with the same function (T-090).
- **Storage.** T-047 creates `acceptance_reports` and `profiles` (CZ-16 §5.7) and seeds the `data-json` profile row at startup if its `profile_id` is absent. `acceptance_decisions` stays with T-055 (jobs).
- **Inputs T-047 does not own.** The merchant's output schema (from the sanitized `extensions.bazaar` data, 02 §11.3), the shape history (CZ-18) and the K7 address (signer service) come in through constructor ports. Until T-090 exists the shape-history port returns no history, so a body with no schema records `structural: inconclusive` (D55).

## Affected tasks

- T-047 (builds all of the above), T-045 (`ProfileSource` reads the seeded row), T-055 (evaluator reuses the executor), T-090 (writes `shape_hash_advisory` with `shapeHash`).
