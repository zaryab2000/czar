export const QUERY_TABLES = [
  "envelopes",
  "reservations",
  "pockets",
  "jobs",
  "externalEvents",
  "anchors",
  "gatewayTransfers",
] as const;

export type QueryTable = (typeof QUERY_TABLES)[number];
export interface QueryRow extends Record<string, unknown> {
  id?: string;
  mirror?: Record<string, unknown>;
  vault?: string;
  envelopeId?: bigint | number;
  reservationId?: bigint | number;
  state?: string;
  validBefore?: bigint | number;
  emitter?: string;
  name?: string;
  block?: bigint | number;
  payload?: Record<string, unknown>;
  publisher?: string;
  kind?: number;
  seq?: string;
  root?: string;
  prev?: string;
  uriHash?: string;
  uri?: string;
  transaction?: string;
}

export interface MirrorRecord extends Record<string, unknown> {
  envelopeRef?: string;
  envelopeId?: number;
  vault?: string;
  state?: string;
  validBefore?: number;
  count?: number;
  settledMask?: string;
  reservationId?: number;
  transferSpecHash?: string;
  requestedAtBlock?: number;
  jobEscrow?: string;
  jobId?: string;
  pullbacks?: unknown;
}
export type QueryRows = Record<QueryTable, QueryRow[]>;

export interface KeysetCursor {
  validBefore: number;
  id: string;
}

export interface QueryDataSource {
  rows(table: QueryTable): Promise<readonly QueryRow[]>;
  pageReservationsNeedingFinalize(input: {
    now: number;
    cursor: KeysetCursor | null;
    limit: number;
  }): Promise<readonly QueryRow[]>;
}
