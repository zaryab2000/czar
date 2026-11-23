import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, chown, lstat, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { loadConfig } from "@czar/config";
import type { Address } from "@czar/hashing";
import type { AuditSink, SignRequest, SignResult, Signer } from "./service.ts";
import { Denied } from "./policy.ts";
import type { KeychainOpen } from "./passphrase.ts";
import { expandHome } from "./local-backend.ts";

const SOCKET_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
/**
 * With `signer.socketGroupGid` set (SCR-170 §4) the socket's group may open it, so clients running as
 * another UID can connect. The owner checks still require the signer's own UID.
 */
const GROUP_SOCKET_MODE = 0o660;
const GROUP_DIRECTORY_MODE = 0o750;
const MAX_LINE_BYTES = 1_048_576;
export const SOCKET_SERVICES = ["server", "merchants", "relayer-jobs"] as const;
export type SignerService = (typeof SOCKET_SERVICES)[number];

export interface SignerSocketIdentity {
  tokenFor(service: string): Promise<string | undefined>;
  load?(): Promise<void>;
}

export function keychainSignerIdentity(
  keychainService: string,
  open: KeychainOpen = openKeychain,
): SignerSocketIdentity {
  const tokens = new Map<string, string>();
  return {
    async load() {
      await Promise.all(
        SOCKET_SERVICES.map(async (service) => {
          const token = await readToken(keychainService, service, open);
          tokens.set(service, token);
        }),
      );
    },
    async tokenFor(service) {
      if (!SOCKET_SERVICES.includes(service as SignerService)) return undefined;
      let token = tokens.get(service);
      if (token !== undefined) return token;
      token = await readToken(keychainService, service, open);
      tokens.set(service, token);
      return token;
    },
  };
}

export interface SignerSocketOptions {
  readonly socketPath: string;
  readonly signer: Pick<Signer, "sign" | "createPocketKey" | "keyAddress">;
  readonly audit: AuditSink;
  readonly identity: SignerSocketIdentity;
  readonly allowedCallers: Readonly<Record<string, readonly string[]>>;
  /**
   * `signer.socketGroupGid` (SCR-170 §4). Unset keeps today's owner-only socket: folder 0700, socket
   * 0600. Set makes the folder 0750 and the socket 0660, group-owned by that GID.
   */
  readonly socketGroupGid?: number;
}

export async function startSignerSocket(
  options: SignerSocketOptions,
): Promise<() => Promise<void>> {
  const socketPath = resolve(expandHome(options.socketPath));
  const gid = options.socketGroupGid;
  await options.identity.load?.();
  await ensurePrivateSocketDirectory(dirname(socketPath), gid);
  await clearOwnedSocket(socketPath);
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    handleSocket(socket, options);
  });
  await listen(server, socketPath);
  try {
    if (gid === undefined) {
      await chmod(socketPath, SOCKET_MODE);
    } else {
      await chown(socketPath, ownUid(), gid);
      await chmod(socketPath, GROUP_SOCKET_MODE);
    }
    await verifyOwnedSocket(socketPath, gid);
  } catch (error) {
    await closeServer(server);
    await unlink(socketPath).catch(ignoreMissingSocket);
    throw error;
  }
  return async () => {
    for (const client of clients) client.destroy();
    await closeServer(server);
    await unlink(socketPath).catch(ignoreMissingSocket);
  };
}

export interface SignerClientOptions {
  readonly socketPath: string;
  readonly service: SignerService;
  readonly identity?: SignerSocketIdentity;
  readonly keychainService?: string;
  readonly keychainOpen?: KeychainOpen;
  /** `signer.socketGroupGid` when the signer runs as another UID (SCR-170 §4). */
  readonly socketGroupGid?: number;
}

export interface SignerClient {
  sign(caller: string, request: SignRequest): Promise<SignResult>;
  createPocketKey(caller: string): Promise<Address>;
  keyAddress(caller: string, keyRef: string): Promise<Address>;
}

