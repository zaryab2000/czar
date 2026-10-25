import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import {
  isLocalOverlayPath,
  isLoopbackHttpUrl,
  validateLocalOnlyConfig,
  type Config,
} from "../../../packages/config/src/index.ts";

const TRANSFER_SELECTOR = "cf092995";
const BALANCE_FIXTURE_PATH = new URL("./fixtures/balances.json", import.meta.url);
const FIXTURE_PATH = new URL("./fixtures/transfers.json", import.meta.url);
const MAX_BODY_BYTES = 1_048_576;

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
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  });
}

/** Routes the D92 Facilitator and Gateway fixtures without external service calls. */
export async function handleStandinRequest(
  request: Request,
  rpc: RpcCall,
  usdcAddress = "0x3600000000000000000000000000000000000000",
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return json({ status: "ok" });
  if (url.pathname === "/verify" && request.method === "POST") {
    return verify(request, usdcAddress);
  }
  if (url.pathname === "/settle" && request.method === "POST") {
    return settle(request, rpc, usdcAddress);
  }
  if (url.pathname === "/v1/balances" && request.method === "POST") return balances(request);
  if (url.pathname === "/v1/transfer" && request.method === "POST") return transfer(request);
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
    const receipt = await rpc("eth_getTransactionReceipt", [transaction]);
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

async function balances(request: Request): Promise<Response> {
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
  const balanceRows = depositors.flatMap((item) => {
    if (!isRecord(item) || typeof item["depositor"] !== "string") return [];
    const domain = item["domain"] ?? 26;
    const recorded = fixture.balances.find((candidate) => candidate["domain"] === domain);
    return recorded ? [{ ...recorded, depositor: item["depositor"] }] : [];
  });
  return json({ token: fixture.token, balances: balanceRows });
}

async function transfer(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (!Array.isArray(body) || body.length !== 1) {
    return json({ error: "invalid_request" }, 400);
  }
  return json({
    transferId: "d863fd6a-6e1c-4ab6-ac61-22966d41529a",
    attestation: `0x${"11".repeat(32)}`,
    signature: `0x${"22".repeat(65)}`,
  });
}

async function transfers(url: URL): Promise<Response> {
  const source = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as Record<string, unknown>[];
  const completed = source.find((item) => item["status"] === "completed");
  if (!completed) return json({ transfers: [] });
  const transferRow = { ...completed };
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from) transferRow["fromAddress"] = from;
  if (to) transferRow["toAddress"] = to;
  return json({ transfers: [transferRow] });
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
  return /^0x(?:[\da-fA-F]{130}|[\da-fA-F]{832})$/.test(value);
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
