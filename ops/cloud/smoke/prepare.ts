// One-shot state for the PM-014 compose smoke run (ops/cloud/compose.smoke.yaml). Test code only.
//
// On the VM, czar-secrets.service fills /run/czar/secrets/<service> from Secret Manager and
// cloud-init creates /run/czar/signer and /var/lib/czar/objects. A developer machine has neither,
// so this job creates the same layout inside the smoke volume (mounted at /smoke), with the same
// owners and modes (secrets.list; SCR-170 §4):
//
//   secrets/<service>/...   0400 files, owned by the UID that reads them
//   run/signer              0750, 10002:10010 (the signer socket folder)
//   objects                 0750, 10001 (deploy.objectStorePath)
//
// Every credential is random, generated here and never printed. A file that already exists is kept,
// so a re-run matches the passwords already set in the smoke Postgres volume.
import { randomBytes } from "node:crypto";
import { chownSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = "/smoke";
const APP_UID = 10001;
const SIGNER_UID = 10002;
const SIGNER_CLIENT_GID = 10010;
const POSTGRES_IMAGE_UID = 999;
const PASSWORD_BYTES = 24;
const TOKEN_BYTES = 24;
const FILE_MODE = 0o400;
const SECRET_DIR_MODE = 0o500;
const SHARED_DIR_MODE = 0o750;

const random = (bytes: number) => randomBytes(bytes).toString("hex");

function directory(path: string, uid: number, gid: number, mode: number): void {
  mkdirSync(path, { recursive: true, mode });
  chownSync(path, uid, gid);
}

function secret(relative: string, value: string, uid: number): void {
  const path = join(ROOT, "secrets", relative);
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { mode: FILE_MODE });
  chownSync(path, uid, uid);
}

const roles = {
  server: "czar_api",
  signer: "czar_signer",
  indexer: "czar_indexer",
  merchants: "czar_merchants",
  backup: "czar_backup",
} as const;
const ROOT_UID = 0;
// As secrets.list: the signer 10002, the root-only backup folder 0, every other image 10001.
const uidOf = (service: string) =>
  service === "signer" ? SIGNER_UID : service === "backup" ? ROOT_UID : APP_UID;

for (const [service, role] of Object.entries(roles)) {
  const password = random(PASSWORD_BYTES);
  // Written to both folders in one pass, so the role and its service always agree.
  if (!existsSync(join(ROOT, "secrets", service, "db-password"))) {
    secret(`${service}/db-password`, password, uidOf(service));
    secret(`postgres-init/${role}`, password, POSTGRES_IMAGE_UID);
  }
}
// The signer loads an expected token for every caller in SOCKET_SERVICES at start.
for (const client of ["server", "merchants", "relayer-jobs"]) {
  const token = random(TOKEN_BYTES);
  if (existsSync(join(ROOT, "secrets/signer/client-tokens", client))) continue;
  secret(`signer/client-tokens/${client}`, token, SIGNER_UID);
  if (client !== "relayer-jobs") secret(`${client}/signer-token`, token, APP_UID);
}

for (const service of ["server", "signer", "indexer", "merchants", "backup"])
  directory(join(ROOT, "secrets", service), uidOf(service), uidOf(service), SECRET_DIR_MODE);
directory(join(ROOT, "secrets/signer/client-tokens"), SIGNER_UID, SIGNER_UID, SECRET_DIR_MODE);
directory(
  join(ROOT, "secrets/postgres-init"),
  POSTGRES_IMAGE_UID,
  POSTGRES_IMAGE_UID,
  SECRET_DIR_MODE,
);
directory(join(ROOT, "run/signer"), SIGNER_UID, SIGNER_CLIENT_GID, SHARED_DIR_MODE);
directory(join(ROOT, "objects"), APP_UID, APP_UID, SHARED_DIR_MODE);
process.stderr.write("smoke-prepare: state ready\n");
