import { db } from "ponder:api";
import { createQueryStore } from "#src/api/store";
import { createIndexerApi } from "#src/api/router";

export default createIndexerApi(createQueryStore(db));
