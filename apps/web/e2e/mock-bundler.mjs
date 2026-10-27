import { createServer } from "node:http";
import {
  entryPoint07Abi,
  getUserOperationHash,
  toPackedUserOperation,
} from "viem/account-abstraction";
import { decodeEventLog, encodeFunctionData, numberToHex } from "viem";

const RPC_URL = process.env["CZAR_ARC_RPC_URL"] ?? "http://127.0.0.1:8549";
const PORT = Number(process.env["CZAR_MOCK_BUNDLER_PORT"] ?? 4337);
const CORS_ORIGINS = parseLocalOrigins(
  process.env["CZAR_MOCK_BUNDLER_CORS_ORIGINS"] ?? "http://localhost:3100,http://localhost:3001",
);
const CHAIN_ID = 5042002;
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const BENEFICIARY = "0x000000000000000000000000000000000000b001";
const CLIENT_KEY = "lane5-test-client-key";
const RECEIPT_WAIT_TIMEOUT_MS = 5_000;
const RECEIPT_POLL_INTERVAL_MS = 50;
const GAS_LIMITS = {
  callGasLimit: "0x3d0900",
  verificationGasLimit: "0x1e8480",
  preVerificationGas: "0x186a0",
  paymasterVerificationGasLimit: "0x0",
  paymasterPostOpGasLimit: "0x0",
};
const RPC_METHODS = new Set([
  "eth_supportedEntryPoints",
  "eth_sendUserOperation",
  "eth_estimateUserOperationGas",
  "eth_getUserOperationByHash",
  "eth_getUserOperationReceipt",
  "eth_chainId",
  "eth_getBalance",
  "eth_blockNumber",
  "eth_call",
  "eth_getBlockByNumber",
  "eth_maxPriorityFeePerGas",
  "eth_gasPrice",
  "eth_getCode",
  "circle_getAddress",
  "circle_getAddressMapping",
  "circle_createAddressMapping",
  "circle_getUserOperationGasPrice",
  "pm_getPaymasterData",
  "pm_getPaymasterStubData",
]);
const userOperations = new Map();
const seenMethods = new Set();

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  response.setHeader("Vary", "Origin");
  if (origin && CORS_ORIGINS.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
  }
  response.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-AppInfo");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    return response.end();
  }
  if (request.method === "GET" && request.url === "/health") {
    return writeJson(response, 200, { ready: true });
  }
  if (request.method === "GET" && request.url === "/methods") {
    return writeJson(response, 200, [...seenMethods].toSorted());
  }
  if (request.method !== "POST" || request.headers.authorization !== `Bearer ${CLIENT_KEY}`) {
    return writeJson(response, 401, { error: "Mock bundler requires its test-only client key." });
  }
  try {
    const payload = await readJson(request);
    if (typeof payload.method !== "string" || !RPC_METHODS.has(payload.method)) {
      return writeJson(
        response,
        200,
        rpcError(payload, -32601, "Unsupported mock bundler method."),
      );
    }
    seenMethods.add(payload.method);
    const result = await dispatch(payload.method, payload.params ?? []);
    return writeJson(response, 200, { jsonrpc: "2.0", id: payload.id, result });
  } catch (error) {
    return writeJson(response, 200, rpcError(null, -32000, message(error)));
  }
});

server.listen(PORT, "127.0.0.1");

function parseLocalOrigins(value) {
  const origins = value.split(",").map((origin) => origin.trim());
  if (origins.length === 0 || origins.some((origin) => !isLocalOrigin(origin))) {
    throw new Error("CZAR_MOCK_BUNDLER_CORS_ORIGINS must contain local http://localhost origins.");
  }
  return new Set(origins);
}

function isLocalOrigin(origin) {
  const match = /^http:\/\/localhost:([1-9]\d{0,4})$/.exec(origin);
  return match !== null && Number(match[1]) <= 65_535;
}

async function dispatch(method, params) {
  switch (method) {
    case "eth_supportedEntryPoints":
      return [ENTRY_POINT];
    case "eth_estimateUserOperationGas":
      return GAS_LIMITS;
    case "eth_sendUserOperation":
      return submitUserOperation(params);
    case "eth_getUserOperationByHash":
      return userOperations.get(String(params[0]).toLowerCase())?.byHash ?? null;
    case "eth_getUserOperationReceipt":
      return userOperations.get(String(params[0]).toLowerCase())?.byReceipt ?? null;
    case "circle_getUserOperationGasPrice":
      return gasPrices();
    case "circle_getAddress":
      return { wallets: [] };
    case "circle_getAddressMapping":
      return { addressMapping: null };
    case "circle_createAddressMapping":
      return { addressMappingId: "mock-address-mapping" };
    case "pm_getPaymasterData":
    case "pm_getPaymasterStubData":
      return {
        paymaster: null,
        paymasterData: "0x",
        paymasterVerificationGasLimit: "0x0",
        paymasterPostOpGasLimit: "0x0",
      };
    default:
      return forward(method, params);
  }
}

