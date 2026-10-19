# Schema examples (spec 02)

- One invented, schema-valid instance per schema in `../schemas/` (all values are placeholders, not real data or addresses of anyone).
- Generated from the schemas with a deterministic generator on 2026-10-19 and checked by `../schemas/validate-schemas.mjs`; every file must keep validating when a schema changes (task T-006 runs the check).
- File name rule: `<schema name>.example.json` validates against `<schema name>.schema.json`.
