import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import {
  isLocalOverlayPath,
  isLoopbackHttpUrl,
  validateLocalOnlyConfig,
  type Config,
} from "../../../packages/config/src/index.ts";
import { transferSpecHash, type TransferSpec } from "../../../packages/hashing/src/eip712.ts";

const TRANSFER_SELECTOR = "cf092995";
const BALANCE_FIXTURE_PATH = new URL("./fixtures/balances.json", import.meta.url);
const FIXTURE_PATH = new URL("./fixtures/transfers.json", import.meta.url);
const MAX_BODY_BYTES = 1_048_576;
const RECEIPT_ATTEMPTS = 20;
const RECEIPT_RETRY_MS = 250;
// SCR-150 §4 selectors (keccak256 of the signature, first 4 bytes).
const AVAILABLE_BALANCE_SELECTOR = "3ccb64ae"; // availableBalance(address,address)
// testBurnForTransferSpec(bytes32,address,address,uint256,address): one burn per transfer spec (PR #122 P1).
const TEST_BURN_FOR_SPEC_SELECTOR = "18508587";
const BURN_RECORD_SELECTOR = "4f1a276d"; // burnRecord(bytes32)
const BURN_RECORD_WORDS = 4;
const HEX_PER_WORD = 64;
const USDC_DECIMALS = 6;
/** contracts/script/Deploy.s.sol:21 (A2-01); equals the placement helper's canonical GatewayWallet. */
export const STANDIN_GATEWAY_WALLET = "0x0077777d7eba4688bdef3e311b846f25870a19b9";
const LOCAL_SIGNATURE = `0x${"22".repeat(65)}`;
const BYTES32 = /^0x[\da-fA-F]{64}$/;
const UNSIGNED = /^(0|[1-9]\d*)$/;

export type GatewayStandinOptions = {
  /** `routing.gatewayFeeAtomic`: the fee Gateway debits on top of `value` (A2-17). */
  readonly gatewayFeeAtomic?: bigint;
};

export type StandinOptions = {
  readonly config: Config;
  readonly overlayPath: string | URL;
  readonly rpcUrl: string;
  readonly bindAddress: string;
  readonly port: number;
  readonly fetchFn?: typeof fetch;
};

export type RpcCall = (method: string, params: readonly unknown[]) => Promise<unknown>;

/** Refuses to start unless the process is explicitly bound to local Arc Anvil. */
export async function validateStandinStartup(options: StandinOptions): Promise<void> {
  if (options.bindAddress !== "127.0.0.1")
    throw new Error("stand-in bind address must be 127.0.0.1");
  if (!isLocalOverlayPath(options.overlayPath)) throw new Error("stand-in requires env/local.toml");
  if (!isLoopbackHttpUrl(options.rpcUrl)) throw new Error("stand-in Arc RPC must be loopback HTTP");
  await validateLocalOnlyConfig({
    config: options.config,
    overlayPath: options.overlayPath,
    arcRpcUrl: options.rpcUrl,
    requireAnvilNodeInfo: true,
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  });
}

/** Routes the D92 Facilitator and Gateway fixtures without external service calls. */
export async function handleStandinRequest(
  request: Request,
  rpc: RpcCall,
  usdcAddress = "0x3600000000000000000000000000000000000000",
  gateway: GatewayStandinOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return json({ status: "ok" });
  if (url.pathname === "/verify" && request.method === "POST") {
    return verify(request, usdcAddress);
  }
  if (url.pathname === "/settle" && request.method === "POST") {
    return settle(request, rpc, usdcAddress);
  }
  if (url.pathname === "/v1/balances" && request.method === "POST") {
    return balances(request, rpc, usdcAddress);
  }
  if (url.pathname === "/v1/transfer" && request.method === "POST") {
    return transfer(request, rpc, usdcAddress, gateway.gatewayFeeAtomic ?? 0n);
  }
  if (url.pathname === "/v1/x402/transfers" && request.method === "GET") {
    return transfers(url);
  }
  return json({ error: "not_found" }, 404);
}

