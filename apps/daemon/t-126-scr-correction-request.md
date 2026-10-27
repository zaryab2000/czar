# T-126 SCR correction request: manual result write-back

**Status:** pending architect ruling. This is a builder report, not a canonical spec edit.

SCR-147 §"After submitting" line 62 requires the daemon to write
`Result.renderedBody` exactly as served. The canonical OpenAPI `Result` schema at
`docs/specs/02-data-and-protocol/api/openapi.yaml:257-267` requires `body`, has no
`renderedBody`, and sets `additionalProperties: false`. A schema-valid `getResult`
response therefore cannot provide the named field.

SCR-147 line 63 requires `Idempotency-Key=resultId` for `ackResult`. OpenAPI's
`IdempotencyKey` at `api/openapi.yaml:72-79` requires UUID v4, and the ack route
references it at line 1112. `resultId` instead has the `res_<ULID>` form at line
264. PR #106's daemon acknowledgment client also rejects non-UUID keys.

The architect needs to reconcile each field and key requirement with the
canonical API and PR #106. Until then, T-126 includes submission, redaction,
status polling, and approval output, while result write-back and `czar result`
remain unimplemented. No server, schema, OpenAPI, or other-lane file was changed.
