// A loopback stand-in for the GCE metadata server and the Cloud KMS REST API (PM-014 smoke run).
// Test code only. The cloud signer reaches both through config keys (deploy.metadataTokenUrl,
// signer.kms.apiBaseUrl), so the smoke config points them here and no production code changes.
//
// It answers exactly the calls `openGcpKmsBackend` makes at start:
//   GET  <metadata token path>                       → a short-lived token
//   GET  /v1/<version>/publicKey                     → the PEM of an in-memory secp256k1 key
//   GET  /v1/<pocket ring>/cryptoKeys                → no pocket keys yet
// Signing is not part of a start-order smoke test, so `:asymmetricSign` answers 501 and the signer
// records `backend-error` with nothing signed, which is its fail-closed path.
//
// The key pair is generated at start, lives only in this process's memory and is never written,
// printed or logged. Nothing it can sign means anything on any chain.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const DEFAULT_PORT = 8931;
const MAX_PORT = 65535;
const TOKEN_LIFETIME_SECONDS = 3600;
const TOKEN_BYTES = 24;
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_NOT_IMPLEMENTED = 501;
export const METADATA_TOKEN_PATH = "/computeMetadata/v1/instance/service-accounts/default/token";
const KMS_ALGORITHM = "EC_SIGN_SECP256K1_SHA256";

export interface KmsFakeOptions {
  readonly port: number;
  /** Full `cryptoKeyVersions/N` resource names to serve a public key for. */
  readonly versions: readonly string[];
  /** The pocket key ring's resource name; listed as empty. */
  readonly pocketRing: string;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function startKmsFake(options: KmsFakeOptions) {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const pems = new Map(
    options.versions.map((version) => {
      const { publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
      return [version, publicKey.export({ format: "pem", type: "spki" }).toString()] as const;
    }),
  );

  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/health") return send(response, HTTP_OK, { ok: true });
    if (path === METADATA_TOKEN_PATH) {
      if (request.headers["metadata-flavor"] !== "Google")
        return send(response, HTTP_FORBIDDEN, { error: "missing Metadata-Flavor" });
      return send(response, HTTP_OK, {
        access_token: token,
        expires_in: TOKEN_LIFETIME_SECONDS,
        token_type: "Bearer",
      });
    }
    if (request.headers.authorization !== `Bearer ${token}`)
      return send(response, HTTP_UNAUTHORIZED, { error: "bad token" });
    if (request.method === "GET" && path === `/v1/${options.pocketRing}/cryptoKeys`)
      return send(response, HTTP_OK, {});
    const publicKey = /^\/v1\/(.+)\/publicKey$/.exec(path);
    if (request.method === "GET" && publicKey) {
      const pem = pems.get(publicKey[1] ?? "");
      if (pem === undefined) return send(response, HTTP_NOT_FOUND, { error: "no such version" });
      return send(response, HTTP_OK, { algorithm: KMS_ALGORITHM, pem });
    }
    return send(response, HTTP_NOT_IMPLEMENTED, { error: "not part of the smoke fake" });
  };

  const server = createServer(handle);
  return new Promise<{ readonly port: number; stop(): Promise<void> }>((resolveStart) => {
    server.listen(options.port, "127.0.0.1", () => {
      const address = server.address();
      resolveStart({
        port: typeof address === "object" && address !== null ? address.port : options.port,
        stop: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > MAX_PORT)
    throw new RangeError("CZAR_SMOKE_KMS_PORT must be an integer from 1 to 65535");
  return port;
}

/**
 * The key versions and pocket ring the signer will ask for, read from the same cloud parameter
 * file the signer reads (CZAR_CLOUD_CONFIG). The compose smoke run uses this, so no resource name
 * has to sit in a compose environment value.
 */
async function fromCloudConfig(): Promise<{ versions: string[]; pocketRing: string }> {
  const pointer = process.env["CZAR_CLOUD_CONFIG"];
  if (pointer === undefined || pointer === "") return { versions: [], pocketRing: "" };
  const { importFrom } = await import("./resolve-from.ts");
  const { loadConfigFile } = await importFrom<typeof import("@czar/config")>(
    "signer",
    "@czar/config",
  );
  const config = await loadConfigFile(pointer);
  const versions = Object.values(config.get("signer.kms.keyVersions") as Record<string, string>);
  const ring = [
    "projects",
    config.get("signer.kms.projectId"),
    "locations",
    config.get("signer.kms.location"),
    "keyRings",
    config.get("signer.kms.pocketKeyRing"),
  ].join("/");
  return { versions, pocketRing: ring };
}

if (import.meta.main) {
  const configured = await fromCloudConfig();
  const listed = (process.env["CZAR_SMOKE_KMS_VERSIONS"] ?? "").split(",").filter(Boolean);
  const versions = listed.length > 0 ? listed : configured.versions;
  const pocketRing = process.env["CZAR_SMOKE_KMS_POCKET_RING"] ?? configured.pocketRing;
  if (pocketRing === "") throw new Error("CZAR_SMOKE_KMS_POCKET_RING is not set");
  const running = await startKmsFake({
    port: parsePort(process.env["CZAR_SMOKE_KMS_PORT"]),
    versions,
    pocketRing,
  });
  process.stderr.write(`kms-fake: listening on 127.0.0.1:${running.port}\n`);
  const stop = () => void running.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