export async function createStandinServer(options: StandinOptions) {
  await validateStandinStartup(options);
  const rpc = createRpcCall(options.rpcUrl, options.fetchFn ?? fetch);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = await toRequest(incoming);
      const response = await handleStandinRequest(
        request,
        rpc,
        options.config.get("chain.usdcAddress") as string,
        { gatewayFeeAtomic: BigInt(options.config.get("routing.gatewayFeeAtomic") as number) },
      );
      await writeResponse(response, outgoing);
    } catch {
      await writeResponse(json({ error: "invalid_request" }, 400), outgoing);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.bindAddress, resolve);
  });
  return server;
}

export async function runFromEnvironment(): Promise<void> {
  const { loadConfigFile, parameterEnvironment } =
    await import("../../../packages/config/src/index.ts");
  const overlayPath = process.env["CZAR_LOCAL_CONFIG"] ?? "env/local.toml";
  const rpcUrl = process.env["CZAR_ARC_RPC_URL"] ?? "http://127.0.0.1:8545";
  const config = await loadConfigFile(overlayPath, {
    env: parameterEnvironment(process.env),
  });
  const server = await createStandinServer({
    config,
    overlayPath,
    rpcUrl,
    bindAddress: process.env["CZAR_STANDIN_BIND_ADDRESS"] ?? "127.0.0.1",
    port: Number(process.env["CZAR_STANDIN_PORT"] ?? "4999"),
  });
  const stop = () => server.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function verify(request: Request, usdcAddress: string): Promise<Response> {
  const body = await readJson(request);
  if (!isRecord(body) || body["x402Version"] !== 2) {
    return json({ isValid: false, invalidReason: "invalid_request" }, 400);
  }
  const authorization = paymentAuthorization(body, usdcAddress);
  if (!authorization || !matchesRequirements(body, authorization)) {
    return json({ isValid: false, invalidReason: "invalid_payment" }, 400);
  }
  return json({ isValid: true, payer: authorization.from });
}

async function settle(request: Request, rpc: RpcCall, usdcAddress: string): Promise<Response> {
  const body = await readJson(request);
  const authorization = paymentAuthorization(body, usdcAddress);
  if (!authorization || !matchesRequirements(body, authorization)) {
    return json({ success: false, errorReason: "invalid_request" }, 400);
  }
  try {
    const accounts = await rpc("eth_accounts", []);
    if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !isAddress(accounts[0])) {
      return json({ success: false, errorReason: "no_unlocked_account" }, 503);
    }
    const transaction = await rpc("eth_sendTransaction", [
      {
        from: accounts[0],
        to: authorization.usdc,
        data: encodeTransferWithAuthorization(authorization),
      },
    ]);
    if (typeof transaction !== "string" || !/^0x[\da-fA-F]{64}$/.test(transaction)) {
      return json({ success: false, errorReason: "invalid_rpc_response" }, 502);
    }
    const receipt = await waitForReceipt(rpc, transaction);
    if (receipt === null) {
      return json({ success: false, errorReason: "settlement_pending", transaction }, 202);
    }
    if (!isRecord(receipt) || receipt["status"] !== "0x1") {
      return json({ success: false, errorReason: "transaction_reverted", transaction }, 502);
    }
    return json({
      success: true,
      transaction,
      network: "eip155:5042002",
      payer: authorization.from,
    });
  } catch {
    return json({ success: false, errorReason: "rpc_unavailable" }, 502);
  }
}

/**
 * Fixture balances, unless the SCR-150 Gateway double (or a real GatewayWallet on a fork) is at the canonical
 * address: then the depositor's `availableBalance` is read from the chain, so pocket balances follow deposits,
 * burns and withdrawals.
 */
