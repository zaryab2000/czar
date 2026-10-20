# SCR-030: Confirmed-demand objectives and versioned soul evidence (held for the Flow 7 review)

| Field | Value |
|---|---|
| ID | SCR-030 |
| Filed by | Architect (Claude), 2026-10-20, from D90 items 10–13 |
| Spec and section | `docs/specs/02-data-and-protocol/data-and-protocol.md` §4.3, §4.4, §4.17, §4.18, §5.2, §6.4 vectors; `schemas/objective*.schema.json`, `soul-version-leaf.schema.json`, `demand-proof-leaf.v2.schema.json`; `api/openapi.yaml` (`submitObjective`, approval); `api/local-openapi.yaml`; `docs/specs/04-components/local-soul-and-drives.md` CZ-06 §5.6, CZ-07, CZ-08; `server-planning-and-payment.md` CZ-13; `app-and-notifications.md` CZ-22; `server-acceptance-evidence-selection.md` CZ-17; `docs/specs/03-smart-contracts/open-evidence-log.md` |
| Status | Open, **held**: reviewed and applied only together with the paused Flow 7 (evidence and proof) review. Do not apply on its own. |
| Plan | `docs-internal/technical-plans/I-F-1_soul-inputs-technical-plan.md` §6, §9 "Confirmed-demand route", §11, §13 |

## Problem
- D90 lets a person confirm a current-file open loop (**Do this**). Its objective has no second observation, so `observationHashes` may be empty and the demand must be committed another way. No wire field, hash rule or public leaf for that exists today.
- D90 lets soul beliefs come from non-observed sources. The `czar-hash-v1` soul preimage does not commit `sourceClass`, `confidenceBasis` or typed receipts. D90 item 12 keeps v1 as an interim; the honest long-term rule needs a new hash and a new public leaf.
- These items change public evidence (CZ-17, OpenEvidenceLog leaves and verifier). Smart contracts are being built in parallel, so they must be decided in one review with Flow 7, not piecemeal.

## Evidence
- 02 §4.4: `observationHashes` is required and the passive route always has ≥ 2 (CZ-06 §5.1 thresholds).
- 02 §5.2: `objectiveHash` and `soulVersionHash` preimages are `czar-hash-v1` and have no demand-origin or source-class field.
- 02 §4.17: `DemandProofLeaf` v2 states observed demand only; §4.18 `SoulVersionLeaf` has `leafVersion: 1` only.
- Plan §13 recommendation B for hash migration; plan §14 GAP "public soul-leaf proof compatibility".

## Proposed change (to be confirmed or changed in the Flow 7 review)
1. **Local objects (spec 02, local only).**
   - `OpenLoopPreview {previewId (olp_), detector, sourceReceiptId, token, taskSpecHash, subjects, status: visible | dismissed | confirmed}`. A preview is not an observation and not an objective; it is refreshed from the current file before display and on click.
   - `DemandConfirmationReceipt {confirmationId (dcr_), detector, sourceEvidenceHash, taskSpecHash, confirmedAt, auditId, nonce}`.
   - Source evidence preimage, detector-agnostic: `{detector, sourceKind, capturedAt, sourceDigest, taskSpecHash, localLocator, nonce}`. `localLocator` and `nonce` never leave the device.
2. **Local route.** `POST /local/open-loops/{previewId}/confirm` (`confirmLocalOpenLoop`), body `{taskSpecHash, idempotencyKey}` → `{objectiveId, status}`. Viewer token and `Origin` check; re-read the current source, rebuild `TaskSpec`, reject a stale hash (`409 preview-stale`), create both receipts and the objective in one transaction; a replay returns the same objective; no spend authorization.
3. **Wire field.** `ObjectiveSubmission.demandEvidence {kind: "user-confirmed", sourceEvidenceHash: Hash32, userConfirmationHash: Hash32}`, present only on the confirmed route. `observationHashes` stays required and may be `[]` only when `demandEvidence` is present.
4. **`czar-objective-v2`.** The v1 preimage fields plus `demandEvidence`. Decide in review whether typed confirmed `constraints` also enter the preimage (the v1 preimage excludes them). Passive objectives keep v1 and their stored hashes. `planHash` keeps its shape; vectors must show the v2 objective propagates through it.
5. **`czar-soul-v2`.** Section hash over accepted beliefs including `sourceClass`, `confidenceBasis`, `userConfirmed`, `confirmedAt`, timestamps, text and sorted typed receipt commitments. Observed receipt commitment binds its `observationHash`; a source receipt binds `sourceClass`, `kind`, `sourceDigest`, `capturedAt` and the hash of the redacted excerpt. `previousHash` links to the last v1 or v2 version. `SoulVersionSubmission` gains `soulHashRule`; a new `SoulVersionLeaf` v2 schema with `leafVersion: 2` and `soulHashRule`. The v1 leaf schema and verifier stay unchanged.
6. **`DemandProofLeaf` v3.** `leafVersion: 3`, `demandOrigin: "user-confirmed"`, `observationHashes` possibly `[]`, `confirmationCommit = keccak256(abi.encode(userConfirmationHash, demandSalt))` with the existing per-envelope `demandSalt`, plus the v2 payment, plan and outcome links. Observed routes keep the v2 leaf. A v3 leaf never says "observed".
7. **Server and approval.** `submitObjective` accepts `demandEvidence`; a confirmed objective skips the shadow default for that objective only (`Me.mode` unchanged), and `createPayRequest` refuses it unless its envelope was opened by an owner UserOp (`approverIsOwner = true` from the chain event); earned allowance never funds it. CZ-13 marks the plan `approval.approver = owner`. CZ-22 approval shows exact subjects, payees, cap and "You chose Do this on {date}".
8. **CZ-17 and OpenEvidenceLog.** Publish and verify the v2 soul leaf and the v3 demand leaf; old v1 soul leaves and v2 demand proofs stay verifiable byte for byte. Check whether the vault's `SL_RECEIPT` signing needs any change; the default is no change.
9. **Vectors.** A mixed-receipt soul, a zero-observation confirmed objective, its plan, and an old-proof regression set.

## Affected tasks
- T-109 (hashes and schemas part), T-114 (confirmed route), and the Flow 7 tasks for CZ-17 and OpenEvidenceLog.

## Decision
- Pending. To be decided by Zaryab in the Flow 7 review.