export async function createSignerClient(options: SignerClientOptions): Promise<SignerClient> {
  const identity =
    options.identity ??
    keychainSignerIdentity(
      options.keychainService ?? String(loadConfig().get("signer.keychainService")),
      options.keychainOpen,
    );
  const token = await identity.tokenFor(options.service);
  if (token === undefined) throw new Error(`unknown signer client service ${options.service}`);
  const socketPath = resolve(expandHome(options.socketPath));
  const gid = options.socketGroupGid;
  return {
    sign: (caller, request) =>
      callSocket(
        socketPath,
        {
          service: options.service,
          token,
          caller,
          method: "sign",
          request,
        },
        gid,
      ),
    createPocketKey: (caller) =>
      callSocket(
        socketPath,
        {
          service: options.service,
          token,
          caller,
          method: "createPocketKey",
        },
        gid,
      ),
    keyAddress: (caller, keyRef) =>
      callSocket(
        socketPath,
        {
          service: options.service,
          token,
          caller,
          method: "keyAddress",
          keyRef,
        },
        gid,
      ),
  };
}

type SocketRequest = {
  readonly service: string;
  readonly token: string;
  readonly caller: string;
  readonly method: "sign" | "createPocketKey" | "keyAddress";
  readonly request?: SignRequest;
  readonly keyRef?: string;
};

type SocketResponse =
  | { readonly ok: true; readonly result: SignResult | Address }
  | { readonly ok: false; readonly rule: string };

async function handleSocket(socket: Socket, options: SignerSocketOptions): Promise<void> {
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      socket.destroy();
      return;
    }
    const end = buffer.indexOf("\n");
    if (end < 0) return;
    socket.pause();
    void dispatch(buffer.slice(0, end), options)
      .then((response) => socket.end(`${JSON.stringify(response)}\n`))
      .catch(() => socket.destroy());
  });
}

async function dispatch(line: string, options: SignerSocketOptions): Promise<SocketResponse> {
  const parsed = parseSocketRequest(line);
  if (parsed === undefined) return { ok: false, rule: "socket-shape" };
  const expected = await options.identity.tokenFor(parsed.service).catch(() => undefined);
  if (expected === undefined || !sameToken(expected, parsed.token)) {
    await writeDenied(options.audit, parsed, "service-token");
    return { ok: false, rule: "service-token" };
  }
  if (!(options.allowedCallers[parsed.service] ?? []).includes(parsed.caller)) {
    await writeDenied(options.audit, parsed, "service-caller");
    return { ok: false, rule: "service-caller" };
  }
  try {
    let result: SignResult | Address;
    if (parsed.method === "sign") {
      result = await options.signer.sign(parsed.caller, parsed.request as SignRequest);
    } else if (parsed.method === "createPocketKey") {
      result = await options.signer.createPocketKey(parsed.caller);
    } else {
      result = await options.signer.keyAddress(parsed.caller, parsed.keyRef as string);
    }
    return { ok: true, result };
  } catch (error) {
    return { ok: false, rule: error instanceof Denied ? error.rule : "signer-error" };
  }
}

function parseSocketRequest(line: string): SocketRequest | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return undefined;
    const request = value as Partial<SocketRequest>;
    if (
      typeof request.service !== "string" ||
      typeof request.token !== "string" ||
      typeof request.caller !== "string" ||
      (request.method !== "sign" &&
        request.method !== "createPocketKey" &&
        request.method !== "keyAddress") ||
      (request.method === "sign" && typeof request.request !== "object") ||
      (request.method === "keyAddress" && typeof request.keyRef !== "string")
    )
      return undefined;
    return request as SocketRequest;
  } catch {
    return undefined;
  }
}

async function writeDenied(audit: AuditSink, request: SocketRequest, rule: string): Promise<void> {
  if (request.method === "keyAddress") return;
  await audit.write({
    at: Date.now(),
    caller: request.service,
    keyRef: "socket",
    kind: request.method,
    purpose: {},
    outcome: "kms_denied",
    rule,
  });
}

