import { Hono } from "hono";
import { db } from "ponder:api";
import { ping } from "ponder:schema";

const app = new Hono();

// Rows indexed so far; the resume test compares it with the logs the chain holds.
app.get("/pings", async (c) => c.json({ count: (await db.select().from(ping)).length }));

export default app;
