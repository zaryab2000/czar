import { onchainTable } from "ponder";

export const ping = onchainTable("ping", (t) => ({
  block: t.bigint().primaryKey(),
}));
