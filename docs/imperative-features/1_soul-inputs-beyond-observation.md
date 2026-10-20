# 1. Soul inputs beyond observation

- **ID:** I-F-1
- **Raised by:** Zaryab, while reviewing the architecture (flow "Observation → objective")
- **Date:** 2026-10-19
- **For:** the project architect agent, to review and turn into decisions, spec changes and tasks
- **Status:** requested feature. Not yet a decision. Nothing in the specs changes until the architect does it through the decision log and the spec change-request workflow (`docs/specs/05-build-plan/spec-change-request-template.md`).

---

## 1. The problem

- Czar builds the Work Soul **only by watching** the user work. Nothing the user says, and nothing they already have elsewhere, can feed it.
- **Observation is slow to be useful:**
  - On day one the soul is empty.
  - The drives engine needs repeated signals before it acts. For example, the `placeholder` rule needs 2 sightings at least 24 hours apart (`local-soul-and-drives.md`, drives rules).
  - Shadow mode runs for 7 days by design (`shadow.days` = 7).
  - So a new user waits days before Czar understands them or finds anything worth buying.
- **The soul compiler itself is slow by construction** (`local-soul-and-drives.md` §5.1, §5.2, §5.10):
  - A belief needs at least 2 receipts and confidence ≥ 0.5 before it becomes `Active` and is shown (`soul.minReceipts`, `soul.activeConfidence`).
  - Mission looks at 14 days of project activity (`soul.missionWindowDays`).
  - A ritual needs the same weekday/hour pattern at least 3 times across at least 3 weeks (`soul.ritualMinRepeats`, `soul.ritualMinWeeks`).
  - Compiles run once a night (`soul.compileCron` 02:00), so a pattern seen today appears tomorrow at the earliest.
  - Constraints are never inferred, only taken from settings, so that section stays empty until the user fills in settings.
- **Some soul sections are things only the user knows,** and watching infers them slowly or never:
  - **Place:** locale, currency, where they work
  - **Constraints:** budget, tools they won't use, privacy limits
  - **Taste:** quality bar, trusted sources
  - **Spending posture:** how much risk they accept
  - **Mission:** active projects and deadlines
- **Users already have this context written down:**
  - instruction files on their machine (`CLAUDE.md`, `AGENTS.md`, skills)
  - their git repos
  - other AI apps (ChatGPT or Claude memory, custom instructions, data exports)

  Czar ignores all of it.

## 2. What the project says today

| Where | What it says | Effect |
|---|---|---|
| `docs/product/czar-product.md` §3.2 | "Not an invented persona. The soul comes from observed work, never from fiction." | Observation is a stated product principle. |
| `docs/product/czar-product.md` §6.3 | "Czar writes it; the person never has to." | No user-authored input. |
| `docs/specs/04-components/local-soul-and-drives.md` §5.4 | Only hook events in `soul.allowedProvenance` can **create** a belief. Untrusted text can only support one. | The poisoning defence (OWASP ASI06, ground truth C3-02) also blocks every non-observed source. |
| `docs/specs/04-components/local-soul-and-drives.md` §5.7 and the local API `POST /local/soul/beliefs/{beliefId}` | Ops: `edit`, `pin`, `unpin`, `delete`, `setConfidence`. | The user can correct beliefs but **cannot add** one. |
| `docs/specs/04-components/local-observers-and-daemon.md` (CZ-01 "Does not") | Never reads `transcript_path`. | Past Claude Code sessions are not used either. |
| Board (Czar Build Board) | No card or task covers onboarding input, imports or direct objectives. | Not planned anywhere. |

**The only non-observed inputs today** are settings: hourly value (`soul.json.hourlyValue`) and the spending limits set in the web app.

## 3. Why observation-only was chosen (keep this)

- The soul drives spending. If any text can write a belief, injected text can create objectives that spend money.
- Observed, repeated, multi-source behaviour is hard to fake.
- Every new source below must keep this protection. The design rules in §4 exist for that.

## 4. Design rules for any new source

1. **Every belief carries a source class:**
   - `observed`: today's hook events
   - `declared`: the user said it, in Czar's own UI or through their agent
   - `local-file`: read from the user's own files
   - `imported`: from another app's export
