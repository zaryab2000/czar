import { Buffer } from "node:buffer";
import { loadConfig, type Config } from "@czar/config";
import {
  validateEnvelope,
  validateJobRecord,
  validatePocketRecord,
  validateReservation,
} from "@czar/schemas";
import { derivedNonce } from "@czar/hashing";
import { Hono } from "hono";
import type { Context } from "hono";
import type { MirrorRecord, QueryDataSource, QueryRow } from "#src/api/types";

const JOB_EVENT_STATE: Readonly<Record<string, string>> = {
  JobCreated: "Opened",
  BudgetSet: "Opened",
  JobFunded: "Funded",
  JobSubmitted: "Submitted",
  JobCompleted: "Completed",
  JobRejected: "Rejected",
  JobExpired: "Expired",
  Refunded: "Refunded",
  PaymentReleased: "Released",
};
export function createIndexerApi(source: QueryDataSource, config: Config = loadConfig()): Hono {
  const app = new Hono();
  app.get("/envelopes/:envelopeRef", async (context) => {
    const ref = decodeURIComponent(context.req.param("envelopeRef"));
    const envelopeRow = (await source.rows("envelopes")).find(
      (row) => mirror(row)["envelopeRef"] === ref,
    );
    if (!envelopeRow) return context.json({ error: "not-found" }, 404);
    const envelope = mirror(envelopeRow);
    assertMirror(validateEnvelope, envelope, "Envelope");
    const envelopeId = Number(envelope["envelopeId"]);
    const vault = String(envelope["vault"]).toLowerCase();
    const reservations = await validatedMirrors(
      source,
      "reservations",
      validateReservation,
      (item) =>
        Number(item["envelopeId"]) === envelopeId && String(item["vault"]).toLowerCase() === vault,
    );
    const pockets = await validatedMirrors(
      source,
      "pockets",
      validatePocketRecord,
      (item) =>
        Number(item["envelopeId"]) === envelopeId && String(item["vault"]).toLowerCase() === vault,
    );
    const jobs = await validatedMirrors(
      source,
      "jobs",
      validateJobRecord,
      (item) =>
        Number(item["envelopeId"]) === envelopeId && String(item["vault"]).toLowerCase() === vault,
    );
    return context.json({ envelope, reservations, pockets, jobs });
  });

  app.get("/reservations/needing-settle", async (context) => {
    const vault = context.req.query("vault")?.toLowerCase();
    if (!vault) return context.json({ error: "vault-required" }, 400);
    const reservations = await validatedMirrors(
      source,
      "reservations",
      validateReservation,
      (item) =>
        String(item["vault"]).toLowerCase() === vault &&
        ["Active", "Finalizing"].includes(String(item["state"])),
    );
    const events = await source.rows("externalEvents");
    const used = new Set(
      events
        .filter((row) => row.name === "AuthorizationUsed")
        .map((row) => String(payload(row)["nonce"]).toLowerCase()),
    );
    const pending = reservations.filter((item) => {
      const count = Number(item["count"]);
      for (let index = 0; index < count; index += 1) {
        const mask = BigInt(String(item["settledMask"]));
        if (
          ((mask >> BigInt(index)) & 1n) === 0n &&
          used.has(
            derivedNonce(vault as `0x${string}`, BigInt(String(item["reservationId"])), index),
          )
        )
          return true;
      }
      return false;
    });
    return pageResponse(
      context,
      config,
      "reservations-needing-settle",
      pending,
      validateReservation,
    );
  });

  app.get("/reservations/needing-finalize", async (context) => {
    const now = integerQuery(context.req.query("now"));
    if (now === null) return context.json({ error: "invalid-now" }, 400);
    const items = await validatedMirrors(
      source,
      "reservations",
      validateReservation,
      (item) => Number(item["validBefore"]) < now && item["state"] !== "Final",
    );
    return pageResponse(
      context,
      config,
      "reservations-needing-finalize",
      items,
      validateReservation,
    );
  });

  app.get("/pullbacks/to-confirm", async (context) => {
    const attested = new Set(
      (await source.rows("externalEvents"))
        .filter((row) => row.name === "AttestationUsed")
        .map((row) => String(payload(row)["transferSpecHash"]).toLowerCase()),
    );
    const items = await pullbacks(
      source,
      (item) =>
        item["state"] === "Pending" && attested.has(String(item["transferSpecHash"]).toLowerCase()),
    );
    return pageResponse(context, config, "pullbacks-to-confirm", items, validatePullbackSelection);
  });

  app.get("/pullbacks/to-cancel", async (context) => {
    const block = integerQuery(context.req.query("block"));
    if (block === null) return context.json({ error: "invalid-block" }, 400);
    const delay = Number(config.get("indexer.pullbackCancelDelayBlocks"));
    const attested = new Set(
      (await source.rows("externalEvents"))
        .filter((row) => row.name === "AttestationUsed")
        .map((row) => String(payload(row)["transferSpecHash"]).toLowerCase()),
    );
    const items = await pullbacks(
      source,
      (item, pocket) =>
        item["state"] === "Pending" &&
        Number(item["requestedAtBlock"]) + delay <= block &&
        !attested.has(String(item["transferSpecHash"]).toLowerCase()) &&
        Boolean(pocket),
    );
    return pageResponse(context, config, "pullbacks-to-cancel", items, validatePullbackSelection);
  });

  app.get("/jobs/to-sync", async (context) => {
    const events = await source.rows("externalEvents");
    const items = await validatedMirrors(source, "jobs", validateJobRecord, (item) => {
      const newest = events
        .filter(
          (event) =>
            String(event.emitter).toLowerCase() === String(item["jobEscrow"]).toLowerCase() &&
            String(payload(event)["jobId"]) === String(item["jobId"]) &&
            JOB_EVENT_STATE[String(event.name)] !== undefined,
        )
        .toSorted((a, b) => Number(b.block) - Number(a.block))[0];
      return Boolean(newest && JOB_EVENT_STATE[String(newest.name)] !== item["state"]);
    });
    return pageResponse(context, config, "jobs-to-sync", items, validateJobRecord);
  });

  app.get("/jobs/awaiting-evaluation", async (context) => {
    const events = await source.rows("externalEvents");
    const items = await validatedMirrors(
      source,
      "jobs",
      validateJobRecord,
      (item) =>
        item["state"] === "Submitted" &&
        !events.some(
          (event) =>
            String(event.emitter).toLowerCase() === String(item["jobEscrow"]).toLowerCase() &&
            String(payload(event)["jobId"]) === String(item["jobId"]) &&
            ["JobCompleted", "JobRejected", "JobExpired"].includes(String(event.name)),
        ),
    );
    return pageResponse(context, config, "jobs-awaiting-evaluation", items, validateJobRecord);
  });

  app.get("/receipts", async (context) => {
    const vault = context.req.query("vault")?.toLowerCase();
    if (!vault) return context.json({ error: "vault-required" }, 400);
    return context.json({ items: [], nextCursor: null });
  });

  app.get("/anchors/latest", async (context) => {
    const publisher = context.req.query("publisher")?.toLowerCase();
    const kind = integerQuery(context.req.query("kind"));
    if (!publisher || kind === null) return context.json({ error: "invalid-anchor-query" }, 400);
    const anchor = (await source.rows("anchors"))
      .filter((row) => String(row.publisher).toLowerCase() === publisher && Number(row.kind) === kind)
      .toSorted((left, right) => compareIntegers(String(right.seq), String(left.seq)))[0];
    return context.json(anchor ? {
      root: anchor.root,
      seq: String(anchor.seq),
      block: String(anchor.block),
      transaction: anchor.transaction,
    } : null);
  });

  app.get("/anchors/:root", async (context) => {
    const root = context.req.param("root").toLowerCase();
    const anchor = (await source.rows("anchors")).find(
      (row) => String(row.root).toLowerCase() === root || String(row["batchRoot"]).toLowerCase() === root,
    );
    return context.json(anchor ?? null);
  });
  return app;
}

