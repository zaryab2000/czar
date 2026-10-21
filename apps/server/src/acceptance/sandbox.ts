import { Worker } from "node:worker_threads";
import { keccak256, toBytes } from "viem";
import type { Config } from "@czar/config";

export interface SandboxInput {
  readonly paid: boolean;
  readonly responseArrived: boolean;
  readonly statusCode: number | null;
  readonly elapsedMs: number;
  readonly maxTimeoutSeconds: number;
  readonly bodyText: string | null;
  readonly bodyBytes: number;
  readonly mimeType: string;
  readonly expectedKeys: readonly string[];
  readonly historyShapeHash: string | null;
  readonly deliveredAsIs: boolean;
  readonly outputFormat?: string;
}

export interface SandboxCheck {
  readonly name: "delivery" | "structural" | "requirement";
  readonly result: "pass" | "fail" | "inconclusive" | "not_checked";
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface SandboxOutcome {
  readonly checks: readonly SandboxCheck[];
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly limits: readonly string[];
}

interface WorkerReply {
  readonly ok: boolean;
  readonly checks?: readonly SandboxCheck[];
}

export function executorHash(executorSource: string): `0x${string}` {
  return keccak256(toBytes(executorSource));
}

export async function runSandboxedChecks(args: {
  readonly executorSource: string;
  readonly input: SandboxInput;
  readonly outputSchema: Readonly<Record<string, unknown>> | null;
  readonly config: Config;
}): Promise<SandboxOutcome> {
  const started = performance.now();
  const maxBodyBytes = Number(args.config.get("acceptance.maxBodyBytes"));
  const input =
    args.input.bodyBytes > maxBodyBytes ? { ...args.input, bodyText: null } : args.input;
  const copiedInput = JSON.parse(JSON.stringify(input)) as SandboxInput;
  const schema = prepareSchema(
    args.outputSchema,
    Number(args.config.get("acceptance.schemaMaxBytes")),
  );
  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    workerData: {
      executorSource: args.executorSource,
      input: copiedInput,
      outputSchema: schema.value,
      schemaOversized: schema.oversized,
      limits: {
        deliveryTimeoutMs: Number(args.config.get("acceptance.deliveryTimeoutMs")),
        maxBodyBytes: Number(args.config.get("acceptance.maxBodyBytes")),
        schemaMaxBytes: Number(args.config.get("acceptance.schemaMaxBytes")),
      },
    },
    resourceLimits: {
      maxOldGenerationSizeMb: Number(args.config.get("acceptance.sandboxMemoryMb")),
    },
  });
  const timeoutMs = Number(args.config.get("acceptance.sandboxTimeoutMs"));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reply: WorkerReply | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve({
        checks: reply?.ok ? (reply.checks ?? []) : timeoutChecks(),
        timedOut: reply?.ok !== true,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        limits: reply?.ok ? [] : ["sandbox-timeout"],
      });
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    worker.once("message", (reply: WorkerReply) => finish(reply));
    worker.once("error", () => finish(null));
    worker.once("exit", (code) => {
      if (code !== 0) finish(null);
    });
  });
}

function prepareSchema(
  schema: Readonly<Record<string, unknown>> | null,
  maxBytes: number,
): { readonly value: Readonly<Record<string, unknown>> | null; readonly oversized: boolean } {
  if (schema === null) return { value: null, oversized: false };
  try {
    const serialized = JSON.stringify(schema);
    if (Buffer.byteLength(serialized, "utf8") > maxBytes) return { value: null, oversized: true };
    const copied: unknown = JSON.parse(serialized);
    if (copied === null || Array.isArray(copied) || typeof copied !== "object")
      return { value: null, oversized: true };
    return { value: copied as Readonly<Record<string, unknown>>, oversized: false };
  } catch {
    return { value: null, oversized: true };
  }
}

function timeoutChecks(): SandboxCheck[] {
  return ["delivery", "structural", "requirement"].map((name) => ({
    name: name as SandboxCheck["name"],
    result: "inconclusive",
    detail: { reason: "sandbox-timeout" },
  }));
}
