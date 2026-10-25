# SCR-134: App device management — issue pairing code, list devices, revoke

| Field | Value |
|---|---|
| ID | SCR-134 |
| Filed by | chief architect, 2026-10-25 (Track A replan, baseline `ce17dad`) |
| Spec and section | `docs/specs/02-data-and-protocol/data-and-protocol.md` §9.1 (`:957`), §9.2 app table; `docs/specs/02-data-and-protocol/api/openapi.yaml`; `docs/specs/04-components/app/app-and-notifications.md` CZ-22 §5.1 row `/settings/devices` (`:63`) |
| Status | Accepted (Zaryab, 2026-10-25); Applied (2026-10-25) |

## Problem
- 02 §9.1 says "the app shows an 8-digit code … the app lists devices and revokes" (`:957`), and CZ-22 lists `/settings/devices` with "show 8-digit pairing code, revoke" (`:63`). But no app-surface operation exists:
  - OpenAPI has only `pairDevice` (`openapi.yaml:948-963`), the daemon side.
  - `issuePairingCode` exists only as an exported function (`apps/server/src/devices/pair.ts:13-37`, `apps/server/src/index.ts:3`), called by tests.
- SCR-113 assumes "revoke the old device in the app" without a route. The Devices page is a static placeholder (`apps/web/app/settings/devices/page.tsx:1-11`).

## Evidence
- The verification reports cited here are architect working papers outside the repository; every claim also carries a repository file:line.
- Verification report DE §E3; the file:line references above.

## Proposed change
- Three AppSession operations added to 02 §9.2 and OpenAPI:

  | Operation | Route | Request | Response | Notes |
  |---|---|---|---|---|
  | `createPairingCode` | `POST /v1/devices/pairing-codes` | none; `Idempotency-Key` required | `{code: string /^[0-9]{8}$/, expiresAt: Timestamp}` | calls the existing `issuePairingCode`; TTL `app.pairingCodeTtlMinutes` (5); rate limit is the existing app rate limit |
  | `listDevices` | `GET /v1/devices` | none | `{items: [{deviceId, deviceName, platform, createdAt, revokedAt?}]}` | session user's devices only |
  | `revokeDevice` | `POST /v1/devices/{deviceId}/revoke` | none; `Idempotency-Key` required | `204` | sets `devices.revoked_at`; the existing revoked-token check (`apps/server/src/http/auth.ts:28-36`) then refuses that device's token; `404` for another user's device |

- Fields come only from the existing `devices` columns (`device_id`, `device_name`, `platform`, `revoked_at`, `created_at`; `apps/server/migrations/0001-cz12.sql:13-21`). No column is added.
- Privacy: `deviceName` and `platform` are `SO`; the rest are `PUB`. The pairing `code` is never logged (cross-cutting §4).
- Wording (CZ-22 §12):
  - Button: "Pair a computer"
  - Code panel: "Enter this code in Czar on your computer: {code}. It expires in {minutes} minutes."
  - Revoke confirm: "Stop {deviceName} from sending work to Czar?"

## Affected tasks
- T-061 (server side), T-081/T-084 (app).
- Builder brief TA-15 in the Track A plan.

## Decision
- Accepted by Zaryab on 2026-10-25 with the Track A replan (context and briefs in `docs/builder-prompts/track-a/`).

## Applied
- 02 §9.2 rows and `api/openapi.yaml` `createPairingCode`, `listDevices`, `revokeDevice` with the `PairingCode` and `Device` components
- CZ-22 §5.1 devices row and §12 wording