async function validatedMirrors(
  source: QueryDataSource,
  table: "envelopes" | "reservations" | "pockets" | "jobs",
  validate: (value: unknown) => boolean,
  filter: (item: Record<string, unknown>) => boolean,
): Promise<MirrorRecord[]> {
  return (await source.rows(table))
    .map(mirror)
    .filter(filter)
    .map((item) => {
      assertMirror(validate, item, table);
      return item;
    });
}

async function pullbacks(
  source: QueryDataSource,
  filter: (item: Record<string, unknown>, pocket: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  for (const row of await source.rows("pockets")) {
    const pocket = mirror(row);
    assertMirror(validatePocketRecord, pocket, "PocketRecord");
    for (const item of pocket["pullbacks"] as Record<string, unknown>[]) {
      if (filter(item, pocket)) items.push({ pocketRecord: pocket, pullback: item });
    }
  }
  return items;
}

function pageResponse(
  context: Context,
  config: Config,
  route: string,
  input: Record<string, unknown>[],
  validate: (value: unknown) => boolean,
) {
  const max = Number(config.get("api.pageMaxLimit"));
  const min = Number(config.get("api.pageMinLimit"));
  const fallback = Number(config.get("api.pageDefaultLimit"));
  const raw = context.req.query("limit");
  const limit = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(limit) || limit < min || limit > max)
    return context.json({ error: "invalid-limit" }, 400);
  const scope = cursorScope(context, route);
  const offset = decodeCursor(context.req.query("cursor"), scope, config);
  if (offset === null) return context.json({ error: "invalid-cursor" }, 400);
  const items = input
    .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    .slice(offset, offset + limit);
  items.forEach((item) => assertMirror(validate, item, route));
  const next =
    offset + items.length < input.length
      ? encodeCursor(offset + items.length, scope, config)
      : null;
  return context.json({ items, nextCursor: next });
}