2. **`declared` beliefs are trusted directly** for the sections the user is the authority on: Place, Constraints, Taste, Spending posture, Mission.
3. **`imported` and `local-file` text is untrusted until the user confirms it.** It goes through the same two redaction layers and the P-01 injection screen, then appears as **proposed beliefs**. The user accepts, edits or rejects each one. Only accepted ones enter the soul.
4. **Unconfirmed non-observed beliefs can never, by themselves, create an objective that spends money.** A paid objective needs observed evidence, a confirmed belief, or an explicit user request (feature 1.5).
5. **Everything stays local-first:**
   - Imports and local files are processed on the user's machine by the daemon.
   - Only redacted excerpts go to the soul compiler's model call, under D31.
   - Nothing raw goes to the server.
6. **User edits still win** (§5.7 unchanged). Deleting a declared or imported belief tombstones it like any other.
7. **The soul viewer shows each belief's source**, so the user can see what Czar watched, what they told it and what was imported.

## 5. Features for version 1

### 1.1 Onboarding interview (chat or form, repeatable anytime)

- **What:** a short guided interview at signup that the user can reopen any time. It can be a form, a chat, or both.
- **Fills:** Place, Mission (current projects and deadlines), Constraints (budget, banned tools and vendors, privacy limits), Taste, Spending posture, and hourly value.
- **Source class:** `declared`.
- **Where:**
  - It runs in the local soul viewer (CZ-05), because the soul is desktop-only and local in Phase 1 (D34).
  - The web app may link to it.
- **Done when:**
  - A new user who completes it has a soul (version 1) with beliefs in at least the five authority sections, before any observation.
  - Each belief is marked `declared`.
  - The user can rerun the interview and edit the answers.

### 1.2 Read the user's existing agent files on their machine

- **What:** with the user's permission, the daemon reads the instruction files they already wrote:
  - user and project `CLAUDE.md`
  - `CLAUDE.local.md`
  - `AGENTS.md`
  - installed skills (`SKILL.md` names and descriptions)
  - Claude Code settings and MCP server lists (names only, never secrets)
- **Fills:** Taste, Constraints, Mission (which projects and repos exist), Rituals (which skills they use), and tools in use.
- **Source class:** `local-file`, proposed until confirmed (rule 3).
- **Safety:**
  - Secrets redaction runs first. Settings and MCP configs can hold tokens.
  - The P-01 screen runs next, because instruction files are written to steer agents.
  - The user picks which folders are allowed.
- **Done when:**
  - Proposed beliefs are created from a sample set of these files.
  - No secret from a seeded test corpus reaches a belief or an excerpt.
  - Nothing enters the soul without the user accepting it.

### 1.3 Read git history and open work in the user's repos

- **What:** for repos the user allows, read recent commit messages, branch names, and open `TODO` / `FIXME` / placeholder markers in tracked files.
- **Fills:** Mission (active projects, recent focus), Drives (open loops), Rituals (commit rhythm).
- **Feeds the drives engine on day one:** existing `TODO` markers can be counted as prior sightings, so the `placeholder` detector doesn't have to wait for repeated writes. The architect should decide whether git-sourced sightings may satisfy `drives.placeholderMinSeen`.
- **Source class:** `local-file`.
- **Safety:** local only; redaction before anything is stored; repo allowlist chosen by the user.
- **Done when:** a repo with known TODOs produces candidate drives at first run, each with receipts pointing to the commit or file.

### 1.4 Import from other AI apps

- **What:** the user uploads an export from another AI app and Czar turns it into proposed beliefs. Inputs to support:
  - **Saved memory / custom instructions text,** pasted or uploaded.
  - **Full data export files** (conversation archives) from ChatGPT and Claude.
- **Fills:** all eight sections, mostly Mission, Taste, Friction and Drives (recurring questions and unfinished requests).
- **Source class:** `imported`, always proposed until confirmed.
- **Safety:**
  - This is the highest-risk source. It's large, untrusted, and may contain injected instructions or other people's data.
  - Process it locally in the daemon, then run redaction and the P-01 screen.
  - Show proposed beliefs with the excerpt they came from.
  - Never keep the raw export after processing, unless the user asks.
