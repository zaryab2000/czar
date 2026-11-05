import { buildPaymentRequired, encodePaymentRequired } from "@czar/x402";

const FIXTURES = new Map([
  ["8788", { name: "comparison-search", payTo: `0x${"1".repeat(40)}` }],
  ["8789", { name: "lesson-search", payTo: `0x${"2".repeat(40)}` }],
]);

/** Return only an unpaid 402 declaration for the two controlled local suppliers. */
export function fixtureMerchantResponse(request: Request): Response {
  const url = new URL(request.url);
  const fixture = FIXTURES.get(url.port);
  if (
    url.hostname !== "127.0.0.1" ||
    !fixture ||
    request.method !== "GET" ||
    url.pathname !== "/v1/search" ||
    !url.searchParams.get("q")
  ) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (request.headers.has("payment-signature") || request.headers.has("x-payment")) {
    return Response.json({ error: "controlled fixture never settles" }, { status: 400 });
  }
  const challenge = buildPaymentRequired({
    url: `${url.origin}/v1/search`,
    description: "Unpaid controlled social supplier fixture",
    serviceName: fixture.name,
    tags: ["search", "web-search"],
    network: "eip155:5042002",
    amount: "100000",
    payTo: fixture.payTo,
    maxTimeoutSeconds: 300,
  });
  return Response.json(challenge, {
    status: 402,
    headers: { "payment-required": encodePaymentRequired(challenge) },
  });
}
