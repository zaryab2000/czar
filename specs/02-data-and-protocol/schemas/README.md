# Schemas (spec 02 §4)

- One JSON Schema 2020-12 file per data object in `data-and-protocol.md` §4, plus `common.schema.json` for shared primitives (`Amount6`, `Address`, `Hash32`, `Caip2`, `Timestamp`, `Ulid`, prefixed ids).
- `$id` = `https://czar.dev/schemas/<file name>` (for example `https://czar.dev/schemas/plan.schema.json`), and cross-file `$ref`s are file-relative (`common.schema.json#/$defs/Amount6`). That way a reference resolves to the same schema whether a tool resolves it by `$id` (JSON Schema validators such as ajv) or by file path (OpenAPI tools such as redocly). The minor version lives in each file's `schemaVersion` const; a major version is a new file `<name>.v2.schema.json` (spec 02 §2.2). **Superseded 2026-10-19:** `$id = https://czar.dev/schemas/<name>/1.0`, under which the relative refs could not be resolved by a Draft 2020-12 validator. Every property carries `description` and `x-privacyClass` (`local-only` | `redacted-to-server` | `server-only` | `hash-on-chain` | `public`); every object carries an object-level `x-privacyClass`. `additionalProperties: false` everywhere (for `payment-ref`, enforced per rail branch under `oneOf`).
- `plan.schema.json` embeds `Step` and `PayeeLeaf` under `$defs`; `pocket-record.schema.json` embeds `PullbackRecord`; `soul.schema.json` embeds `Belief`.

## Files

| File | Object (spec 02 §) |
|---|---|
| `common.schema.json` | primitives (§2.1) |
| `activity-event.schema.json` | §4.1 |
| `soul.schema.json` | §4.2 |
| `objective.schema.json` | §4.3 |
| `objective-submission.schema.json` | §4.4 |
| `plan.schema.json` | §4.5–4.7 |
| `envelope.schema.json` | §4.8 |
| `reservation.schema.json` | §4.9 |
| `pocket-record.schema.json` | §4.10 |
| `job-record.schema.json` | §4.11 |
| `payment-ref.schema.json` | §4.12 |
| `receipt.schema.json` | §4.13 |
| `acceptance-report.schema.json` | §4.14 |
| `step-result.schema.json` | §4.15 |
| `step-error.schema.json` | §4.16 |
| `demand-proof-leaf.schema.json` | §4.17 |
| `soul-version-leaf.schema.json` | §4.18 |
| `ranking-decision.schema.json` | §4.19 |
| `evidence-batch.schema.json` | §4.20 |

## Checks run

2026-10-19 (G0-01 review fixes), from this directory:

```
python3 -I check-schemas.py                       # metadata and privacy annotations
node <scratch>/validate-schemas.mjs . ../examples   # full Draft 2020-12 compile plus every example file
```

Both must pass. ES modules resolve packages next to the script, so copy `validate-schemas.mjs` into a scratch directory where `npm install ajv@8.17.1 ajv-formats@3.0.1` ran (pinned versions) and run it from there with this directory as the argument.

### 2026-10-18

```
for f in *.schema.json; do python3 -I -c 'import json,sys;json.load(open(sys.argv[1]))' "$f" || echo "INVALID $f"; done
python3 -I check-schemas.py
```

Result: all 19 files parse as JSON; `check-schemas.py` reported `checked 19 files; problems: 0` (every property has `description` and a valid `x-privacyClass`, every object has an object-level class, `$schema` and `$id` are correct). A full Draft 2020-12 validator run (for example `ajv-cli`) is left to CI; no packages were installed in this session.
