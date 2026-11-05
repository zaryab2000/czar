import { reportHash as computeReportHash } from "@czar/hashing";
import type { AcceptanceReport } from "@czar/schemas";
import { validateSchema } from "@czar/schemas";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { dataJsonProfile, genericDeliveryProfile, hasOutputSchema } from "#src/acceptance/profile";
import { executorHash, runSandboxedChecks, type SandboxCheck } from "#src/acceptance/sandbox";
import type {
  AcceptanceCheckInput,
  AcceptanceDependencies,
  AcceptanceResult,
} from "#src/acceptance/types";

export type {
  AcceptanceCheckInput,
  AcceptanceDependencies,
  AcceptancePorts,
  AcceptanceResult,
  ScreenOutcome,
} from "#src/acceptance/types";

interface StoredProfile {
  readonly profile_json: Record<string, unknown>;
  readonly code_hash: string;
}

export async function createAcceptanceChecker(dependencies: AcceptanceDependencies) {
  const executorSource = await readFile(new URL("./executor/checks.js", import.meta.url), "utf8");
  const codeHash = executorHash(executorSource);
  const dataProfile = dataJsonProfile(codeHash);
  const genericProfile = genericDeliveryProfile(codeHash);
  await seedDataJsonProfile(dependencies.pool, dataProfile);
  await seedDataJsonProfile(dependencies.pool, genericProfile);

  return {
    codeHash,
    profileIdFor(taskClass: string): string {
      if (taskClass === "data-json") return dataProfile.profile_id;
      if (taskClass === "generic-delivery") return genericProfile.profile_id;
      throw new RangeError("No acceptance profile is seeded for task class " + taskClass + ".");
    },
    getProfileId: (taskClass: string) => getProfileId(dependencies.pool, taskClass),
    check: (input: AcceptanceCheckInput) => checkAcceptance(input, dependencies, executorSource),
  };
}

async function seedDataJsonProfile(
  pool: Pool,
  profile: Readonly<Record<string, unknown>> & {
    readonly profile_id: string;
    readonly task_class: string;
    readonly version: number;
    readonly code_hash: string;
  },
): Promise<void> {
  await pool.query(
    'INSERT INTO profiles (profile_id,task_class,version,"json",code_hash) ' +
      "VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (profile_id) DO NOTHING",
    [
      profile.profile_id,
      profile.task_class,
      profile.version,
      JSON.stringify(profile),
      profile.code_hash,
    ],
  );
}

async function getProfileId(pool: Pool, taskClass: string): Promise<string | null> {
  const result = await pool.query<{ profile_id: string }>(
    "SELECT profile_id FROM profiles WHERE task_class=$1 ORDER BY version DESC LIMIT 1",
    [taskClass],
  );
  return result.rows[0]?.profile_id ?? null;
}

async function checkAcceptance(
  input: AcceptanceCheckInput,
  dependencies: AcceptanceDependencies,
  executorSource: string,
): Promise<AcceptanceResult> {
  assertCheckInput(input);
  const started = performance.now();
  const profile = await loadProfile(dependencies.pool, input.profileId);
  if (input.step.acceptanceProfileId !== input.profileId)
    throw new TypeError("Step acceptanceProfileId does not match the requested profile.");
  const validatorAddress = await dependencies.ports.validatorIdentity.address();
  const screenState = screenDisposition(input);
  let checks: readonly SandboxCheck[];
  let timedOut = false;
  let sandboxDurationMs = 0;
  let extraLimits: string[] = [];

  if (screenState === "quarantined") {
    checks = uncheckedChecks();
    if (!input.screen.available) extraLimits.push("screen-unavailable");
  } else {
    const declaredSchema = await dependencies.ports.outputSchema.forService(input.serviceId);
    const outputSchema = hasOutputSchema(declaredSchema) ? declaredSchema : null;
    const historyShapeHash = outputSchema
      ? null
      : await dependencies.ports.shapeHistory.forService(input.serviceId);
    const sandbox = await runSandboxedChecks({
      executorSource,
      input: sandboxInput(input, historyShapeHash, isGenericProfile(profile)),
      outputSchema,
      config: dependencies.config,
    });
    checks = sandbox.checks;
    timedOut = sandbox.timedOut;
    extraLimits.push(...sandbox.limits);
    sandboxDurationMs = sandbox.durationMs;
  }

  const flags =
    input.screen.available && input.screen.label === "injection-suspect"
      ? ["injection-quarantined"]
      : [];
  const limits = [
    ...new Set(["no-correctness-check", ...extraLimits, ...(timedOut ? ["sandbox-timeout"] : [])]),
  ];
  const decision = decide(checks, screenState, timedOut);
  const createdAt = dependencies.ports.clock.now().toISOString();
  const report = makeReport({
    input,
    profile,
    validatorAddress,
    checks,
    flags,
    limits,
    decision,
    createdAt,
  });
  validateReport(report);
  await storeReport(dependencies.pool, report, input.bodyRef);
  logReport(
    dependencies,
    report,
    Math.max(sandboxDurationMs, Math.round(performance.now() - started)),
  );
  return {
    report,
    stepResultFlags: checks.some(
      (checkResult) => checkResult.name === "structural" && checkResult.result === "fail",
    )
      ? ["schema-mismatch"]
      : [],
  };
}

function assertCheckInput(input: AcceptanceCheckInput): void {
  if (input.step.stepIndex !== input.stepIndex)
    throw new TypeError("Acceptance stepIndex must match the supplied Step.");
  if (!Number.isSafeInteger(input.elapsedMs) || input.elapsedMs < 0)
    throw new RangeError("Acceptance elapsedMs must be a non-negative integer.");
  if (!Number.isFinite(input.maxTimeoutSeconds) || input.maxTimeoutSeconds < 0)
    throw new RangeError("Acceptance maxTimeoutSeconds must be non-negative.");
}