function cursorScope(context: Context, route: string): string {
  const params = new URL(context.req.url).searchParams;
  params.delete("cursor");
  const query = [...params.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return `${route}?${query}`;
}

function encodeCursor(offset: number, route: string, config: Config): string {
  const expiresAt = Date.now() + Number(config.get("api.cursorTtlMinutes")) * 60_000;
  return Buffer.from(JSON.stringify({ route, offset, expiresAt })).toString("base64url");
}

function decodeCursor(cursor: string | undefined, route: string, config: Config): number | null {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      value["route"] !== route ||
      !Number.isInteger(value["offset"]) ||
      Number(value["offset"]) < 0 ||
      Number(value["expiresAt"]) <= Date.now() ||
      Number(value["expiresAt"]) > Date.now() + Number(config.get("api.cursorTtlMinutes")) * 60_000
    )
      return null;
    return Number(value["offset"]);
  } catch {
    return null;
  }
}

function mirror(row: QueryRow): MirrorRecord {
  return row.mirror as MirrorRecord;
}

function payload(row: QueryRow): QueryRow {
  return row.payload as QueryRow;
}

function integerQuery(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

function compareIntegers(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function assertMirror(validate: (value: unknown) => boolean, value: unknown, label: string): void {
  if (!validate(value)) throw new Error(`Indexed ${label} failed @czar/schemas validation`);
}

function validatePullbackSelection(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const selection = value as Record<string, unknown>;
  const pocket = selection["pocketRecord"];
  const pullback = selection["pullback"];
  if (!validatePocketRecord(pocket) || !pullback || typeof pullback !== "object") return false;
  return (pocket.pullbacks as unknown[]).includes(pullback);
}
