# SCR-163: Alpha service-version producer (amends SCR-162 §1)

| Field | Value |
|---|---|
| ID | SCR-163 |
| Filed by | chief architect, 2026-10-31, from the orchestrator's 4A-6 question: `RankingDecision.ranked[].version_id` requires an `SlVersionId`, but SCR-162 §1 left alpha observations at `ver_unknown` |
| Spec and section | SCR-162 §1; SCR-160 §5.1, §6.2 (H4 clearing), §9.2, §9.3; `ranking-decision.schema.json` 1.2 `ranked[].version_id` |
| Status | Accepted (Zaryab's delegation; recorded by his merge) |

## Ruling: build the version producer now, minimally (option 1)

- **Rejected: deferring rated ranking until T-115.** Ranking is the point of Flow 4A.
- **Rejected: allowing `ver_unknown` in the decision schema.** It weakens a verified field, and H4 could still never clear.
- **What is built instead:** only the version identity and its table. T-115's capability cards, retrieval and card storage stay in T-115.

## 1. Version id (canonical; replaces the deferral in SCR-162 §1)

- `versionId = "ver_" + hex(keccak256(utf8(JCS({payTo, resource: {url, method}, schemaHash}))))[0:32]`, via `@czar/hashing` `serviceVersionId()`. Its parts:
  - `payTo`: the live 402 `payTo`, lowercase
  - `resource`: the service's registered `resource` (`selection.czarRegisteredServices`; SCR-137)
  - `schemaHash`: keccak256 of the JCS of the validated `extensions.bazaar.schema` that the sanitizer keeps (SCR-137, `registered/index.ts`), or `null` when none is declared
- **Computed by:**
  - the CZ-18 registered selector, at probe-before-plan
  - CZ-15, at the pre-check probe it already makes before signing (CZ-15 §5.2 step 1), from that same live 402
- **The observation's `version_id`** is the value CZ-15 computed from its own pre-check probe for that call. A resumed attempt that skips the pre-check (SCR-159 §1) uses the value saved in its `reserve.sent` pre-checked calls. `ver_unknown` is written only when no probe result exists (for example, rows from before this SCR).

## 2. Table (in the 4A-6 migration)

```sql
CREATE TABLE service_versions (
  network text NOT NULL,
  service_id text NOT NULL,
  version_id text NOT NULL CHECK (version_id ~ '^ver_[0-9a-f]{32}$'),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, service_id, version_id)
);
```

- Every computation upserts: insert on first sight, otherwise update `last_seen_at`.

## 3. Effects

- **Ranking (SCR-160 §9.2–§9.3):**
  - Counts, and `ranked[].version_id`, use the candidate's **current** version: the `version_id` from this query's probe.
  - Ratings bound to an older version don't count toward the current one, because a new version starts at zero (SCR-160 §9.2).
  - A candidate with no successful probe in this query is not ranked. It goes to `excluded[]` with `gate = "probe-failed"`, the existing CZ-13 behaviour.
- **H4 clearing (SCR-160 §6.2) is now live:** when a new `version_id` row appears for the service, every uncleared H4 for it gets `cleared_at`.
- **Rows at `ver_unknown`** never count toward any ranked version.

## 4. Tests (4A-6)

- **Vectors:**
  - the same inputs give the same `versionId`
  - a changed `payTo`, `resource.url`, or Bazaar schema changes it
  - an absent schema gives `schemaHash = null`
- **Probe round trip:** a probe writes `service_versions`, and a second identical probe only moves `last_seen_at`.
- **Counts:** 3 good ratings on version A, then a schema change to version B → B is unrated, and A's counts are kept but not used.
- **H4:** an H4 on version A is cleared when version B is first seen; it stays when the same version is re-probed.
- **Schema:** every `ranked[].version_id` matches `^ver_[0-9a-f]{32}$`.

## Owner and impact

- **Owner:** 4A-6 (Lane 3) builds §1 to §3, test first.
- **CZ-15:** the change to its pre-check is small, and it belongs to 4A-6 too: write `version_id` at the observation insert.

## Decision
- Architect ruling under Zaryab's delegation. Recorded by his merge.
