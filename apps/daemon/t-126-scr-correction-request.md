# T-126 SCR correction request: served result body field

**Status:** pending architect ruling. This is a builder report, not a canonical spec edit.

SCR-147 §"After submitting" line 62 requires the daemon to write
`Result.renderedBody` exactly as served. The canonical OpenAPI `Result` schema at
`docs/specs/02-data-and-protocol/api/openapi.yaml:257-267` requires `body`, has no
`renderedBody`, and sets `additionalProperties: false`. A schema-valid `getResult`
response therefore cannot provide the named field.

SCR-148 (PR #109) resolves the separate acknowledgment-key conflict: OpenAPI's
UUID v4 rule wins. T-126 must persist one key and one request body per result
before sending, then reuse both for retries and later `czar result` calls. PR
#106 remains the result route and acknowledgment client dependency.

The architect still needs to reconcile `renderedBody` with the canonical
`Result.body` field. Until then, T-126 includes submission, redaction, status
polling, and approval output, while result write-back and `czar result` remain
unimplemented. No server, schema, OpenAPI, or other-lane file was changed.
