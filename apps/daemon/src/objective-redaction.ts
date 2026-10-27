import { detectSecrets, parseMarkers, type Layer2Client } from "@czar/redaction";
import type { ObjectiveOptions } from "#src/objective-options";

export interface RedactedObjective {
  readonly options: ObjectiveOptions;
  readonly layer2: { readonly hits: number; readonly entities: string[] };
  readonly forcedReview: boolean;
}

/** Scans every user text value before a manual objective can leave the Mac. */
export async function redactObjectiveInput(
  options: ObjectiveOptions,
  client: Layer2Client,
): Promise<RedactedObjective> {
  const values = [
    options.goal,
    options.taskSpec.topic,
    ...options.taskSpec.subjects.map((subject) => subject.label),
    ...options.taskSpec.fields,
  ];
  const secrets = new Set(values.flatMap((value) => detectSecrets(value).map((hit) => hit.rule)));
  if (secrets.size > 0) {
    throw new Error(`Secret detected; objective was not sent. Rules: ${[...secrets].join(", ")}`);
  }
  for (const value of values) {
    if (parseMarkers(value).length > 0) {
      throw new Error("Objective text contains a redaction marker; objective was not sent.");
    }
  }
  const protectedValues = [
    ...options.taskSpec.subjects.map((subject) => subject.label),
    ...options.taskSpec.fields,
  ].filter((value) => value.length > 0);
  const spans = [...new Set(protectedValues)].toSorted((a, b) => b.length - a.length);
  let protectedGoal = options.goal;
  const replacements = spans.flatMap((value, index) => {
    if (!protectedGoal.includes(value)) return [];
    const token = `CZARPROTECTEDSPAN${index}Q`;
    if (options.goal.includes(token)) {
      throw new Error("Objective text conflicts with a protected span marker.");
    }
    protectedGoal = protectedGoal.replaceAll(value, token);
    return [{ token, value }];
  });
  const result = await client.redact(protectedGoal, { language: "en" });
  let redactedGoal = result.text;
  for (const { token, value } of replacements) {
    if (!redactedGoal.includes(token)) {
      throw new Error("Protected task text was altered by redaction; objective was not sent.");
    }
    redactedGoal = redactedGoal.replaceAll(token, value);
  }
  const markerCounts = new Map<string, number>();
  for (const marker of parseMarkers(result.text)) {
    if (marker.layer !== "P") continue;
    markerCounts.set(marker.type, (markerCounts.get(marker.type) ?? 0) + 1);
  }
  const unmarked = result.entities.some((entity) => markerCounts.get(entity.type) !== entity.count);
  if (unmarked || markerCounts.size !== result.entities.length) {
    const names = result.entities.map((entity) => entity.type).join(", ") || "unknown";
    throw new Error(`Unmarked personal data detected; objective was not sent. Entities: ${names}`);
  }
  return {
    options: { ...options, goal: redactedGoal },
    layer2: {
      hits: result.entities.reduce((sum, entity) => sum + entity.count, 0),
      entities: result.entities.map((entity) => entity.type).toSorted(),
    },
    forcedReview: result.forcedReview,
  };
}
