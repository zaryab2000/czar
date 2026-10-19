// Calls the public Gateway /v1/x402/verify directly (read-only check, no settlement) for three signer cases,
// to get the exact invalidReason: buyer signs for buyer (control), delegate signs for buyer, delegate signs for itself.
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { GATEWAY_API, log, readAddr, readKey } from "./common.ts";

const SELLER_URL = process.env["SELLER_URL"] ?? "http://127.0.0.1:4022/premium";
const res = await fetch(SELLER_URL);
const required = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED") ?? "", "base64").toString("utf8"));
const requirements = required.accepts.find(
  (o: { extra?: { name?: string } }) => o.extra?.name === "GatewayWalletBatched",
);

async function verify(label: string, claimedFrom: Hex, keyName: string): Promise<void> {
  const account = privateKeyToAccount(readKey(keyName));
  const scheme = new BatchEvmScheme({
    address: claimedFrom,
    signTypedData: (p) => account.signTypedData(p as Parameters<typeof account.signTypedData>[0]),
  });
  const partial = await scheme.createPaymentPayload(required.x402Version ?? 2, requirements);
  const paymentPayload = { ...partial, resource: required.resource, accepted: requirements };
  const r = await fetch(`${GATEWAY_API}/v1/x402/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentPayload, paymentRequirements: requirements }),
  });
  log("verify.direct", { label, claimedFrom, signer: account.address, httpStatus: r.status, body: await r.json() });
}

await verify("buyer-signs-for-buyer (control)", readAddr("buyer"), "buyer");
await verify("delegate-signs-for-buyer", readAddr("buyer"), "delegate");
await verify("delegate-signs-for-itself (no balance)", readAddr("delegate"), "delegate");
// ERC-1271 case: Owned1271 contract (erc1271/) holds a Gateway balance via depositFor; its owner EOA (delegate key) signs.
await verify("erc1271-contract-owner-signs-for-contract", readAddr("contract"), "delegate");
