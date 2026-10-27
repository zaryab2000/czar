import { ponder } from "ponder:registry";
import { ping } from "ponder:schema";

ponder.on("Emitter:Ping", async ({ event, context }) => {
  await context.db.insert(ping).values({ block: event.block.number }).onConflictDoNothing();
});