async function balances(request: Request, rpc: RpcCall, usdcAddress: string): Promise<Response> {
  const body = await readJson(request);
  const fixture = JSON.parse(await readFile(BALANCE_FIXTURE_PATH, "utf8")) as {
    token: string;
    balances: Record<string, unknown>[];
  };
  const depositors = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body["balances"])
      ? body["balances"]
      : [body];
  const chainBacked = await hasCode(rpc, STANDIN_GATEWAY_WALLET);
  const balanceRows: Record<string, unknown>[] = [];
  for (const item of depositors) {
    if (!isRecord(item) || typeof item["depositor"] !== "string") continue;
    const domain = item["domain"] ?? 26;
    const recorded = fixture.balances.find((candidate) => candidate["domain"] === domain);
    if (!recorded) continue;
    if (!chainBacked) {
      balanceRows.push({ ...recorded, depositor: item["depositor"] });
      continue;
    }
    if (!isAddress(item["depositor"])) return json({ error: "invalid_request" }, 400);
    let available: bigint;
    try {
      available = await availableBalance(rpc, usdcAddress, item["depositor"]);
    } catch {
      return json({ error: "rpc_unavailable" }, 502);
    }
    balanceRows.push({
      ...recorded,
      depositor: item["depositor"],
      balance: formatUsdc(available),
      pendingBatch: formatUsdc(0n),
    });
  }
  return json({ token: fixture.token, balances: balanceRows });
}

/**
 * SCR-150 §4: the local `/v1/transfer`. Recomputes the replay `transferSpecHash` exactly as the payer does
 * (`@czar/hashing` `transferSpecHash`, the hash the vault stores on `requestPullback`), debits value + fee from
 * the depositor in the Gateway double into the minter double, and returns the local attestation
 * `abi.encode(transferSpecHash, recipient, value, depositor)` that the minter double accepts.
 *
 * Idempotent by `transferSpecHash` (PR #122 P1): the burn is recorded on chain by the Gateway double
 * (`testBurnForTransferSpec`), so a payer retry after a crash, two concurrent requests, or a restarted stand-in
 * all return the same attestation with exactly one debit. Requests for one hash are also serialized in-process.
 * A request whose spec hash was already burned with different arguments gets `transfer_spec_conflict`, no burn.
 */
async function transfer(
  request: Request,
  rpc: RpcCall,
  usdcAddress: string,
  feeAtomic: bigint,
): Promise<Response> {
  const body = await readJson(request);
  if (!Array.isArray(body) || body.length !== 1) {
    return json({ error: "invalid_request" }, 400);
  }
  const parsed = burnIntent(body[0]);
  if (!parsed) return json({ error: "invalid_request" }, 400);
  const { spec, maxFee } = parsed;
  const token = bytes32ToAddress(spec.sourceToken);
  if (token !== usdcAddress.toLowerCase() || bytes32ToAddress(spec.destinationToken) !== token) {
    return json({ error: "unsupported_token" }, 400);
  }
  if (maxFee < feeAtomic) return json({ error: "max_fee_too_low" }, 400);
  const hash = transferSpecHash(spec);
  const burn: BurnArguments = {
    wallet: bytes32ToAddress(spec.sourceContract),
    token,
    depositor: bytes32ToAddress(spec.sourceDepositor),
    debit: spec.value + feeAtomic,
    minter: bytes32ToAddress(spec.destinationContract),
  };
  const recipient = bytes32ToAddress(spec.destinationRecipient);
  const outcome = await serializedByHash(hash, () => burnOnce(rpc, hash, burn));
  if (outcome !== "burned") return outcome;
  return json({
    transferId: transferIdForAddress(hash, burn.depositor),
    attestation: `0x${hash.slice(2)}${wordAddress(recipient)}${wordNumber(spec.value.toString())}${wordAddress(burn.depositor)}`,
    signature: LOCAL_SIGNATURE,
  });
}

type BurnArguments = {
  readonly wallet: string;
  readonly token: string;
  readonly depositor: string;
  readonly debit: bigint;
  readonly minter: string;
};

type BurnRecordRead = {
  readonly token: string;
  readonly depositor: string;
  readonly value: bigint;
  readonly recipient: string;
};

const pendingBurns = new Map<string, Promise<unknown>>();

