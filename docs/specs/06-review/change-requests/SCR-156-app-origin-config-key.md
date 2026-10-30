# SCR-156: the app origin is a config key (`app.origin`), set by the local launcher

| Field | Value |
|---|---|
| ID | SCR-156 |
| Filed by | chief architect, 2026-10-30, from the FORK browser flow blocked at A1 (`registerPasskey` 422) |
| Spec and section | system-architecture.md:460–461 (D78); app-and-notifications.md §Hosting; `apps/server/src/app.ts:449`; `apps/server/src/local-main.ts`; `apps/web/next.config.ts`; `ops/local/process-compose.fork.yaml` |
| Status | Accepted (Zaryab's delegation for Track A closure; recorded by his merge) |

## Problem
- The server checks a WebAuthn origin against `dependencies.appOrigin ?? "http://localhost"`.
  - The fallback is a literal in code, against the no-magic-values rule.
  - `local-main.ts` never sets it.
- The local web app runs at `http://localhost:3001` (Next dev, with `/v1/*` rewritten to the server). So every real passkey registration fails with `422 validation`.
- Run 6 passed only because its fixture sets `appOrigin` itself (`apps/web/e2e-local/local-server-fixture.mjs:130`).

## Ruling: option 1, a config key
- **New key `app.origin`** in `@czar/config`:
  - Type: string.
  - Default: `http://localhost`.
  - Reason: D78, the origin the web app is served from, which WebAuthn checks.
  - The server reads the WebAuthn expected origin only from this key. The `?? "http://localhost"` literal is removed.
- **Validation:**
  - In Phase 1 (`validateLocalOnlyConfig`), the value must be `http://localhost` with an optional port. Anything else fails startup.
  - Stage 2 sets the public `https` origin through the same key.
- **The WebAuthn RP ID stays `localhost`** (unchanged). The RP ID ignores the port, so a passkey made on `localhost:3001` stays valid if the app later moves to `http://localhost`. No re-registration is needed.
- **Local launcher:**
  - The FORK and CLEAN overlays set `app.origin` to the origin the web app is actually served from (`http://localhost:3001` today).
  - Run 6's fixture uses the same key, so the test path and the real path are the same.
- **"One origin" (D78) still holds** for the browser: the app and `/v1/*` reach it from one origin, because the web server forwards `/v1/*` to the API.
  - D78's "the server serves the static build at `http://localhost`" stays the Phase 1 target.
  - Serving the build from the server is deferred, not dropped. It is not needed for Track A, and it is tracked as an M8 item.
- **Option 2 rejected for now:** serving the build from the server today means:
  - a static export, which can't use the current Next rewrites
  - handling the dynamic routes such as `/approve/<planId>`
  - binding port 80
  - That is a larger change in the middle of the exit gate. The config key is needed in stage 2 anyway.
- **Approval links** (`elicitationUrl`, `http://localhost/approve/<planId>`) are built from `app.origin`, so in local runs they open the page that is actually being served.

## Tests (owner: the builder, test first, build-v1)
- The server built from `local-main.ts` with `app.origin = http://localhost:3001` accepts a WebAuthn registration whose `clientDataJSON.origin` is `http://localhost:3001`. It rejects `http://localhost:3002` with `422`.
- Config validation rejects `https://evil.example` and `http://127.0.0.1:3001` in Phase 1.
- Run 6 passes using the key, with no fixture override.

## Docs (no spec change)
- The start URL is `/onboarding/passkey`, not `/onboarding`. Fix it in `docs-internal/demo_tests/track-a-exit-flow.md` A1 and `ops/local/README.md:259`.

## Decision
- Architect ruling under Zaryab's delegation. Recorded by his merge.
