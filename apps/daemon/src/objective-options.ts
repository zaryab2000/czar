import { validateSchema, type TaskSpec } from "@czar/schemas";

export interface ObjectiveOptions {
  readonly goal: string;
  readonly capabilities: readonly string[];
  readonly taskSpec: TaskSpec;
  readonly minutesSaved: number;
  readonly hourlyBand: "A" | "B" | "C" | "D" | "E";
  readonly maxTotal?: string;
}

const KINDS = new Set(["table-fill", "list-fill", "line-fill", "error-fix", "refused-task"]);
const BANDS = new Set(["A", "B", "C", "D", "E"]);
const REPEATABLE = new Set(["--capability", "--subject", "--field"]);
const OPTIONS = new Set([
  ...REPEATABLE,
  "--kind",
  "--topic",
  "--minutes-saved",
  "--hourly-band",
  "--max-total",
]);

/** Parses the manual objective command without exposing user text in errors. */
export function parseObjectiveOptions(
  argv: readonly string[],
  allowedCapabilities: readonly string[],
): ObjectiveOptions {
  const [goal, ...rest] = argv;
  if (!goal || goal.startsWith("--")) throw new Error("usage: czar objective <goal> [options]");
  const values = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index];
    const value = rest[index + 1];
    if (!option || !OPTIONS.has(option)) throw new Error("Unknown objective option.");
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}.`);
    if (!REPEATABLE.has(option) && values.has(option)) throw new Error(`Repeated ${option}.`);
    values.set(option, [...(values.get(option) ?? []), value]);
  }
  const first = (option: string): string | undefined => values.get(option)?.[0];
  const kind = first("--kind") ?? "list-fill";
  if (!KINDS.has(kind)) throw new Error("Invalid --kind.");
  const hourlyBand = first("--hourly-band") ?? "A";
  if (!BANDS.has(hourlyBand)) throw new Error("Invalid --hourly-band.");
  const minutesText = first("--minutes-saved") ?? "0";
  const minutesSaved = Number(minutesText);
  if (!/^\d+$/.test(minutesText) || !Number.isSafeInteger(minutesSaved)) {
    throw new Error("--minutes-saved must be a nonnegative integer.");
  }
  const maxTotal = first("--max-total");
  if (maxTotal !== undefined && !/^(0|[1-9]\d*)$/.test(maxTotal)) {
    throw new Error("--max-total must be an Amount6 integer string.");
  }
  const capabilities = values.get("--capability") ?? ["web-search"];
  if (capabilities.length > 10 || capabilities.some((tag) => !allowedCapabilities.includes(tag))) {
    throw new Error("--capability must use a configured capability tag (up to 10).");
  }
  const subjects = values.get("--subject") ?? [];
  const fields = values.get("--field") ?? [];
  if (subjects.length === 0 || fields.length === 0) {
    throw new Error("At least one --subject and one --field are required.");
  }
  const taskSpec = {
    schemaVersion: "1.1",
    kind,
    topic: first("--topic") ?? goal.slice(0, 300),
    subjects: subjects.map((label) => ({ label })),
    fields,
    sourceTrust: "user-prompt",
  };
  if (!validateSchema("task-spec", taskSpec)) {
    throw new Error(
      "Objective options do not form a valid TaskSpec; check text lengths and limits.",
    );
  }
  if (goal.length > 1000) throw new Error("Objective goal exceeds 1000 characters.");
  return {
    goal,
    capabilities,
    taskSpec,
    minutesSaved,
    hourlyBand: hourlyBand as ObjectiveOptions["hourlyBand"],
    ...(maxTotal === undefined ? {} : { maxTotal }),
  };
}
