import { db } from "ponder:api";
import { and, asc, eq, gt, lt, ne, or } from "drizzle-orm";
import * as schema from "ponder:schema";
import { reservations } from "ponder:schema";
import { createIndexerApi } from "#src/api/router";
import type { KeysetCursor, QueryDataSource, QueryRow } from "#src/api/types";

const source: QueryDataSource = {
  async rows(table) {
    return (await db.select().from(schema[table] as never)) as QueryRow[];
  },
  async pageReservationsNeedingFinalize(input: {
    now: number;
    cursor: KeysetCursor | null;
    limit: number;
  }) {
    const predicates = [
      lt(reservations.validBefore, BigInt(input.now)),
      ne(reservations.state, "Final"),
    ];
    if (input.cursor) {
      predicates.push(
        or(
          gt(reservations.validBefore, BigInt(input.cursor.validBefore)),
          and(
            eq(reservations.validBefore, BigInt(input.cursor.validBefore)),
            gt(reservations.id, input.cursor.id),
          ),
        ) as never,
      );
    }
    return (await db
      .select()
      .from(reservations)
      .where(and(...predicates))
      .orderBy(asc(reservations.validBefore), asc(reservations.id))
      .limit(input.limit)) as QueryRow[];
  },
};

export default createIndexerApi(source);
