import { onchainTable } from "ponder";

export const vaults = onchainTable("vaults", (t) => ({
  id: t.text().primaryKey(),
  owner: t.text().notNull(),
  version: t.integer().notNull(),
  agentSigner: t.text().notNull(),
  autonomySigner: t.text().notNull(),
  evaluator: t.text().notNull(),
  createdBlock: t.bigint().notNull(),
}));

export const envelopes = onchainTable("envelopes", (t) => ({
  id: t.text().primaryKey(),
  vault: t.text().notNull(),
  envelopeId: t.bigint().notNull(),
  mirror: t.jsonb().notNull(),
}));

export const reservations = onchainTable("reservations", (t) => ({
  id: t.text().primaryKey(),
  vault: t.text().notNull(),
  reservationId: t.bigint().notNull(),
  mirror: t.jsonb().notNull(),
}));

export const pockets = onchainTable("pockets", (t) => ({
  id: t.text().primaryKey(),
  vault: t.text().notNull(),
  envelopeId: t.bigint().notNull(),
  mirror: t.jsonb().notNull(),
}));

export const jobs = onchainTable("jobs", (t) => ({
  id: t.text().primaryKey(),
  vault: t.text().notNull(),
  envelopeId: t.bigint().notNull(),
  mirror: t.jsonb().notNull(),
}));

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