/** Runs `task` after any in-flight task for the same spec hash, in this process. */
async function serializedByHash<T>(hash: string, task: () => Promise<T>): Promise<T> {
  const previous = pendingBurns.get(hash) ?? Promise.resolve();
  const current = previous.then(task, task);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  pendingBurns.set(hash, settled);
  try {
    return await current;
  } finally {
    if (pendingBurns.get(hash) === settled) pendingBurns.delete(hash);
  }
}

/** Reads the on-chain burn record first; burns only when none exists. */
async function burnOnce(
  rpc: RpcCall,
  hash: string,
  burn: BurnArguments,
): Promise<"burned" | Response> {
  try {
    if (!(await hasCode(rpc, burn.wallet)) || !(await hasCode(rpc, burn.minter))) {
      return json({ error: "gateway_double_missing" }, 503);
    }
    const existing = await readBurnRecord(rpc, burn.wallet, hash);
    if (existing) return matchesBurn(existing, burn) ? "burned" : transferSpecConflict();
    if ((await availableBalance(rpc, burn.token, burn.depositor, burn.wallet)) < burn.debit) {
      return json({ error: "insufficient_balance" }, 400);
    }
    const accounts = await rpc("eth_accounts", []);
    if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !isAddress(accounts[0])) {
      return json({ error: "no_unlocked_account" }, 503);
    }
    const transaction = await rpc("eth_sendTransaction", [
      {
        from: accounts[0],
        to: burn.wallet,
        data: `0x${TEST_BURN_FOR_SPEC_SELECTOR}${hash.slice(2).toLowerCase()}${wordAddress(burn.token)}${wordAddress(burn.depositor)}${wordNumber(burn.debit.toString())}${wordAddress(burn.minter)}`,
      },
    ]);
    if (typeof transaction !== "string" || !BYTES32.test(transaction)) {
      return json({ error: "invalid_rpc_response" }, 502);
    }
    const receipt = await waitForReceipt(rpc, transaction);
    if (isRecord(receipt) && receipt["status"] === "0x1") return "burned";
    // A reverted burn may have lost a race with another process; the chain record decides.
    const raced = await readBurnRecord(rpc, burn.wallet, hash);
    if (raced) return matchesBurn(raced, burn) ? "burned" : transferSpecConflict();
    return json({ error: "burn_failed" }, 502);
  } catch {
    return json({ error: "rpc_unavailable" }, 502);
  }
}

async function readBurnRecord(
  rpc: RpcCall,
  wallet: string,
  hash: string,
): Promise<BurnRecordRead | null> {
  const result = await rpc("eth_call", [
    { to: wallet, data: `0x${BURN_RECORD_SELECTOR}${hash.slice(2).toLowerCase()}` },
    "latest",
  ]);
  if (typeof result !== "string" || !/^0x[\da-fA-F]*$/.test(result)) {
    throw new Error("burnRecord read failed");
  }
  const hex = result.slice(2);
  if (hex.length !== BURN_RECORD_WORDS * HEX_PER_WORD) throw new Error("burnRecord read failed");
  const word = (index: number) => hex.slice(index * HEX_PER_WORD, (index + 1) * HEX_PER_WORD);
  const record = {
    token: `0x${word(0).slice(-40)}`,
    depositor: `0x${word(1).slice(-40)}`,
    value: BigInt(`0x${word(2)}`),
    recipient: `0x${word(3).slice(-40)}`,
  };
  return /^0x0{40}$/.test(record.depositor) ? null : record;
}

function matchesBurn(record: BurnRecordRead, burn: BurnArguments): boolean {
  return (
    record.token === burn.token.toLowerCase() &&
    record.depositor === burn.depositor.toLowerCase() &&
    record.value === burn.debit &&
    record.recipient === burn.minter.toLowerCase()
  );
}

function transferSpecConflict(): Response {
  return json({ error: "transfer_spec_conflict" }, 409);
}

