import { db } from "ponder:api";
import * as schema from "ponder:schema";
import { createIndexerApi } from "#src/api/router";
import type { QueryDataSource, QueryRow } from "#src/api/types";

const source: QueryDataSource = {
  async rows(table) {
    return (await db.select().from(schema[table] as never)) as QueryRow[];
  },
};

export default createIndexerApi(source);
