// Experiment A1: a deployed ERC-1271 contract pays a local x402 seller through Circle's
// Facilitator Service (keyless trial) on Arc testnet.
//
// Usage: PAYER=<erc1271 contract> MODE=verify|settle node x402-flow.mjs
//   PAYER defaults to the owner EOA's address (control run). MODE defaults to verify.
// Reads owner.key (signs for the contract) and seller.key (signs seller proofs) next to this file.
import { readFileSync } from "node:fs";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toBytes, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const readKey = (name) => readFileSync(join(here, name), "utf8").trim();

const FACILITATOR = "https://api.circle.com/v1/facilitator/x402";
const NETWORK = "eip155:5042002";
const CHAIN_ID = 5042002;
const USDC = "0x3600000000000000000000000000000000000000";
const PRICE = "100000"; // 0.1 USDC
const PORT = 4021;

const owner = privateKeyToAccount(readKey("owner.key"));
const seller = privateKeyToAccount(readKey("seller.key"));
const payer = process.env.PAYER ?? owner.address;
const mode = process.env.MODE ?? "verify";
if (!["verify", "settle"].includes(mode)) throw new Error(`MODE must be verify|settle, got ${mode}`);

const log = (label, value) =>
  console.log(`[${new Date().toISOString()}] ${label}`, JSON.stringify(value, null, 2));

const requirements = {
  scheme: "exact",
  network: NETWORK,
  amount: PRICE,
  asset: USDC,
  payTo: seller.address,
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
};
const resource = {
  url: `http://127.0.0.1:${PORT}/premium`,
  description: "Czar A1 ERC-1271 probe",
  mimeType: "application/json",
};

async function sellerProof(purpose, method, body) {
  const nonce = toHex(randomBytes(32));
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 300;
  const signature = await seller.signTypedData({
    domain: { name: "Circle Facilitator Seller Request", version: "1", chainId: CHAIN_ID },
    types: {
      SellerRequest: [
        { name: "purpose", type: "string" },
        { name: "method", type: "string" },
        { name: "bodyHash", type: "bytes32" },
        { name: "network", type: "string" },
        { name: "payTo", type: "address" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint64" },
        { name: "expiresAt", type: "uint64" },
      ],
    },
    primaryType: "SellerRequest",
    message: {
      purpose,
      method,
      bodyHash: keccak256(toBytes(body)),
      network: NETWORK,
      payTo: seller.address,
      nonce,
      issuedAt: BigInt(issuedAt),
      expiresAt: BigInt(expiresAt),
    },
  });
  const envelope = { version: 1, signature, network: NETWORK, payTo: seller.address, nonce, issuedAt, expiresAt };
  return Buffer.from(JSON.stringify(envelope)).toString("base64url");
}

async function callFacilitator(purpose, paymentPayload) {
  const body = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: requirements });
  const started = Date.now();
  const res = await fetch(`${FACILITATOR}/${purpose}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Facilitator-Seller-Proof": await sellerProof(purpose, "POST", body),
    },
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  log(`facilitator /${purpose} HTTP ${res.status} in ${Date.now() - started} ms`, json);
  return json;
}

const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");
const decode = (b64) => JSON.parse(Buffer.from(b64, "base64").toString("utf8"));

function startSeller() {
  const server = http.createServer(async (req, res) => {
    const header = req.headers["payment-signature"];
    if (!header) {
      res.writeHead(402, {
        "PAYMENT-REQUIRED": encode({ x402Version: 2, error: "payment required", resource, accepts: [requirements] }),
      });
      res.end("{}");
      return;
    }
    const paymentPayload = decode(header);
    const verified = await callFacilitator("verify", paymentPayload);
    if (!verified.isValid || mode === "verify") {
      res.writeHead(verified.isValid ? 200 : 402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ verified }));
      return;
    }
    const settled = await callFacilitator("settle", paymentPayload);
    res.writeHead(settled.success ? 200 : 402, {
      "Content-Type": "application/json",
      "PAYMENT-RESPONSE": encode(settled),
    });
    res.end(JSON.stringify({ data: "premium", settled }));
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

async function buyer() {
  const first = await fetch(resource.url);
  const required = decode(first.headers.get("payment-required"));
  log(`buyer got HTTP ${first.status} PAYMENT-REQUIRED`, required);
  const accepted = required.accepts[0];
  const authorization = {
    from: payer,
    to: accepted.payTo,
    value: accepted.amount,
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + 3600),
    nonce: toHex(randomBytes(32)),
  };
  // The owner EOA signs the USDC EIP-712 digest; for a contract payer, USDC and the facilitator
  // pass that signature to the contract's isValidSignature.
  const signature = await owner.signTypedData({
    domain: { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: USDC },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      ...authorization,
      value: BigInt(authorization.value),
      validAfter: 0n,
      validBefore: BigInt(authorization.validBefore),
    },
  });
  const paymentPayload = { x402Version: 2, resource, accepted, payload: { signature, authorization } };
  const second = await fetch(resource.url, { headers: { "PAYMENT-SIGNATURE": encode(paymentPayload) } });
  const paymentResponse = second.headers.get("payment-response");
  log(`buyer got HTTP ${second.status}`, {
    body: await second.json(),
    paymentResponse: paymentResponse ? decode(paymentResponse) : null,
  });
}

log("config", { mode, payer, owner: owner.address, seller: seller.address, price: PRICE });
const server = await startSeller();
try {
  await buyer();
} finally {
  server.close();
}