- **Research needed first** (ground-truth gap): the current export formats, file structure and field names for ChatGPT and Claude data exports, and their memory and custom-instruction exports. This is **not verified** in `docs/specs/00-ground-truth/`. A ground-truth item must confirm it from official sources before the parser is specified.
- **Done when:** a sample export of each supported app produces proposed beliefs, with no raw text stored after import and no secret from a seeded corpus surviving.

### 1.5 Ask the user's own agent ("tell Czar about me")

- **What:** a new tool on the Czar MCP server (CZ-09), for example `describe_user`. When the user asks their agent ("tell Czar about me"), the agent summarizes what it already knows about the user and sends it to Czar.
- **Fills:** any section. Most useful for Mission and Taste.
- **Source class:** `declared` only when the user started it; otherwise `imported`, proposed until confirmed. The agent's summary is model-written text, so it's untrusted (rule 3).
- **Safety:**
  - The tool can only **propose** beliefs. It can't create objectives or touch spending.
  - The user confirms in the soul viewer.
- **Done when:** calling the tool from Claude Code creates proposed beliefs that appear for review, and an injected instruction in the summary is flagged by P-01 and never becomes a belief.

## 6. Low priority (later versions)

| # | Source | Why later |
|---|---|---|
| L1 | **Direct objectives:** the user types "do this for me" and skips the drives engine | Fastest path to value, but it touches planning and approval, not just the soul. Propose it as its own feature when we review the Planning flow. |
| L2 | **Work tools through MCP or OAuth:** GitHub issues, Linear, calendar, email | Rich source of open loops, but a large privacy and permission surface. |
| L3 | **Opt-in backfill of past Claude Code sessions** | Currently banned ("never reads `transcript_path`"). It would need a new decision. A limited, redacted, opt-in backfill is defensible. |
| L4 | **Role templates** ("backend engineer", "marketer") as a rough starting soul | Low accuracy; replaced quickly by real data. |

## 7. What the architect needs to change

1. **New decision in `docs/product/decisions-log.md`:** the soul accepts declared, local-file and imported inputs under the rules in §4. Amend `czar-product.md` §3.2 and §6.3 to match. Suggested wording: "The soul comes from the person's real work: what Czar observes and what the person tells it or imports. Never from invention."
2. **`docs/specs/02-data-and-protocol/`:**
   - Add a source-class field to beliefs and receipts in `soul.json`.
   - Add a proposed-belief state.
   - Add local API routes for interview answers, import upload, file scan, and accept/reject of proposed beliefs. Today `POST /local/soul/beliefs/{beliefId}` has no `add` op.
3. **`docs/specs/04-components/local-soul-and-drives.md`:**
   - Extend §5.4 (provenance allowlist) with the new source classes and their rules.
   - Extend §5.7 to include accept and reject for proposed beliefs.
   - Decide whether git-sourced sightings count toward drive thresholds.
4. **`docs/specs/04-components/local-observers-and-daemon.md`:** add the file scanner and the import processor to the daemon, with redaction and P-01 on both.
5. **`docs/specs/04-components/local-agent-surfaces.md`:** add the `describe_user` MCP tool (feature 1.5).
6. **`docs/specs/04-components/ai-prompts.md`:** a prompt for extracting proposed beliefs from imported or local text. It must output structured candidates only, never free text into templates.
7. **Ground truth:** a new research item for AI-app export formats (feature 1.4).
8. **Board and `docs/specs/05-build-plan/phase-1-tasks.md`:** new tasks under CZ-04 (Soul compiler), CZ-05 (Soul viewer), CZ-02 (Local daemon) and CZ-09 (MCP server), probably in milestone M5.
9. **Threat model** (`system-architecture.md` §13): add imported or local-file text as a memory-poisoning vector, with the confirm-before-use mitigation.

## 8. Open questions for the architect

- Should declared beliefs in Constraints and Spending posture be able to **lower** the user's spending limits automatically? They should never raise them.
- Does a confirmed imported belief count the same as an observed one for the drives engine's confidence formula, or does it carry less weight?
- Can the interview run before the daemon is installed, for example in the web app? It would then need to be stored or synced locally under D34.
- Which AI-app export formats are in scope for version 1, after the ground-truth check?
