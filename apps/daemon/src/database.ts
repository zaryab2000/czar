// Encrypted memory database (CZ-02 §5.3): better-sqlite3-multiple-ciphers 13.0.3 (B6-12), opened only
// with K14 from the keychain. File mode 0600. The cipher is set explicitly to SQLCipher's AES-256
// scheme because the binding's own default is ChaCha20 (SCR-105).
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";

export type MemoryDatabase = InstanceType<typeof Database>;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const KEY_HEX = /^[0-9a-f]{64}$/;
export const SCHEMA_VERSION = 1;

/** Raised when the file is not a database for this key (wrong key, missing key or corruption). */
export class DatabaseLockedError extends Error {
  constructor() {
    super("memory.db could not be opened with the keychain key");
    this.name = "DatabaseLockedError";
  }
}

/** Tables of CZ-02 §5.3. Column types follow the spec table; times are INTEGER milliseconds. */
const SCHEMA_V1 = `
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  host_version TEXT,
  session_ref BLOB,
  project_ref BLOB,
  event_type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  tool_name TEXT,
  mcp_server TEXT,
  mcp_tool TEXT,
  mcp_plugin TEXT,
  summary TEXT,
  file_refs BLOB,
  error_class TEXT,
  duration_ms INTEGER,
  agent_ref BLOB,
  provenance_json TEXT NOT NULL,
  redaction_hits INTEGER NOT NULL DEFAULT 0,
  content_hash BLOB NOT NULL UNIQUE,
  observation_hash BLOB
);
CREATE INDEX events_project_time ON events (project_ref, occurred_at);
CREATE INDEX events_type_time ON events (event_type, occurred_at);
CREATE INDEX events_session ON events (session_ref);
CREATE INDEX events_error_class ON events (error_class);

CREATE TABLE sessions (
  session_ref BLOB PRIMARY KEY,
  host TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  end_reason TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  project_ref BLOB
);

CREATE TABLE soul_versions (
  version INTEGER PRIMARY KEY,
  compiled_at INTEGER NOT NULL,
  previous_hash BLOB,
  soul_version_hash BLOB NOT NULL,
  soul_json TEXT NOT NULL,
  excerpt_chars INTEGER,
  model_prompt_hash BLOB,
  submitted_at INTEGER
);

CREATE TABLE beliefs (
  belief_id TEXT PRIMARY KEY,
  section TEXT NOT NULL,
  text TEXT NOT NULL,
  confidence REAL NOT NULL,
  first_seen INTEGER,
  last_seen INTEGER,
  user_edited INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  current_version INTEGER
);

CREATE TABLE belief_receipts (
  belief_id TEXT NOT NULL REFERENCES beliefs (belief_id),
  event_id TEXT NOT NULL,
  PRIMARY KEY (belief_id, event_id)
);

CREATE TABLE objectives (
  objective_id TEXT PRIMARY KEY,
  soul_version INTEGER,
  detector TEXT,
  goal TEXT,
  capabilities_json TEXT,
  deadline INTEGER,
  minutes_saved INTEGER,
  roi_band TEXT,
  roi_ratio REAL,
  status TEXT NOT NULL,
  objective_hash BLOB,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  server_status TEXT,
  result_id TEXT
);

CREATE TABLE objective_evidence (
  objective_id TEXT NOT NULL REFERENCES objectives (objective_id),
  event_id TEXT,
  belief_id TEXT
);

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('objective', 'soul-version', 'ingest-report', 'result-ack')),
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error_code TEXT
);

CREATE TABLE audit_local (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_hash BLOB NOT NULL,
  bytes INTEGER NOT NULL,
  destination TEXT NOT NULL CHECK (destination IN ('server', 'model-proxy')),
  summary_counts_json TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE queue_drain (
  plugin_data_path TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL
);
`;

export const TABLES = [
  "events",
  "sessions",
  "soul_versions",
  "beliefs",
  "belief_receipts",
  "objectives",
  "objective_evidence",
  "outbox",
  "audit_local",
  "settings",
  "queue_drain",
] as const;

function applyKey(db: MemoryDatabase, keyHex: string) {
  db.pragma("cipher = 'sqlcipher'");
  db.pragma(`key = "x'${keyHex}'"`);
}

/** Opens (and on first use creates and migrates) memory.db with K14. */
export function openMemoryDatabase(path: string, keyHex: string): MemoryDatabase {
  if (!KEY_HEX.test(keyHex)) throw new Error("K14 must be 64 lowercase hex characters");
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const db = new Database(path);
  try {
    applyKey(db, keyHex);
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch {
    db.close();
    throw new DatabaseLockedError();
  }
  chmodSync(path, FILE_MODE);
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version < SCHEMA_VERSION) {
    db.transaction(() => {
      db.exec(SCHEMA_V1);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }
  return db;
}
