// CZ-19 §5.4 query routes (T-034, SCR-119). Internal API for CZ-12, CZ-15, CZ-16, CZ-17 and CZ-25.
// `dependencyState` is served by T-033 with `halt_flags` (SCR-119).
import { Buffer } from "node:buffer";
import { loadConfig, type Config } from "@czar/config";
import {
  validateEnvelope,
  validateJobRecord,
  validatePocketRecord,
  validateReservation,
  validationErrors,
} from "@czar/schemas";
import { Hono } from "hono";
import type { Context } from "hono";
import type { IdCursor, Keyed, QueryStore, ReceiptCursor } from "#src/api/store";

type Validate = (value: unknown) => boolean;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH32 = /^0x[0-9a-f]{64}$/;
const UINT = /^(0|[1-9][0-9]*)$/;

export function createIndexerApi(store: QueryStore, config: Config = loadConfig()): Hono {
  const app = new Hono();
  const clock = { now: () => Date.now() };

  app.get("/envelopes/:envelopeRef", async (context) => {
    const found = await store.envelopeByRef(context.req.param("envelopeRef"));
    if (!found) return problem(context, 404, "not-found");
    assertValid(validateEnvelope, found.envelope, "Envelope");
    found.reservations.forEach((item) => assertValid(validateReservation, item, "Reservation"));
    found.pockets.forEach(assertPocketProjection);
    found.jobs.forEach((item) => assertValid(validateJobRecord, item, "JobRecord"));
    return context.json(found);
  });

  app.get("/reservations/needing-settle", async (context) => {
    const vault = context.req.query("vault")?.toLowerCase();
    if (!vault || !ADDRESS.test(vault)) return problem(context, 400, "validation");
    return idPage(
      context,
      config,
      clock,
      "reservations-needing-settle",
      (cursor, limit) => store.reservationsNeedingSettle(vault, cursor, limit),
      (item) => assertValid(validateReservation, item, "Reservation"),
    );
  });

  app.get("/reservations/needing-finalize", async (context) => {
    const now = uintQuery(context.req.query("now"));
    if (now === null) return problem(context, 400, "validation");
    return idPage(
      context,
      config,
      clock,
      "reservations-needing-finalize",
      (cursor, limit) => store.reservationsNeedingFinalize(now, cursor, limit),
      (item) => assertValid(validateReservation, item, "Reservation"),
    );
  });

  app.get("/pullbacks/to-confirm", async (context) =>
    idPage(context, config, clock, "pullbacks-to-confirm", (cursor, limit) =>
      store.pullbacksToConfirm(cursor, limit),
    ),
  );

  app.get("/pullbacks/to-cancel", async (context) => {
    const block = uintQuery(context.req.query("block"));
    if (block === null) return problem(context, 400, "validation");
    return idPage(context, config, clock, "pullbacks-to-cancel", (cursor, limit) =>
      store.pullbacksToCancel(block, cursor, limit),
    );
  });

  app.get("/jobs/to-sync", async (context) =>
    idPage(
      context,
      config,
      clock,
      "jobs-to-sync",
      (cursor, limit) => store.jobsToSync(cursor, limit),
      (item) => assertValid(validateJobRecord, item["job"], "JobRecord"),
    ),
  );

  app.get("/jobs/awaiting-evaluation", async (context) =>
    idPage(
      context,
      config,
      clock,
      "jobs-awaiting-evaluation",
      (cursor, limit) => store.jobsAwaitingEvaluation(cursor, limit),
      (item) => assertValid(validateJobRecord, item, "JobRecord"),
    ),
  );

  app.get("/receipts", async (context) => {
    const vault = context.req.query("vault")?.toLowerCase();
    if (!vault || !ADDRESS.test(vault)) return problem(context, 400, "validation");
    const limit = pageLimit(context, config);
    if (limit === null) return problem(context, 400, "validation");
    const scope = cursorScope(context, "receipts");
    const decoded = decodeCursor(context.req.query("cursor"), scope, clock);
    if (decoded === undefined) return problem(context, 400, "validation");
    const position = decoded as ReceiptCursor | null;
    if (position && (typeof position.createdAt !== "string" || typeof position.id !== "string")) {
      return problem(context, 400, "validation");
    }
    const rows = await store.receiptsForLedger(vault, position, limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const nextCursor =
      rows.length > limit && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id }, scope, config, clock)
        : null;
    return context.json({ items, nextCursor });
  });

  app.get("/anchors/latest", async (context) => {
    const publisher = context.req.query("publisher")?.toLowerCase();
    const kind = uintQuery(context.req.query("kind"));
    if (!publisher || !ADDRESS.test(publisher) || kind === null || kind > 255n) {
      return problem(context, 400, "validation");
    }
    return context.json(await store.latestAnchor(publisher, Number(kind)));
  });

  app.get("/anchors/by-batch/:root", async (context) => {
    const root = context.req.param("root").toLowerCase();
    if (!HASH32.test(root)) return problem(context, 400, "validation");
    return context.json(await store.anchorByBatch(root));
  });

  app.get("/dependency-state", async (context) =>
    context.json({ items: await store.dependencyState() }),
  );

  return app;
}

