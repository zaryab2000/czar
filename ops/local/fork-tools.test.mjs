import assert from "node:assert/strict";
import test from "node:test";
import {
  FORK_CODE_ADDRESSES,
  forkAnvilArguments,
  resolveForkBlock,
  resolveForkPin,
} from "./fork-anvil.mjs";
import {
  LOCAL_RPC_URL,
  OWNER_NATIVE_AMOUNT,
  SERVICE_NATIVE_AMOUNT,
  USDC_ADDRESS,
  VAULT_USDC_AMOUNT,
  fundNative,
  parseAmount,
  parseFundingRequest,
  transferUsdc,
} from "./fund-fork.mjs";

const HOLDER = "0x0000000000000000000000000000000000000001";
const RECIPIENT = "0x0000000000000000000000000000000000000002";

function rpcMock(handler, errorHandler = () => null) {
  const calls = [];
  const fetchFn = async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request);
    const error = errorHandler(request);
    if (error !== null) return Response.json({ jsonrpc: "2.0", id: request.id, error });
    return Response.json({ jsonrpc: "2.0", id: request.id, result: await handler(request) });
  };
  return { calls, fetchFn };
}

test("pins the Arc fork 100 blocks behind the head after checking code", async () => {
  const mock = rpcMock(async ({ method, params }) => {
    if (method === "eth_chainId") return "0x4cef52";
    if (method === "eth_blockNumber") return "0x1000";
    if (method === "eth_getCode") {
      assert.equal(params[1], "0xf9c");
      assert.ok(Object.values(FORK_CODE_ADDRESSES).includes(params[0]));
      return "0x6000";
    }
    throw new Error(`unexpected RPC method ${method}`);
  });
  assert.equal(await resolveForkBlock(mock.fetchFn), 3996n);
  assert.equal(mock.calls.length, 5);
});

test("rejects fork preflight when the Arc RPC is not Arc testnet", async () => {
  const mock = rpcMock(async () => "0x1");
  await assert.rejects(resolveForkBlock(mock.fetchFn), /expected 5042002/);
  assert.equal(mock.calls.length, 1);
});

test("reuses a saved fork pin while historical state and required code remain available", async () => {
  const mock = rpcMock(async ({ method, params }) => {
    if (method === "eth_chainId") return "0x4cef52";
    if (method === "eth_getBlockByNumber") return { number: params[0] };
    if (method === "eth_blockNumber") return "0x1100";
    if (method === "eth_getCode") return "0x6000";
    throw new Error(`unexpected RPC method ${method}`);
  });
  const pin = await resolveForkPin(mock.fetchFn, undefined, {
    chainId: 5042002,
    forkBlock: "3996",
    pinReason: "initial_pin",
  });
  assert.deepEqual(pin, { block: 3996n, reason: "initial_pin" });
  assert.equal(
    mock.calls.some((call) => call.method === "eth_blockNumber"),
    true,
  );
  assert.equal(
    mock.calls.some((call) => call.method === "eth_getCode"),
    true,
  );
});

test("repins to latest minus 100 when saved historical state is unavailable", async () => {
  const mock = rpcMock(async ({ method, params }) => {
    if (method === "eth_chainId") return "0x4cef52";
    if (method === "eth_getBlockByNumber")
      return params[0] === "0xf9c" ? null : { number: params[0] };
    if (method === "eth_blockNumber") return "0x1100";
    if (method === "eth_getCode") return "0x6000";
    throw new Error(`unexpected RPC method ${method}`);
  });
  const pin = await resolveForkPin(mock.fetchFn, undefined, {
    chainId: 5042002,
    forkBlock: "3996",
    pinReason: "initial_pin",
  });
  assert.deepEqual(pin, { block: 4252n, reason: "historical_state_unavailable" });
});