function sameToken(expected: string, supplied: string): boolean {
  const expectedHash = createHash("sha256").update(expected).digest();
  const suppliedHash = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

async function callSocket<T extends SignResult | Address>(
  socketPath: string,
  request: SocketRequest,
  socketGroupGid?: number,
): Promise<T> {
  await verifyReachableSocket(socketPath, socketGroupGid);
  const response = await new Promise<SocketResponse>((resolveResponse, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      socket.end();
      try {
        resolveResponse(JSON.parse(buffer.slice(0, end)) as SocketResponse);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
  if (!response.ok) throw new Denied(response.rule);
  return response.result as T;
}

async function clearOwnedSocket(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isSocket() || stat.uid !== process.getuid?.())
      throw new Error(`refusing to replace non-owned signer socket path: ${path}`);
    await probeOrRemoveStaleSocket(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** The signer's own UID; the group option is POSIX-only. */
function ownUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error("signer.socketGroupGid needs a platform with user and group ids");
  return uid;
}

async function ensurePrivateSocketDirectory(path: string, gid?: number): Promise<void> {
  const mode = gid === undefined ? DIRECTORY_MODE : GROUP_DIRECTORY_MODE;
  await mkdir(path, { recursive: true, mode });
  if (gid !== undefined) await chown(path, ownUid(), gid);
  const directory = await lstat(path);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.())
    throw new Error("signer socket directory must be a user-owned directory");
  if (gid !== undefined && directory.gid !== gid)
    throw new Error("signer socket directory must be owned by signer.socketGroupGid");
  await chmod(path, mode);
}

/** The signer's own check: it owns the socket, and with a group it is that group's, mode 0660. */
async function verifyOwnedSocket(path: string, gid?: number): Promise<void> {
  const socket = await lstat(path);
  if (
    !socket.isSocket() ||
    socket.uid !== process.getuid?.() ||
    (socket.mode & 0o777) !== (gid === undefined ? SOCKET_MODE : GROUP_SOCKET_MODE) ||
    (gid !== undefined && socket.gid !== gid)
  )
    throw new Error(
      gid === undefined
        ? "signer socket must be a user-owned Unix socket with mode 0600"
        : "signer socket must be a user-owned Unix socket with mode 0660 and the configured group",
    );
}

/**
 * A client's check. Without a group it is today's: the socket is the caller's own, mode 0600. With one
 * the signer runs as another UID, which the client cannot know, so the check is the socket's group and
 * mode 0660 — file access alone grants nothing, because the per-service token is still required.
 */
async function verifyReachableSocket(path: string, gid?: number): Promise<void> {
  if (gid === undefined) return verifyOwnedSocket(path);
  const socket = await lstat(path);
  if (!socket.isSocket() || socket.gid !== gid || (socket.mode & 0o777) !== GROUP_SOCKET_MODE)
    throw new Error("signer socket must be a Unix socket with mode 0660 and the configured group");
}

async function probeOrRemoveStaleSocket(path: string): Promise<void> {
  await new Promise<void>((resolveProbe, rejectProbe) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      rejectProbe(new Error("signer socket is already active"));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNREFUSED") {
        rejectProbe(error);
        return;
      }
      unlink(path).then(() => resolveProbe(), rejectProbe);
    });
  });
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

function ignoreMissingSocket(error: NodeJS.ErrnoException): void {
  if (error.code !== "ENOENT") throw error;
}

async function openKeychain(service: string, account: string) {
  const { Entry } = await import("@napi-rs/keyring");
  return new Entry(service, account);
}

async function readToken(
  keychainService: string,
  service: string,
  open: KeychainOpen,
): Promise<string> {
  const itemService = `${keychainService}.token.${service}`;
  let password: string | null | undefined;
  try {
    password = (await open(itemService, service)).getPassword();
  } catch {
    throw new Error(`signer keychain token unavailable for ${service}`);
  }
  if (password === null || password === undefined || password.length < 32)
    throw new Error(`signer keychain token missing or too short for ${service}`);
  return password;
}