async function idPage(
  context: Context,
  config: Config,
  clock: { now(): number },
  route: string,
  read: (cursor: IdCursor | null, limit: number) => Promise<Keyed[]>,
  check: (item: Record<string, unknown>) => void = () => undefined,
): Promise<Response> {
  const limit = pageLimit(context, config);
  if (limit === null) return problem(context, 400, "validation");
  const scope = cursorScope(context, route);
  const decoded = decodeCursor(context.req.query("cursor"), scope, clock);
  if (decoded === undefined) return problem(context, 400, "validation");
  const position = decoded as IdCursor | null;
  if (position && typeof position.after !== "string") return problem(context, 400, "validation");
  const rows = await read(position, limit + 1);
  const page = rows.slice(0, limit);
  page.forEach((row) => check(row.item));
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last ? encodeCursor({ after: last.key }, scope, config, clock) : null;
  return context.json({ items: page.map((row) => row.item), nextCursor });
}

function pageLimit(context: Context, config: Config): number | null {
  const raw = context.req.query("limit");
  const limit = raw === undefined ? Number(config.get("api.pageDefaultLimit")) : Number(raw);
  if (raw !== undefined && !UINT.test(raw)) return null;
  if (
    !Number.isSafeInteger(limit) ||
    limit < Number(config.get("api.pageMinLimit")) ||
    limit > Number(config.get("api.pageMaxLimit"))
  ) {
    return null;
  }
  return limit;
}

/** The query string minus `cursor` and `limit`: a cursor only continues the query that issued it. */
function cursorScope(context: Context, route: string): string {
  const params = new URL(context.req.url).searchParams;
  params.delete("cursor");
  params.delete("limit");
  const query = [...params.entries()]
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return `${route}?${query}`;
}

function encodeCursor(
  position: IdCursor | ReceiptCursor,
  scope: string,
  config: Config,
  clock: { now(): number },
): string {
  const expiresAt = clock.now() + Number(config.get("api.cursorTtlMinutes")) * 60_000;
  return Buffer.from(JSON.stringify({ scope, position, expiresAt })).toString("base64url");
}

/** `null` for no cursor, `undefined` for an invalid, foreign or expired cursor. */
function decodeCursor(
  cursor: string | undefined,
  scope: string,
  clock: { now(): number },
): IdCursor | ReceiptCursor | null | undefined {
  if (cursor === undefined) return null;
  if (cursor.length === 0 || cursor.length > 512) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      scope?: unknown;
      position?: unknown;
      expiresAt?: unknown;
    };
    if (value.scope !== scope) return undefined;
    if (typeof value.expiresAt !== "number" || value.expiresAt <= clock.now()) return undefined;
    if (typeof value.position !== "object" || value.position === null) return undefined;
    return value.position as IdCursor | ReceiptCursor;
  } catch {
    return undefined;
  }
}

function uintQuery(value: string | undefined): bigint | null {
  return value !== undefined && UINT.test(value) && value.length <= 20 ? BigInt(value) : null;
}

function problem(context: Context, status: 400 | 404, czarCode: string): Response {
  return context.json({ czarCode }, status);
}

function assertValid(validate: Validate, value: unknown, label: string): void {
  if (!validate(value)) throw new Error(`Indexed ${label} failed @czar/schemas validation`);
}

/** The indexer never holds `keyRef` (SO provenance, SCR-114); every other PocketRecord rule applies. */
function assertPocketProjection(value: unknown): void {
  if (validatePocketRecord(value)) return;
  const errors = validationErrors("pocket-record");
  const onlyKeyRef = errors.every(
    (error) => error.keyword === "required" && error.params["missingProperty"] === "keyRef",
  );
  if (!onlyKeyRef) throw new Error("Indexed PocketRecord failed @czar/schemas validation");
}
