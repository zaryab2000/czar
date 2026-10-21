import { Hono } from "hono";
import { db } from "ponder:api";
import {
  envelopes,
  externalEvents,
  jobs,
  pockets,
  reservations,
  stepUsage,
  vaults,
} from "ponder:schema";

const app = new Hono();

app.get("/mirrors", async (c) =>
  c.json({
    vaults: (await db.select().from(vaults)).map((row) => row.id),
    envelopes: (await db.select().from(envelopes)).map((row) => row.mirror),
    reservations: (await db.select().from(reservations)).map((row) => row.mirror),
    pockets: (await db.select().from(pockets)).map((row) => row.mirror),
    jobs: (await db.select().from(jobs)).map((row) => row.mirror),
    steps: (await db.select().from(stepUsage)).map((row) => ({
      envelopeId: row.envelopeId.toString(),
      stepIndex: row.stepIndex,
      used: row.used,
    })),
  }),
);

app.get("/external-events", async (c) =>
  c.json(
    (await db.select().from(externalEvents)).map((row) => ({
      name: row.name,
      emitter: row.emitter,
      payload: row.payload,
    })),
  ),
);

export default app;