function burnIntent(item: unknown): { spec: TransferSpec; maxFee: bigint } | null {
  if (!isRecord(item) || !isRecord(item["burnIntent"])) return null;
  const intent = item["burnIntent"];
  const raw = intent["spec"];
  if (!isRecord(raw) || typeof intent["maxFee"] !== "string" || !UNSIGNED.test(intent["maxFee"])) {
    return null;
  }
  const words = [
    "sourceContract",
    "destinationContract",
    "sourceToken",
    "destinationToken",
    "sourceDepositor",
    "destinationRecipient",
    "sourceSigner",
    "destinationCaller",
    "salt",
  ] as const;
  if (words.some((key) => typeof raw[key] !== "string" || !BYTES32.test(raw[key] as string)))
    return null;
  const integers = ["version", "sourceDomain", "destinationDomain"] as const;
  if (integers.some((key) => typeof raw[key] !== "number" || !Number.isInteger(raw[key])))
    return null;
  if (typeof raw["value"] !== "string" || !UNSIGNED.test(raw["value"])) return null;
  if (typeof raw["hookData"] !== "string" || !/^0x(?:[\da-fA-F]{2})*$/.test(raw["hookData"]))
    return null;
  const spec = {
    version: raw["version"],
    sourceDomain: raw["sourceDomain"],
    destinationDomain: raw["destinationDomain"],
    sourceContract: raw["sourceContract"],
    destinationContract: raw["destinationContract"],
    sourceToken: raw["sourceToken"],
    destinationToken: raw["destinationToken"],
    sourceDepositor: raw["sourceDepositor"],
    destinationRecipient: raw["destinationRecipient"],
    sourceSigner: raw["sourceSigner"],
    destinationCaller: raw["destinationCaller"],
    value: BigInt(raw["value"]),
    salt: raw["salt"],
    hookData: raw["hookData"],
  } as TransferSpec;
  if (spec.value === 0n) return null;
  return { spec, maxFee: BigInt(intent["maxFee"]) };
}

async function hasCode(rpc: RpcCall, address: string): Promise<boolean> {
  const code = await rpc("eth_getCode", [address, "latest"]);
  return typeof code === "string" && code !== "0x" && code.length > 2;
}

async function availableBalance(
  rpc: RpcCall,
  token: string,
  depositor: string,
  wallet = STANDIN_GATEWAY_WALLET,
): Promise<bigint> {
  const result = await rpc("eth_call", [
    {
      to: wallet,
      data: `0x${AVAILABLE_BALANCE_SELECTOR}${wordAddress(token)}${wordAddress(depositor)}`,
    },
    "latest",
  ]);
  if (typeof result !== "string" || !BYTES32.test(result))
    throw new Error("availableBalance read failed");
  return BigInt(result);
}

function bytes32ToAddress(value: string): string {
  return `0x${value.slice(-40)}`.toLowerCase();
}

function formatUsdc(atomic: bigint): string {
  const scale = 10n ** BigInt(USDC_DECIMALS);
  return `${atomic / scale}.${(atomic % scale).toString().padStart(USDC_DECIMALS, "0")}`;
}

async function transfers(url: URL): Promise<Response> {
  const source = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as Record<string, unknown>[];
  const completed = source.find((item) => item["status"] === "completed");
  if (!completed) return json({ transfers: [] });
  const transferRow = { ...completed };
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const scopedAddress = from ?? to;
  if (scopedAddress)
    transferRow["id"] = transferIdForAddress(String(completed["id"]), scopedAddress);
  if (from) transferRow["fromAddress"] = from;
  if (to) transferRow["toAddress"] = to;
  return json({ transfers: [transferRow] });
}

function transferIdForAddress(baseId: string, address: string): string {
  const digest = createHash("sha256").update(`${baseId}:${address.toLowerCase()}`).digest("hex");
  const chars = digest.slice(0, 32).split("");
  chars[12] = "5";
  const variant = Number.parseInt(chars[16] ?? "0", 16);
  chars[16] = ((variant & 0x3) | 0x8).toString(16);
  const uuid = chars.join("");
  return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}

function createRpcCall(url: string, fetchFn: typeof fetch): RpcCall {
  return async (method, params) => {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(5000),
    });
    const result: unknown = await response.json();
    if (!response.ok || !isRecord(result) || "error" in result || !("result" in result)) {
      throw new Error("Arc Anvil RPC request failed");
    }
    return result["result"];
  };
}