function screenDisposition(input: AcceptanceCheckInput): "screened" | "quarantined" {
  return !input.screen.available || input.screen.label === "injection-suspect"
    ? "quarantined"
    : "screened";
}

function sandboxInput(
  input: AcceptanceCheckInput,
  historyShapeHash: string | null,
  genericDelivery: boolean,
) {
  return {
    paid: input.paid,
    responseArrived: input.responseArrived,
    statusCode: input.statusCode,
    elapsedMs: input.elapsedMs,
    maxTimeoutSeconds: input.maxTimeoutSeconds,
    bodyText: input.bodyText,
    bodyBytes: input.bodyText === null ? 0 : Buffer.byteLength(input.bodyText, "utf8"),
    mimeType: input.mimeType,
    expectedKeys: genericDelivery ? [] : (input.step.inputTemplate?.expectedKeys ?? []),
    genericDelivery,
    historyShapeHash,
    deliveredAsIs: input.deliveredAsIs ?? false,
    ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
  };
}

function isGenericProfile(profile: StoredProfile): boolean {
  return profile.profile_json["name"] === "generic-delivery.v1";
}

async function loadProfile(pool: Pool, profileId: string): Promise<StoredProfile> {
  const result = await pool.query<StoredProfile>(
    'SELECT "json" AS profile_json,code_hash FROM profiles WHERE profile_id=$1',
    [profileId],
  );
  const profile = result.rows[0];
  if (!profile)
    throw new Error("Acceptance profile is missing; initialize the checker at startup.");
  if (profile.profile_json["profile_id"] !== profileId)
    throw new Error("Stored acceptance profile id does not match its row key.");
  return profile;
}

function uncheckedChecks(): SandboxCheck[] {
  return ["delivery", "structural", "requirement"].map((name) => ({
    name: name as SandboxCheck["name"],
    result: "not_checked",
  }));
}

// CZ-16 §5.3: Pass = delivery pass ∧ structural ∉ {fail} ∧ requirement ∉ {fail}.
// A structural `inconclusive` (no schema and no history, or a dropped schema) does not block
// the decision; D55 governs the check result, which stays `inconclusive` and so never enters
// posteriors (SL-C7). Only quarantine, sandbox timeout or a non-passing delivery are inconclusive.
function decide(
  checks: readonly SandboxCheck[],
  screenState: "screened" | "quarantined",
  timedOut: boolean,
): "pass" | "fail" | "inconclusive" {
  if (screenState === "quarantined" || timedOut) return "inconclusive";
  if (checks.some((check) => check.result === "fail")) return "fail";
  if (checks.find((check) => check.name === "delivery")?.result !== "pass") return "inconclusive";
  return "pass";
}

function makeReport(args: {
  readonly input: AcceptanceCheckInput;
  readonly profile: StoredProfile;
  readonly validatorAddress: string;
  readonly checks: readonly SandboxCheck[];
  readonly flags: readonly string[];
  readonly limits: readonly string[];
  readonly decision: "pass" | "fail" | "inconclusive";
  readonly createdAt: string;
}): AcceptanceReport {
  const core = {
    schemaVersion: "1.0" as const,
    obs_id: args.input.obsId,
    profile_id: args.input.profileId,
    method_version: args.profile.code_hash,
    validator: { id: "czar-evaluator", address: args.validatorAddress },
    assignment: { kind: "buyer-local" as const },
    checks: args.checks.map((check) => ({
      ...check,
      ...(check.detail ? { detail: { ...check.detail } } : {}),
    })),
    conflict_flags: ["self-reported-checks" as const],
    cost_usd: 0,
    created_at: args.createdAt,
    limits: [...args.limits],
    envelopeRef: args.input.envelopeRef,
    stepIndex: args.input.stepIndex,
    ...(args.input.jobKey ? { jobKey: args.input.jobKey } : {}),
    decision: args.decision,
    ...(args.flags.length ? { flags: ["injection-quarantined" as const] } : {}),
  };
  return { ...core, reportHash: computeReportHash(core) };
}

function validateReport(report: AcceptanceReport): void {
  if (!validateSchema("acceptance-report", report))
    throw new Error("AcceptanceReport failed @czar/schemas validation.");
}

async function storeReport(pool: Pool, report: AcceptanceReport, bodyRef?: string): Promise<void> {
  await pool.query(
    "INSERT INTO acceptance_reports " +
      "(report_hash,envelope_ref,step_index,job_key,obs_id,profile_id,method_version," +
      "decision,checks,flags,created_at,body_ref,report) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb) " +
      "ON CONFLICT (report_hash) DO NOTHING",
    [
      report.reportHash,
      report.envelopeRef,
      report.stepIndex,
      report.jobKey ?? null,
      report.obs_id,
      report.profile_id,
      report.method_version,
      report.decision,
      JSON.stringify(report.checks),
      report.flags ?? [],
      report.created_at,
      bodyRef ?? null,
      JSON.stringify(report),
    ],
  );
}

function logReport(
  dependencies: AcceptanceDependencies,
  report: AcceptanceReport,
  durationMs: number,
): void {
  dependencies.logger.info("acceptance_check", {
    state: report.decision,
    durationMs,
    reportHash: report.reportHash,
  });
  for (const check of report.checks) {
    dependencies.logger.info("acceptance_check_result", {
      rule: check.name,
      state: check.result,
      reportHash: report.reportHash,
    });
  }
}