async function submitUserOperation(params) {
  const operation = normalizeUserOperation(params[0]);
  const entryPoint = String(params[1] ?? "").toLowerCase();
  if (entryPoint !== ENTRY_POINT.toLowerCase()) throw new Error("Unexpected EntryPoint address.");
  const packed = toPackedUserOperation(operation);
  const data = encodeFunctionData({
    abi: entryPoint07Abi,
    functionName: "handleOps",
    args: [[packed], BENEFICIARY],
  });
  await forward("anvil_impersonateAccount", [BENEFICIARY]);
  await forward("anvil_setBalance", [BENEFICIARY, "0x3635c9adc5dea00000"]);
  const gas = await forward("eth_estimateGas", [{ from: BENEFICIARY, to: ENTRY_POINT, data }]);
  const transactionHash = await forward("eth_sendTransaction", [
    {
      from: BENEFICIARY,
      to: ENTRY_POINT,
      data,
      gas: numberToHex(BigInt(gas) + BigInt(gas) / 4n),
    },
  ]);
  const userOpHash = getUserOperationHash({
    chainId: CHAIN_ID,
    entryPointAddress: ENTRY_POINT,
    entryPointVersion: "0.7",
    userOperation: operation,
  });
  const receipt = await waitForTransactionReceipt(transactionHash);
  const operationEvent = receipt.logs
    .filter((log) => log.address.toLowerCase() === ENTRY_POINT.toLowerCase())
    .map((log) => decodeEntryPointEvent(log))
    .find((event) => event?.eventName === "UserOperationEvent");
  const operationSucceeded = operationEvent?.args.success === true;
  if (!operationSucceeded) {
    throw new Error("EntryPoint reported a failed UserOperation.");
  }
  const failure = receipt.logs
    .filter((log) => log.address.toLowerCase() === ENTRY_POINT.toLowerCase())
    .map((log) => decodeEntryPointEvent(log))
    .find((event) => event?.eventName === "UserOperationRevertReason");
  if (failure) throw new Error("EntryPoint emitted a UserOperationRevertReason.");
  const byHash = {
    userOperation: params[0],
    entryPoint: ENTRY_POINT,
    transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber,
  };
  const byReceipt = {
    userOpHash,
    entryPoint: ENTRY_POINT,
    sender: operation.sender,
    nonce: numberToHex(operation.nonce),
    actualGasCost: "0x0",
    actualGasUsed: gas,
    success: operationSucceeded,
    reason: null,
    receipt,
    logs: receipt.logs,
  };
  userOperations.set(userOpHash.toLowerCase(), { byHash, byReceipt });
  if (receipt.status !== "0x1" || !operationSucceeded)
    throw new Error("EntryPoint UserOperation execution failed.");
  return userOpHash;
}

async function waitForTransactionReceipt(transactionHash) {
  const deadline = Date.now() + RECEIPT_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const receipt = await forward("eth_getTransactionReceipt", [transactionHash]);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_INTERVAL_MS));
  }
  throw new Error("Local Anvil did not return the UserOperation transaction receipt in time.");
}

function decodeEntryPointEvent(log) {
  try {
    return decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics });
  } catch {
    return undefined;
  }
}

function normalizeUserOperation(value) {
  if (typeof value !== "object" || value === null) throw new Error("UserOperation is missing.");
  const operation = { ...value };
  for (const key of [
    "callGasLimit",
    "verificationGasLimit",
    "preVerificationGas",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "nonce",
    "paymasterVerificationGasLimit",
    "paymasterPostOpGasLimit",
  ]) {
    if (operation[key] !== undefined) operation[key] = BigInt(operation[key]);
  }
  return operation;
}

function gasPrices() {
  const level = { maxPriorityFeePerGas: "0x3b9aca00", maxFeePerGas: "0x77359400" };
  return { low: level, medium: level, high: level, deployed: "500000", notDeployed: "800000" };
}

async function forward(method, params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message ?? `RPC ${method} failed.`);
  return payload.result;
}

function rpcError(payload, code, errorMessage) {
  return {
    jsonrpc: "2.0",
    id: typeof payload?.id === "string" || typeof payload?.id === "number" ? payload.id : null,
    error: { code, message: errorMessage },
  };
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

function writeJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function message(error) {
  return error instanceof Error ? error.message : "Mock bundler request failed.";
}