async function waitForReceipt(rpc: RpcCall, transaction: string): Promise<unknown> {
  for (let attempt = 0; attempt < RECEIPT_ATTEMPTS; attempt += 1) {
    const receipt = await rpc("eth_getTransactionReceipt", [transaction]);
    if (receipt !== null) return receipt;
    if (attempt + 1 < RECEIPT_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RECEIPT_RETRY_MS));
    }
  }
  return null;
}

function paymentAuthorization(body: unknown, usdcAddress: string) {
  if (
    !isRecord(body) ||
    !isRecord(body["paymentPayload"]) ||
    !isRecord(body["paymentRequirements"])
  )
    return null;
  const payload = body["paymentPayload"]["payload"];
  if (!isRecord(payload) || !isRecord(payload["authorization"])) return null;
  const authorization = payload["authorization"];
  const values = [
    authorization["from"],
    authorization["to"],
    authorization["value"],
    authorization["validAfter"],
    authorization["validBefore"],
    authorization["nonce"],
    payload["signature"],
    body["paymentRequirements"]["asset"],
  ];
  if (values.some((value) => typeof value !== "string")) return null;
  const [from, to, value, validAfter, validBefore, nonce, signature, usdc] = values as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (
    !isAddress(from) ||
    !isAddress(to) ||
    !isAddress(usdc) ||
    usdc.toLowerCase() !== usdcAddress.toLowerCase() ||
    !/^0x[\da-fA-F]{64}$/.test(nonce) ||
    !isSupportedSignature(signature) ||
    ![value, validAfter, validBefore].every((part) => /^(0|[1-9]\d*)$/.test(part))
  )
    return null;
  return { from, to, value, validAfter, validBefore, nonce, signature, usdc };
}

function matchesRequirements(
  body: unknown,
  authorization: NonNullable<ReturnType<typeof paymentAuthorization>>,
): boolean {
  if (!isRecord(body) || !isRecord(body["paymentRequirements"])) return false;
  const requirements = body["paymentRequirements"];
  return (
    typeof requirements["amount"] === "string" &&
    requirements["amount"] === authorization.value &&
    typeof requirements["payTo"] === "string" &&
    requirements["payTo"].toLowerCase() === authorization.to.toLowerCase() &&
    requirements["network"] === "eip155:5042002"
  );
}

function encodeTransferWithAuthorization(
  authorization: NonNullable<ReturnType<typeof paymentAuthorization>>,
): `0x${string}` {
  const signature = authorization.signature.slice(2);
  const paddedSignature = signature.padEnd(Math.ceil(signature.length / 64) * 64, "0");
  const words = [
    wordAddress(authorization.from),
    wordAddress(authorization.to),
    wordNumber(authorization.value),
    wordNumber(authorization.validAfter),
    wordNumber(authorization.validBefore),
    authorization.nonce.slice(2),
    wordNumber(224),
    wordNumber(signature.length / 2),
  ];
  return `0x${TRANSFER_SELECTOR}${words.join("")}${paddedSignature}`;
}

function wordAddress(value: string): string {
  return value.slice(2).toLowerCase().padStart(64, "0");
}

function isSupportedSignature(value: string): boolean {
  return /^0x(?:[\da-fA-F]{2})+$/.test(value);
}

function wordNumber(value: string | number): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

async function readJson(request: Request): Promise<unknown> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error("request body too large");
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

async function toRequest(incoming: IncomingMessage): Promise<Request> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(bytes);
  }
  const method = incoming.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks).toString("utf8");
  return new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
    method,
    headers: incomingHeaders(incoming),
    ...(body === undefined ? {} : { body }),
  });
}

function incomingHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

async function writeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAddress(value: string): boolean {
  return /^0x[\da-fA-F]{40}$/.test(value);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runFromEnvironment().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "stand-in startup failed"}\n`);
    process.exitCode = 1;
  });
}
