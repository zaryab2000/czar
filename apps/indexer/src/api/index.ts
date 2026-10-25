import { db, publicClients } from "ponder:api";
import { createQueryStore } from "#src/api/store";
import { createIndexerApi } from "#src/api/router";

export default createIndexerApi(createQueryStore(db), undefined, () =>
  publicClients.arcTestnet.getBlockNumber(),
);
