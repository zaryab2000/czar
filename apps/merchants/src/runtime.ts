import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Config } from "@czar/config";
import type { Logger } from "@czar/logging";
import type { PaymentIdStore } from "./payment-id-store.ts";
import { createFacilitator } from "./facilitator.ts";
import { createSellerProofSigner, type MerchantSigner } from "./seller-proof.ts";
import { createSearchRoute, SEARCH_PATH } from "./search/route.ts";

interface MerchantServerOptions {
  readonly config: Config;
  readonly signer: MerchantSigner;
  readonly store: PaymentIdStore;
  readonly logger: Logger;
  readonly server?: Server;
  readonly port?: number;
  readonly host?: string;
  readonly drainTimeoutMs?: number;
  readonly fetchFn?: typeof fetch;
}

export interface MerchantRuntime {
  readonly server: Server;
  stop(): Promise<void>;
}

export async function createMerchantServer(
  options: MerchantServerOptions,
): Promise<MerchantRuntime> {
  let payTo: string;
  try {
    payTo = await options.signer.keyAddress("cz-20", "K10:czar-search");
  } catch (error) {
    throw new Error("merchant_signer_unavailable", { cause: error });
  }
  const indexedPayouts = options.config.get("indexer.merchantPayoutAddresses") as readonly string[];
  if (
    indexedPayouts.length > 0 &&
    !indexedPayouts.some((address) => address.toLowerCase() === payTo.toLowerCase())
  )
    options.logger.warn("merchant_payout_unindexed", { payTo });
  const network = String(options.config.get("selection.paymentNetwork"));
  const facilitator = createFacilitator({
    sellerProof: createSellerProofSigner({ signer: options.signer, network, payTo }),
    baseUrl: String(options.config.get("merchants.facilitatorBaseUrl")),
    timeoutMs: Number(options.config.get("merchants.facilitatorTimeoutMs")),
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  });
  const route = createSearchRoute({
    resourceUrl: `${String(options.config.get("merchants.publicOrigin"))}${SEARCH_PATH}`,
    network,
    payTo,
    priceAtomic: String(options.config.get("merchants.searchPriceAtomic")),
    maxTimeoutSeconds: Number(options.config.get("merchants.maxTimeoutSeconds")),
    handlerTimeoutMs: Number(options.config.get("merchants.handlerTimeoutMs")),
    perPayerPerMin: Number(options.config.get("merchants.perPayerPerMin")),
    facilitator,
    store: options.store,
    emit: (event, fields) => options.logger.info(event.replaceAll(".", "_"), fields),
  });
  const server = options.server ?? createServer();
  const perRouteLimit = Number(options.config.get("merchants.perRoutePerMin"));
  let routeWindowStart = Date.now();
  let routeCount = 0;
  server.on("request", (incoming, outgoing) => {
    void handleRequest(incoming, outgoing, route, options, () => {
      const now = Date.now();
      if (now - routeWindowStart >= 60_000) {
        routeWindowStart = now;
        routeCount = 0;
      }
      routeCount += 1;
      return routeCount <= perRouteLimit;
    });
  });
  await listen(
    server,
    options.port ?? Number(process.env["CZAR_MERCHANT_PORT"] ?? "8787"),
    options.host ?? "127.0.0.1",
  );
  let stopping: Promise<void> | undefined;
  return {
    server,
    stop() {
      stopping ??= drain(
        server,
        options.drainTimeoutMs ?? Number(options.config.get("merchants.drainTimeoutMs")),
      );
      return stopping;
    },
  };
}

async function handleRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  route: (request: Request) => Promise<Response>,
  options: MerchantServerOptions,
  allowRoute: () => boolean,
): Promise<void> {
  if (incoming.method === "GET" && incoming.url === "/health") {
    send(
      outgoing,
      new Response('{"status":"ok"}', { headers: { "content-type": "application/json" } }),
    );
    return;
  }
  if (incoming.url?.split("?", 1)[0] === SEARCH_PATH && !allowRoute()) {
    send(
      outgoing,
      new Response('{"error":"route rate limit exceeded"}', {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60" },
      }),
    );
    return;
  }
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) value.forEach((part) => headers.append(name, part));
      else if (value !== undefined) headers.set(name, value);
    }
    const method = incoming.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(incoming);
    const request = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
      method,
      headers,
      ...(body === undefined ? {} : ({ body, duplex: "half" } as RequestInit)),
    });
    send(outgoing, await route(request));
  } catch {
    options.logger.error("merchant.request_failed", {
      route: incoming.url?.split("?", 1)[0] ?? "unknown",
    });
    send(
      outgoing,
      new Response('{"error":"merchant unavailable"}', {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
  }
}

function send(outgoing: ServerResponse, response: Response): void {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  void response.arrayBuffer().then((body) => outgoing.end(Buffer.from(body)));
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function drain(server: Server, timeoutMs: number): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => server.closeAllConnections(), timeoutMs);
    server.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}
