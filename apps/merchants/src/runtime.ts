import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Config } from "@czar/config";
import type { Logger } from "@czar/logging";
import type { PaymentIdStore } from "./payment-id-store.ts";
import { createFacilitator, type Facilitator } from "./facilitator.ts";
import { createSellerProofSigner, type MerchantSigner } from "./seller-proof.ts";
import { createSearchRoute, SEARCH_PATH } from "./search/route.ts";
import {
  discoveryIndexEntry,
  type DiscoveryIndexEntry,
  type ProviderMetadata,
} from "./index-entry.ts";
import type { MerchantService } from "./vanilla-route.ts";

/**
 * What a service needs from the runtime to be built: its own K10 `payTo` address from the signer, its own
 * Facilitator client (the seller proof names the service, CZ-20 §5.8) and the shared store and logger.
 */
export interface ServiceBuildContext {
  readonly config: Config;
  readonly network: string;
  /** This service's K10 address, already resolved through the signer. */
  readonly payTo: string;
  readonly facilitator: Facilitator;
  readonly store: PaymentIdStore;
  readonly emit: (
    event: string,
    fields: Readonly<Record<string, string | number | boolean>>,
  ) => void;
  /** `merchants.publicOrigin` + the route path (CZ-20 §5.8). */
  resourceUrl(path: string): string;
}

/** One entry of the runtime's service list: the `K10:<service>` id and how to build its route. */
export interface MerchantServiceSpec {
  /** The service id, as in `K10:<service>` and `extensions.czar`. */
  readonly serviceName: string;
  build(context: ServiceBuildContext): MerchantService;
}

export interface MerchantServerOptions {
  readonly config: Config;
  readonly signer: MerchantSigner;
  readonly store: PaymentIdStore;
  readonly logger: Logger;
  readonly server?: Server;
  readonly port?: number;
  readonly host?: string;
  readonly drainTimeoutMs?: number;
  readonly fetchFn?: typeof fetch;
  /**
   * The services this process serves, in order. Left out, the process serves `czar-search` alone, exactly
   * as it did before PM-042 — which is what `local-main.ts` relies on, because the local signer knows only
   * that one K10 service (`apps/signer/src/local-main.ts:58`).
   */
  readonly services?: readonly MerchantServiceSpec[];
}

export interface MerchantRuntime {
  readonly server: Server;
  /** The route paths this process serves, in registration order. */
  readonly routes: readonly string[];
  /** One discovery-index entry per served route, derived from each route's live 402 (CZ-20 §5.8). */
  indexEntries(options?: {
    readonly lastUpdated?: string;
    readonly serviceIds?: Readonly<Record<string, string>>;
    readonly provider?: ProviderMetadata;
  }): readonly DiscoveryIndexEntry[];
  stop(): Promise<void>;
}

/** `czar-search`, the one service the local stack serves (CZ-20 §5.1). */
export const searchServiceSpec: MerchantServiceSpec = {
  serviceName: "czar-search",
  build: (context) => {
    const route = createSearchRoute({
      resourceUrl: context.resourceUrl(SEARCH_PATH),
      network: context.network,
      payTo: context.payTo,
      priceAtomic: String(context.config.get("merchants.searchPriceAtomic")),
      maxTimeoutSeconds: Number(context.config.get("merchants.maxTimeoutSeconds")),
      handlerTimeoutMs: Number(context.config.get("merchants.handlerTimeoutMs")),
      perPayerPerMin: Number(context.config.get("merchants.perPayerPerMin")),
      facilitator: context.facilitator,
      store: context.store,
      emit: context.emit,
    });
    return {
      serviceName: "czar-search",
      path: SEARCH_PATH,
      method: "GET",
      paymentRequired: route.paymentRequired,
      handle: route,
    };
  },
};

