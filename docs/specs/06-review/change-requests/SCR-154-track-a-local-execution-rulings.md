# SCR-154: Track A local-execution rulings (G4–G7)

| Field | Value |
|---|---|
| ID | SCR-154 |
| Filed by | chief architect, 2026-10-28, from the builder's SCR-153 follow-up report |
| Spec and section | 02 §4.16 and `schemas/step-error.schema.json`; cross-cutting §5.2 `reserve-failed`; SCR-153 §1–§2; SCR-151 (chain sessions); 02 §4 capability card `inputFields` (`data-and-protocol.md:607`) |
| Status | Accepted (Zaryab's delegation for Track A closure; recorded by his merge) |

## G4: where the decoded revert name goes
- `StepError` is closed (`additionalProperties: false`) and has no `detail` field.
- The decoded revert name goes in `message`, which never holds user text. This is already the rule in SCR-153 §2 as amended.
- Cross-cutting §5.2's "decoded name attached as `detail`" is read as "carried in `message`" for `StepError`.
- HTTP problem responses keep their own RFC 9457 `detail` (02 §9.4). That one is unrelated.
- No schema change.

## G5: slow-path states with no SCR-153 row
- **`return_tx` mined but the EOA isn't empty:** already ruled in SCR-153 §1 (amendment).
  - "Empty" means `returnable ≤ 0`.
  - If `returnable > 0` after a mined return, the row stays `pending` and nothing is sent.
- **`withdrawingBalance = 0` after a mined `initiate_tx`, with no `withdraw_tx`:**
  - Something other than CZ-15 moved the withdrawal, or `initiate` carried value 0.
  - CZ-15 sends nothing and the row stays `pending` (the builder's fail-safe in #146).
  - It is not Gateway clear, so no return goes out.
  - SCR-145 predicate 6 can't hold, so there's no write-off.
  - An operator resolves it.

## G6: how the signer reaches Ponder's tables in the session schema
- Accepted as built in #148:
  - The local launcher sets the session schema for the signer's Postgres connection through `PGOPTIONS` (`search_path`), so the database URLs stay identical across services (A2).
- `PGOPTIONS` carries a schema name only, never a credential.
- Local wiring only (`local-v1`). Stage 2 uses its own deployment config.

## G7: Bazaar schema path for card `inputFields`
- Accepted as built in #142:
  - `inputFields` and `outputFields` come from the sanitized `extensions.bazaar` input and output schema, at the path A3-35 and the x402 SDK define.
  - Descriptions are dropped (02 §4, capability card).
- A card for a service that declares no Bazaar schema has `bazaarDeclared = false` and empty `inputFields`, as before.

## Decision
- Architect rulings under Zaryab's delegation. Recorded by his merge.
