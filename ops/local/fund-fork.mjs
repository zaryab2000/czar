export const LOCAL_RPC_URL = "http://127.0.0.1:8545";
export const LOCAL_CHAIN_ID = 5042002;
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
export const OWNER_NATIVE_AMOUNT = 10n ** 18n;
export const SERVICE_NATIVE_AMOUNT = 10n * 10n ** 18n;
export const VAULT_USDC_AMOUNT = 10n * 10n ** 6n;
const FUNDED_KEY_ROLES = new Set([
  "K3",
  "K5",
  "K6",
  "K7",
  "K8",
  "K20",
  "K10:czar-search",
  "relayer",
]);

export function parseAmount(value, decimals) {
  const pattern = new RegExp(`^(0|[1-9][0-9]*)(?:\\.([0-9]{1,${decimals}}))?$`);
  const match = pattern.exec(value);
  if (match === null) throw new Error(`amount must be a decimal with at most ${decimals} places`);
  const fraction = (match[2] ?? "").padEnd(decimals, "0");
  const amount = BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt(fraction || "0");
  if (amount <= 0n) throw new Error("amount must be greater than zero");
  return amount;
}

export async function fundNative(address, amount, fetchFn = fetch) {
  validateAddress(address, "recipient");
  validateAmount(amount);
  await validateLocalRpc(fetchFn);
  await rpc(fetchFn, "anvil_setBalance", [address, `0x${amount.toString(16)}`]);
  return await rpc(fetchFn, "eth_getBalance", [address, "latest"]);
}

export async function transferUsdc(holder, recipient, amount, fetchFn = fetch) {
  validateAddress(holder, "USDC holder");
  validateAddress(recipient, "recipient");
  validateAmount(amount);
  await validateLocalRpc(fetchFn);
  const code = await rpc(fetchFn, "eth_getCode", [USDC_ADDRESS, "latest"]);
  if (code === "0x") throw new Error("USDC contract code is missing on the local fork");
  const balance = BigInt(
    await rpc(fetchFn, "eth_call", [
      {
        to: USDC_ADDRESS,
        data: `0x70a08231${holder.slice(2).toLowerCase().padStart(64, "0")}`,
      },
      "latest",
    ]),
  );
  if (balance < amount) throw new Error("explicit USDC holder balance is below requested amount");
  await rpc(fetchFn, "anvil_impersonateAccount", [holder]);
  try {
    const data = `0xa9059cbb${recipient.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
    const transaction = await rpc(fetchFn, "eth_sendTransaction", [
      {
        from: holder,
        to: USDC_ADDRESS,
        data,
      },
    ]);
    if (typeof transaction !== "string" || !/^0x[\da-fA-F]{64}$/.test(transaction)) {
      throw new Error("local RPC returned an invalid USDC transfer transaction hash");
    }
    const receipt = await waitForReceipt(fetchFn, transaction);
    if (receipt?.status !== "0x1") throw new Error("local USDC transfer did not succeed");
    return transaction;
  } finally {
    await rpc(fetchFn, "anvil_stopImpersonatingAccount", [holder]);
  }
}

async function validateLocalRpc(fetchFn) {
  const chainId = BigInt(await rpc(fetchFn, "eth_chainId", []));
  if (chainId !== BigInt(LOCAL_CHAIN_ID)) {
    throw new Error(`local RPC chain id ${chainId} does not equal ${LOCAL_CHAIN_ID}`);
  }
  await rpc(fetchFn, "anvil_nodeInfo", []);
}

async function waitForReceipt(fetchFn, transaction) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const receipt = await rpc(fetchFn, "eth_getTransactionReceipt", [transaction]);
    if (receipt !== null) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("local fork did not return a receipt for the USDC transfer");
}

async function rpc(fetchFn, method, params) {
  const response = await fetchFn(LOCAL_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`local RPC ${method} failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (typeof payload !== "object" || payload === null || "error" in payload) {
    throw new Error(`local RPC ${method} returned an error`);
  }
  return payload.result;
}

function validateAddress(value, name) {
  if (!/^0x[\da-fA-F]{40}$/.test(value)) throw new Error(`${name} must be an EVM address`);
}

function validateAmount(value) {
  if (typeof value !== "bigint" || value <= 0n) throw new Error("amount must be greater than zero");
}

export function parseFundingRequest(args) {
  const values = Object.fromEntries(
    args.slice(2).map((item, index, all) => {
      if (item.startsWith("--")) return [item.slice(2), all[index + 1]];
      return [];
    }),
  );
  if (values["owner-native"] !== undefined) {
    return { kind: "owner-native", address: values["owner-native"], amount: OWNER_NATIVE_AMOUNT };
  }
  if (
    values["service-native"] !== undefined &&
    values.address !== undefined &&
    FUNDED_KEY_ROLES.has(values["service-native"])
  ) {
    return {
      kind: "service-native",
      service: values["service-native"],
      address: values.address,
      amount: SERVICE_NATIVE_AMOUNT,
    };
  }
  if (values["vault-usdc"] !== undefined && values["usdc-holder"] !== undefined) {
    return {
      kind: "vault-usdc",
      holder: values["usdc-holder"],
      recipient: values["vault-usdc"],
      amount: VAULT_USDC_AMOUNT,
    };
  }
  throw new Error(
    "usage: fund-fork.mjs --owner-native ADDRESS | --service-native SERVICE --address ADDRESS | --vault-usdc VAULT --usdc-holder HOLDER",
  );
}

async function main(args) {
  const request = parseFundingRequest(args);
  if (request.kind === "owner-native") {
    await fundNative(request.address, request.amount);
    process.stdout.write(`Set owner MSCA balance to 1 native unit: ${request.address}\n`);
    return;
  }
  if (request.kind === "service-native") {
    await fundNative(request.address, request.amount);
    process.stdout.write(`Set service key ${request.service} balance to 10 native units\n`);
    return;
  }
  const transaction = await transferUsdc(request.holder, request.recipient, request.amount);
  process.stdout.write(`Funded vault with 10 USDC; local transaction ${transaction}\n`);
}

if (process.argv[1]?.endsWith("fund-fork.mjs")) {
  main(process.argv).catch((error) => {
    process.stderr.write(`local funding refused: ${error.message}\n`);
    process.exitCode = 1;
  });
}
