// A local x402 seller for SCR-146 run 5: it answers the probe with a v2 `PAYMENT-REQUIRED` offer and settles
// every paid call through the D92 Facilitator stand-in's `/settle` handler, called in-process, which sends
// `transferWithAuthorization` on the local chain. Like a seller honouring the x402 payment identifier, a
// retry with an authorization it already settled gets the stored response back and nothing is settled
// again. A test can kill the payer after the seller settled and before the payer reads the response.
import { type Address } from "viem";
import {
  buildPaymentRequired,
  decodeBase64Json,
  encodeBase64Json,
  encodePaymentRequired,
  type SafeFetch,
  type SafeFetchResponse,
} from "@czar/x402";
import { handleStandinRequest } from "../../../../ops/local/circle-standins/server.ts";
import { ARC_CHAIN_ID, ARC_USDC, InjectedCrash, type ArcChain } from "#test/local-pocket/arc-chain";

export const MERCHANT_ORIGIN = "http://127.0.0.1:4029";
/** The stand-in's default address (`CZAR_STANDIN_PORT`); requests are routed in-process, not over HTTP. */
const FACILITATOR_SETTLE_URL = "http://127.0.0.1:4999/settle";
const HTTP_OK = 200;
const HTTP_PAYMENT_REQUIRED = 402;
const HTTP_BAD_GATEWAY = 502;

export interface X402Merchant {
  readonly resourceUrl: string;
  readonly payTo: Address;
  readonly fetch: SafeFetch;
  /** The next paid call is settled on chain; then the payer dies before it reads the response. */
  armCrashAfterSettle(): void;
  /** Facilitator `/settle` calls the seller made (one per first-seen authorization). */
  settlements(): number;
}

interface PaidRequest {
  readonly payload: { readonly authorization: { readonly nonce: string } };
  readonly accepted: unknown;
}

export function createX402Merchant(input: {
  readonly chain: ArcChain;
  readonly payTo: Address;
  readonly unitAmount: bigint;
  readonly maxTimeoutSeconds: number;
}): X402Merchant {
  const resourceUrl = `${MERCHANT_ORIGIN}/data`;
  const settled = new Map<string, SafeFetchResponse>();
  let crashArmed = false;
  let settleCalls = 0;
  const fetch: SafeFetch = async (url, options) => {
    const header = options?.headers?.["payment-signature"];
    if (typeof header !== "string") return paymentRequired(url, input);
    const decoded = decodeBase64Json(header);
    if (!decoded.ok) throw new Error("The payer sent a malformed payment-signature header.");
    const payment = decoded.value as PaidRequest;
    const nonce = payment.payload.authorization.nonce.toLowerCase();
    const replay = settled.get(nonce);
    if (replay) return replay;
    settleCalls += 1;
    const response = await settle(input.chain, url, payment);
    if (response.status === HTTP_OK) settled.set(nonce, response);
    if (crashArmed) {
      crashArmed = false;
      throw new InjectedCrash("after the seller settled the call");
    }
    return response;
  };
  return {
    resourceUrl,
    payTo: input.payTo,
    fetch,
    armCrashAfterSettle() {
      crashArmed = true;
    },
    settlements: () => settleCalls,
  };
}

function paymentRequired(
  url: string,
  input: {
    readonly payTo: Address;
    readonly unitAmount: bigint;
    readonly maxTimeoutSeconds: number;
  },
): SafeFetchResponse {
  const offer = buildPaymentRequired({
    url,
    description: "Local crash-restart seller",
    serviceName: "local-seller",
    tags: [],
    network: `eip155:${ARC_CHAIN_ID}`,
    amount: input.unitAmount.toString(),
    payTo: input.payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds,
  });
  return {
    status: HTTP_PAYMENT_REQUIRED,
    url,
    headers: { "payment-required": encodePaymentRequired(offer) },
    body: new Uint8Array(),
  };
}

async function settle(
  chain: ArcChain,
  url: string,
  payment: PaidRequest,
): Promise<SafeFetchResponse> {
  const response = await handleStandinRequest(
    new Request(FACILITATOR_SETTLE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: payment,
        paymentRequirements: payment.accepted,
      }),
    }),
    chain.rpc,
    ARC_USDC,
  );
  const result = (await response.json()) as { success?: boolean; transaction?: string };
  if (response.status !== HTTP_OK || result.success !== true)
    return { status: HTTP_BAD_GATEWAY, url, headers: {}, body: new Uint8Array() };
  return {
    status: HTTP_OK,
    url,
    headers: {
      "content-type": "application/json",
      "payment-response": encodeBase64Json({
        success: true,
        transaction: result.transaction,
        network: `eip155:${ARC_CHAIN_ID}`,
      }),
    },
    body: new TextEncoder().encode(JSON.stringify({ price: "12.00" })),
  };
}
