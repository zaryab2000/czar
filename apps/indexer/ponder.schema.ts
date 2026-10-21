import { onchainTable } from "ponder";
import { index } from "drizzle-orm/pg-core";

export const vaults = onchainTable("vaults", (t) => ({
  id: t.text().primaryKey(),
  owner: t.text().notNull(),
  version: t.integer().notNull(),
  agentSigner: t.text().notNull(),
  autonomySigner: t.text().notNull(),
  evaluator: t.text().notNull(),
  createdBlock: t.bigint().notNull(),
}));

export const envelopes = onchainTable(
  "envelopes",
  (t) => ({
    id: t.text().primaryKey(),
    vault: t.text().notNull(),
    envelopeId: t.bigint().notNull(),
    envelopeRef: t.text().notNull(),
    mirror: t.jsonb().notNull(),
  }),
  (t) => ({ envelopeRefIdx: index("envelopes_envelope_ref_idx").on(t.envelopeRef) }),
);

export const reservations = onchainTable(
  "reservations",
  (t) => ({
    id: t.text().primaryKey(),
    vault: t.text().notNull(),
    reservationId: t.bigint().notNull(),
    envelopeId: t.bigint().notNull(),
    state: t.text().notNull(),
    validBefore: t.bigint().notNull(),
    mirror: t.jsonb().notNull(),
  }),
  (t) => ({
    vaultStateValidBeforeIdx: index("reservations_vault_state_valid_before_idx").on(
      t.vault,
      t.state,
      t.validBefore,
    ),
    vaultEnvelopeIdx: index("reservations_vault_envelope_idx").on(t.vault, t.envelopeId),
  }),
);

export const authorizations = onchainTable(
  "authorizations",
  (t) => ({
    id: t.text().primaryKey(),
    vault: t.text().notNull(),
    reservationId: t.bigint().notNull(),
    index: t.integer().notNull(),
    nonce: t.text().notNull(),
    amount: t.text().notNull(),
    used: t.boolean().notNull(),
    settled: t.boolean().notNull(),
    released: t.boolean().notNull(),
    settlementTx: t.text(),
    createdAt: t.text().notNull(),
  }),
  (t) => ({
    vaultUsedSettledIdx: index("authorizations_vault_used_settled_idx").on(
      t.vault,
      t.used,
      t.settled,
    ),
    nonceIdx: index("authorizations_nonce_idx").on(t.nonce),
    vaultReservationIndexIdx: index("authorizations_vault_reservation_index_idx").on(
      t.vault,
      t.reservationId,
      t.index,
    ),
  }),
);

export const pullbacks = onchainTable(
  "pullbacks",
  (t) => ({
    id: t.text().primaryKey(),
    vault: t.text().notNull(),
    pocket: t.text().notNull(),
    state: t.text().notNull(),
    transferSpecHash: t.text().notNull(),
    maxBlockHeight: t.bigint().notNull(),
    attested: t.boolean().notNull(),
  }),
  (t) => ({
    vaultStateAttestedIdx: index("pullbacks_vault_state_attested_idx").on(
      t.vault,
      t.state,
      t.attested,
    ),
    transferSpecHashIdx: index("pullbacks_transfer_spec_hash_idx").on(t.transferSpecHash),
    pocketIdx: index("pullbacks_pocket_idx").on(t.pocket),
  }),
);

export const pockets = onchainTable("pockets", (t) => ({
  id: t.text().primaryKey(),
  vault: t.text().notNull(),
  envelopeId: t.bigint().notNull(),
  mirror: t.jsonb().notNull(),
}));

export const jobs = onchainTable(
  "jobs",
  (t) => ({
    id: t.text().primaryKey(),
    vault: t.text().notNull(),
    envelopeId: t.bigint().notNull(),
    jobEscrow: t.text().notNull(),
    jobId: t.text().notNull(),
    state: t.text().notNull(),
    escrowState: t.text(),
    mirror: t.jsonb().notNull(),
  }),
  (t) => ({
    vaultStateIdx: index("jobs_vault_state_idx").on(t.vault, t.state),
    vaultEscrowStateIdx: index("jobs_vault_escrow_state_idx").on(t.vault, t.escrowState),
    jobEscrowJobIdIdx: index("jobs_escrow_job_id_idx").on(t.jobEscrow, t.jobId),
  }),
);

export const stepUsage = onchainTable("step_usage", (t) => ({
  id: t.text().primaryKey(),
  vault: t.text().notNull(),
  envelopeId: t.bigint().notNull(),
  stepIndex: t.integer().notNull(),
  used: t.text().notNull(),
  lastEventBlock: t.bigint().notNull(),
}));

export const indexedEvents = onchainTable("indexed_events", (t) => ({
  id: t.text().primaryKey(),
  emitter: t.text().notNull(),
  name: t.text().notNull(),
  block: t.bigint().notNull(),
}));

export const externalEvents = onchainTable("external_events", (t) => ({
  id: t.text().primaryKey(),
  emitter: t.text().notNull(),
  name: t.text().notNull(),
  block: t.bigint().notNull(),
  payload: t.jsonb().notNull(),
}));

export const anchors = onchainTable("anchors", (t) => ({
  id: t.text().primaryKey(),
  publisher: t.text().notNull(),
  kind: t.integer().notNull(),
  seq: t.text().notNull(),
  root: t.text().notNull(),
  prev: t.text().notNull(),
  uriHash: t.text().notNull(),
  uri: t.text().notNull(),
  batchRoot: t.text(),
  block: t.bigint().notNull(),
  transaction: t.text().notNull(),
}));

export const gatewayTransfers = onchainTable("gateway_transfers", (t) => ({
  transferId: t.text().primaryKey(),
  status: t.text().notNull(),
  fromAddress: t.text().notNull(),
  toAddress: t.text().notNull(),
  amount: t.text().notNull(),
  nonce: t.text().notNull(),
  txHash: t.text(),
  createdAt: t.text().notNull(),
  updatedAt: t.text().notNull(),
  pocketAddress: t.text(),
}));