test("repins when saved eth_getCode reports pruned historical state", async () => {
  const mock = rpcMock(
    async ({ method, params }) => {
      if (method === "eth_chainId") return "0x4cef52";
      if (method === "eth_getBlockByNumber") return { number: params[0] };
      if (method === "eth_blockNumber") return "0x1100";
      if (method === "eth_getCode") return "0x6000";
      throw new Error(`unexpected RPC method ${method}`);
    },
    ({ method, params }) =>
      method === "eth_getCode" && params[1] === "0xf9c"
        ? { code: -32000, message: "historical state is not available because it was pruned" }
        : null,
  );
  const pin = await resolveForkPin(mock.fetchFn, undefined, {
    chainId: 5042002,
    forkBlock: "3996",
    pinReason: "initial_pin",
  });
  assert.deepEqual(pin, { block: 4252n, reason: "historical_state_unavailable" });
});

test("propagates unrelated errors while checking saved historical code", async () => {
  const mock = rpcMock(
    async ({ method, params }) => {
      if (method === "eth_chainId") return "0x4cef52";
      if (method === "eth_getBlockByNumber") return { number: params[0] };
      if (method === "eth_blockNumber") return "0x1100";
      if (method === "eth_getCode") return "0x6000";
      throw new Error(`unexpected RPC method ${method}`);
    },
    ({ method, params }) =>
      method === "eth_getCode" && params[1] === "0xf9c"
        ? { code: -32000, message: "execution reverted" }
        : null,
  );
  await assert.rejects(
    resolveForkPin(mock.fetchFn, undefined, {
      chainId: 5042002,
      forkBlock: "3996",
      pinReason: "initial_pin",
    }),
    /execution reverted/,
  );
});

test("repins when EntryPoint code changes after the saved fork block", async () => {
  const mock = rpcMock(async ({ method, params }) => {
    if (method === "eth_chainId") return "0x4cef52";
    if (method === "eth_getBlockByNumber") return { number: params[0] };
    if (method === "eth_blockNumber") return "0x1100";
    if (method === "eth_getCode") return params[1] === "0xf9c" ? "0x6000" : "0x6001";
    throw new Error(`unexpected RPC method ${method}`);
  });
  const pin = await resolveForkPin(mock.fetchFn, undefined, {
    chainId: 5042002,
    forkBlock: "3996",
    pinReason: "initial_pin",
  });
  assert.deepEqual(pin, { block: 4252n, reason: "required_contract_code_changed" });
});

test("binds the fork to loopback with the verified Arc block pin", () => {
  assert.deepEqual(forkAnvilArguments(69287247n), [
    "--network",
    "arc",
    "--chain-id",
    "5042002",
    "--fork-url",
    "https://rpc.testnet.arc.io",
    "--fork-block-number",
    "69287247",
    "--host",
    "127.0.0.1",
    "--mnemonic-random",
    "--quiet",
    "--port",
    "8545",
  ]);
});

test("checks the Circle SDK factory address used by the wallet integration", () => {
  assert.equal(
    FORK_CODE_ADDRESSES.circleModularWalletsFactory,
    "0x0000000DF7E6c9Dc387cAFc5eCBfa6c3a6179AdD",
  );
});

test("parses exact decimal amounts without floating-point conversion", () => {
  assert.equal(parseAmount("1.25", 6), 1_250_000n);
  assert.equal(parseAmount("10", 18), 10n * 10n ** 18n);
  assert.throws(() => parseAmount("0.0000001", 6), /at most 6 places/);
  assert.throws(() => parseAmount("0", 6), /greater than zero/);
});