export async function createMerchantServer(
  options: MerchantServerOptions,
): Promise<MerchantRuntime> {
  const specs = options.services ?? [searchServiceSpec];
  const network = String(options.config.get("selection.paymentNetwork"));
  const publicOrigin = String(options.config.get("merchants.publicOrigin"));
  const indexedPayouts = options.config.get("indexer.merchantPayoutAddresses") as readonly string[];
  const emit = (event: string, fields: Readonly<Record<string, string | number | boolean>>) =>
    options.logger.info(event.replaceAll(".", "_"), fields);

  const services: MerchantService[] = [];
  for (const spec of specs) {
    let payTo: string;
    try {
      payTo = await options.signer.keyAddress("cz-20", `K10:${spec.serviceName}`);
    } catch (error) {
      throw new Error("merchant_signer_unavailable", { cause: error });
    }
    if (
      indexedPayouts.length > 0 &&
      !indexedPayouts.some((address) => address.toLowerCase() === payTo.toLowerCase())
    )
      options.logger.warn("merchant_payout_unindexed", { payTo });
    const facilitator = createFacilitator({
      sellerProof: createSellerProofSigner({
        signer: options.signer,
        network,
        payTo,
        service: spec.serviceName,
      }),
      baseUrl: String(options.config.get("merchants.facilitatorBaseUrl")),
      timeoutMs: Number(options.config.get("merchants.facilitatorTimeoutMs")),
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    });
    services.push(
      spec.build({
        config: options.config,
        network,
        payTo,
        facilitator,
        store: options.store,
        emit,
        resourceUrl: (path) => `${publicOrigin}${path}`,
      }),
    );
  }
  const byPath = new Map(services.map((service) => [service.path, service]));
  const server = options.server ?? createServer();
  const activeHandlers = new Set<Promise<void>>();
  let draining = false;
  const perRouteLimit = Number(options.config.get("merchants.perRoutePerMin"));
  const routeWindows = new Map<string, { start: number; count: number }>();
  const allowRoute = (path: string) => {
    const now = Date.now();
    const window = routeWindows.get(path);
    if (window === undefined || now - window.start >= 60_000) {
      routeWindows.set(path, { start: now, count: 1 });
      return perRouteLimit >= 1;
    }
    window.count += 1;
    return window.count <= perRouteLimit;
  };
  server.on("request", (incoming, outgoing) => {
    if (draining) {
      outgoing.writeHead(503, { "content-type": "application/json", connection: "close" });
      outgoing.end('{"error":"merchant shutting down"}');
      return;
    }
    const handler = handleRequest(incoming, outgoing, byPath, options, allowRoute);
    activeHandlers.add(handler);
    void handler.then(
      () => activeHandlers.delete(handler),
      () => activeHandlers.delete(handler),
    );
  });
  await listen(
    server,
    options.port ?? Number(process.env["CZAR_MERCHANT_PORT"] ?? "8787"),
    options.host ?? "127.0.0.1",
  );
  let stopping: Promise<void> | undefined;
  return {
    server,
    routes: services.map((service) => service.path),
    indexEntries(entryOptions = {}) {
      const lastUpdated = entryOptions.lastUpdated ?? new Date().toISOString();
      return services.map((service) => {
        const serviceId = entryOptions.serviceIds?.[service.serviceName];
        return discoveryIndexEntry({
          paymentRequired: service.paymentRequired,
          path: service.path,
          method: service.method,
          lastUpdated,
          // Gateway routes are T-051 part B (SCR-177); no Gateway route answers a 402 yet.
          supportsCircleGateway: false,
          ...(serviceId === undefined ? {} : { serviceId }),
          ...(service.testMerchant === true ? { testMerchant: true } : {}),
          ...(entryOptions.provider === undefined ? {} : { provider: entryOptions.provider }),
        });
      });
    },
    stop() {
      if (stopping === undefined) {
        draining = true;
        stopping = drain(
          server,
          activeHandlers,
          options.drainTimeoutMs ?? Number(options.config.get("merchants.drainTimeoutMs")),
        );
      }
      return stopping;
    },
  };
}

async function handleRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  byPath: ReadonlyMap<string, MerchantService>,
  options: MerchantServerOptions,
  allowRoute: (path: string) => boolean,
): Promise<void> {
  if (incoming.method === "GET" && incoming.url === "/health") {
    await send(
      outgoing,
      new Response('{"status":"ok"}', { headers: { "content-type": "application/json" } }),
    );
    return;
  }
  const path = requestPath(incoming.url);
  const service = path === undefined ? undefined : byPath.get(path);
  if (service === undefined) {
    await send(
      outgoing,
      new Response('{"error":"not found"}', {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    return;
  }
  // The route limit is per route (`merchants.perRoutePerMin`), so one busy service cannot starve another.
  if (!allowRoute(service.path)) {
    await send(
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
    await send(outgoing, await service.handle(request));
  } catch {
    options.logger.error("merchant.request_failed", {
      route: incoming.url?.split("?", 1)[0] ?? "unknown",
    });
    await send(
      outgoing,
      new Response('{"error":"merchant unavailable"}', {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
  }
}

async function send(outgoing: ServerResponse, response: Response): Promise<void> {
  if (outgoing.destroyed) return;
  const body = Buffer.from(await response.arrayBuffer());
  if (outgoing.destroyed) return;
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  outgoing.end(body);
}

function requestPath(url: string | undefined): string | undefined {
  try {
    return new URL(url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return undefined;
  }
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

function drain(
  server: Server,
  activeHandlers: ReadonlySet<Promise<void>>,
  timeoutMs: number,
): Promise<void> {
  if (!server.listening) return Promise.resolve();
  const closeServer = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  const handlers = Promise.allSettled(activeHandlers).then(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, timeoutMs);
  });
  return Promise.race([
    Promise.all([closeServer, handlers]).then(() => undefined),
    timedOut,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