test("uses the specified fixed local funding amounts and requires named services", () => {
  assert.deepEqual(parseFundingRequest(["node", "fund-fork.mjs", "--owner-native", RECIPIENT]), {
    kind: "owner-native",
    address: RECIPIENT,
    amount: OWNER_NATIVE_AMOUNT,
  });
  assert.deepEqual(
    parseFundingRequest([
      "node",
      "fund-fork.mjs",
      "--service-native",
      "K10:czar-search",
      "--address",
      RECIPIENT,
    ]),
    {
      kind: "service-native",
      service: "K10:czar-search",
      address: RECIPIENT,
      amount: SERVICE_NATIVE_AMOUNT,
    },
  );
  assert.deepEqual(
    parseFundingRequest([
      "node",
      "fund-fork.mjs",
      "--vault-usdc",
      RECIPIENT,
      "--usdc-holder",
      HOLDER,
    ]),
    {
      kind: "vault-usdc",
      recipient: RECIPIENT,
      holder: HOLDER,
      amount: VAULT_USDC_AMOUNT,
    },
  );
  assert.throws(
    () =>
      parseFundingRequest([
        "node",
        "fund-fork.mjs",
        "--service-native",
        "unknown-role",
        "--address",
        RECIPIENT,
      ]),
    /usage:/,
  );
});

test("sets native balance only after validating the local chain and anvil", async () => {
  const mock = rpcMock(async ({ method, params }) => {
    if (method === "eth_chainId") return "0x4cef52";
    if (method === "anvil_nodeInfo") return { client: "arc-anvil" };
    if (method === "anvil_setBalance") {
      assert.deepEqual(params, [RECIPIENT, "0xde0b6b3a7640000"]);
      return true;
    }
    if (method === "eth_getBalance") return params[0] === RECIPIENT ? "0xde0b6b3a7640000" : "0x0";
    throw new Error(`unexpected RPC method ${method}`);
  });
  assert.equal(await fundNative(RECIPIENT, 10n ** 18n, mock.fetchFn), "0xde0b6b3a7640000");
  assert.equal(
    mock.calls.map((call) => call.method).join(","),
    "eth_chainId,anvil_nodeInfo,anvil_setBalance,eth_getBalance",
  );
});

test("requires an explicit USDC holder and checks its local balance before impersonation", async () => {
  const mock = rpcMock(async ({ method, params }) => {
    if (method === "eth_chainId") return "0x4cef52";
    if (method === "anvil_nodeInfo") return {};
    if (method === "eth_getCode") return params[0] === USDC_ADDRESS ? "0x6000" : "0x";
    if (method === "eth_call") return "0x0f4240";
    throw new Error(`unexpected RPC method ${method}`);
  });
  await assert.rejects(
    transferUsdc(HOLDER, RECIPIENT, 1_000_001n, mock.fetchFn),
    /balance is below/,
  );
  assert.equal(
    mock.calls.some((call) => call.method === "anvil_impersonateAccount"),
    false,
  );
  assert.equal(mock.calls[3].params[0].to, USDC_ADDRESS);
  assert.equal(LOCAL_RPC_URL, "http://127.0.0.1:8545");
});

test("transfers USDC through local-only impersonation and always stops it", async () => {
  const mock = rpcMock(async ({ method }) => {
    if (method === "eth_chainId") return "0x4cef52";
    if (method === "anvil_nodeInfo") return {};
    if (method === "eth_getCode") return "0x6000";
    if (method === "eth_call") return "0x1e8480";
    if (method === "anvil_impersonateAccount") return true;
    if (method === "eth_sendTransaction") return `0x${"1".repeat(64)}`;
    if (method === "eth_getTransactionReceipt") return { status: "0x1" };
    if (method === "anvil_stopImpersonatingAccount") return true;
    throw new Error(`unexpected RPC method ${method}`);
  });
  const transaction = await transferUsdc(HOLDER, RECIPIENT, 1_000_000n, mock.fetchFn);
  assert.equal(transaction, `0x${"1".repeat(64)}`);
  assert.deepEqual(
    mock.calls.map((call) => call.method),
    [
      "eth_chainId",
      "anvil_nodeInfo",
      "eth_getCode",
      "eth_call",
      "anvil_impersonateAccount",
      "eth_sendTransaction",
      "eth_getTransactionReceipt",
      "anvil_stopImpersonatingAccount",
    ],
  );
  assert.equal(mock.calls[5].params[0].to, USDC_ADDRESS);
});
