// The six lab services (CZ-20 §5.8a, T-106), each a `MerchantServiceSpec` the runtime builds behind the
// service's own `K10:<id>` payout key. Every behaviour comes from a named `merchants.lab.<service>.*`
// parameter and the seed, never from the caller. The data is bundled: lab search reads the same fixed
// corpus as `czar-search`, lab extract reads `./corpus/`, and lab spot reads the `czar-spot` cache. A lab
// service makes no request of its own.
//
// Ranking language in the spec ("what the Selection Layer should learn") is outdated since the ratings
// rework; these services only produce the behaviour.
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { Config } from "@czar/config";
import type { SafeFetch } from "@czar/x402";
import {
  readJsonBody,
  type MerchantService,
  type ParsedInput,
} from "@czar/merchants/vanilla-route";
import type { MerchantServiceSpec, ServiceBuildContext } from "@czar/merchants/runtime";
import { MAX_BODY_BYTES, MAX_URL_CHARS } from "../extract/index.ts";
import { MAX_QUERY_CHARS, search } from "../search/index.ts";
import { createSpotCache, MAX_PAIR_CHARS } from "../spot/index.ts";
import { labPageByUrl, LAB_CORPUS, type LabPage } from "./corpus/index.ts";
import { LAB_SERVICE_IDS, labCoin, labPath, payeeSwapped, type LabServiceId } from "./profiles.ts";
import { createLabRoute, type AlternateOffer } from "./route.ts";

export interface LabServiceOptions {
  readonly config: Config;
  /** Used by lab spot only, through the `czar-spot` cache. */
  readonly safeFetch: SafeFetch;
  /** `merchants.lab.seed`, or the caller's seed when that key cannot be set. */
  readonly seed: number;
  /**
   * The second Czar-owned payee `lab-spot-payee-swap` names on its swapped days. Left out, that one service
   * is not built: it has nothing to swap to.
   */
  readonly swapPayTo?: string | undefined;
  /** Test seam for `lab-search-slow`'s delay. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam for the clock `lab-spot-payee-swap` reads. */
  readonly now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const DECIMAL_BASIS_POINTS = 10_000n;

type LabKey = `merchants.lab.${LabServiceId}.${string}`;

const key = (id: LabServiceId, name: string) => `merchants.lab.${id}.${name}` as LabKey;

/** A rate is a share of calls: a number in [0, 1]. Anything else is a configuration error, not a clamp. */
function rate(config: Config, id: LabServiceId, name: string): number {
  const value = Number(config.get(key(id, name) as never));
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error(`${key(id, name)} must be a number from 0 to 1`);
  return value;
}

function wholeNumber(config: Config, id: LabServiceId, name: string, minimum: number): number {
  const value = Number(config.get(key(id, name) as never));
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${key(id, name)} must be a whole number of at least ${minimum}`);
  return value;
}

/** The parameters every lab route shares with its core twin, from the build context. */
function shared(context: ServiceBuildContext, id: LabServiceId) {
  const { config } = context;
  return {
    serviceName: id,
    resourceUrl: context.resourceUrl(labPath(id)),
    network: context.network,
    payTo: context.payTo,
    priceAtomic: String(config.get("merchants.lab.priceAtomic")),
    maxTimeoutSeconds: Number(config.get("merchants.maxTimeoutSeconds")),
    handlerTimeoutMs: Number(config.get("merchants.handlerTimeoutMs")),
    perPayerPerMin: Number(config.get("merchants.perPayerPerMin")),
    facilitator: context.facilitator,
    store: context.store,
    emit: context.emit,
  } as const;
}

function enrichedDeclaration(
  declaration: Readonly<Record<string, unknown>>,
  method: "GET" | "POST",
  path: string,
) {
  const enrich = bazaarResourceServerExtension.enrichDeclaration;
  if (enrich === undefined) throw new Error("@x402/extensions bazaar has no enrichDeclaration");
  return enrich(declaration["bazaar"] as never, { method, adapter: { getPath: () => path } });
}

// ── search ────────────────────────────────────────────────────────────────────

interface SearchInput {
  readonly q: string;
}

function searchBazaar(id: LabServiceId): unknown {
  return enrichedDeclaration(
    declareDiscoveryExtension({
      input: { q: "x402 payment" },
      inputSchema: {
        properties: { q: { type: "string", minLength: 1, maxLength: MAX_QUERY_CHARS } },
        required: ["q"],
        additionalProperties: false,
      },
    }),
    "GET",
    labPath(id),
  );
}

/** Input is data: exactly one `q`, bounded (CZ-20 §5.7). */
async function parseSearch(request: Request): Promise<ParsedInput<SearchInput>> {
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  const q = url.searchParams.get("q");
  if (
    keys.length !== 1 ||
    keys[0] !== "q" ||
    q === null ||
    q.length === 0 ||
    q.length > MAX_QUERY_CHARS
  )
    return { ok: false, error: "expected exactly one query parameter q (1–200 characters)" };
  return { ok: true, input: { q }, hashed: { q } };
}

function searchService(
  id: LabServiceId,
  description: string,
  handle: (input: SearchInput) => Promise<unknown>,
): MerchantServiceSpec {
  return {
    serviceName: id,
    build: (context) =>
      createLabRoute<SearchInput>({
        ...shared(context, id),
        path: labPath(id),
        method: "GET",
        description,
        tags: ["search", "web-search", "test-merchant"],
        bazaar: searchBazaar(id),
        parse: parseSearch,
        handle,
      }),
  };
}

// ── extract ───────────────────────────────────────────────────────────────────

interface ExtractInput {
  readonly page: LabPage;
}

function extractBazaar(id: LabServiceId): unknown {
  return enrichedDeclaration(
    declareDiscoveryExtension({
      bodyType: "json",
      input: { url: (LAB_CORPUS[0] as LabPage).url },
      inputSchema: {
        properties: {
          url: {
            type: "string",
            format: "uri",
            minLength: 1,
            maxLength: MAX_URL_CHARS,
            enum: LAB_CORPUS.map((page) => page.url),
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    }),
    "POST",
    labPath(id),
  );
}

/**
 * Input is data: exactly `{url}`, and the url must be one of the bundled pages. A lab extract service never
 * fetches, so a url it cannot serve is refused before any payment step (the buyer is not charged).
 */
async function parseExtract(request: Request): Promise<ParsedInput<ExtractInput>> {
  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (!read.ok) return { ok: false, error: "expected a JSON body of at most 8 KiB" };
  const body = read.value;
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return { ok: false, error: "expected a JSON object body {url}" };
  const keys = Object.keys(body);
  const url = (body as Record<string, unknown>)["url"];
  if (keys.length !== 1 || keys[0] !== "url" || typeof url !== "string")
    return { ok: false, error: "expected exactly one body field url (a string)" };
  const page = url.length > MAX_URL_CHARS ? undefined : labPageByUrl(url);
  if (page === undefined)
    return { ok: false, error: "url is not one of the pages this test service serves" };
  return { ok: true, input: { page }, hashed: { url: page.url } };
}

/** The `czar-extract` answer shape, `{title, text, links[], untrusted}`, from a bundled page. */
function intactPage(page: LabPage, maxChars: number) {
  return { title: page.title, text: page.text.slice(0, maxChars), links: [], untrusted: true };
}

// ── the six services ──────────────────────────────────────────────────────────

export function labServiceSpecs(options: LabServiceOptions): readonly MerchantServiceSpec[] {
  const { config, seed } = options;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(seed)) throw new Error("the lab seed must be a whole number");

  const builders: Record<LabServiceId, () => MerchantServiceSpec | undefined> = {
    // Reliable: always delivers, schema exact.
    "lab-search-steady": () =>
      searchService(
        "lab-search-steady",
        "Search a fixed index of protocol documentation (Czar test merchant, reliable)",
        async ({ q }) => search(q),
      ),

    // Flaky: the handler fails `failRate` of the time. The vanilla lifecycle settles only after the handler
    // succeeded, so a failed call answers 5xx, is never settled and the buyer is not charged.
    "lab-search-flaky": () => {
      const id = "lab-search-flaky";
      const failRate = rate(config, id, "failRate");
      const fails = labCoin(seed, id, "fail", failRate);
      return searchService(
        id,
        "Search a fixed index of protocol documentation (Czar test merchant, flaky)",
        async ({ q }) => {
          if (fails()) throw new Error("lab: seeded handler failure");
          return search(q);
        },
      );
    },

    // Slow: delivers correctly, after `delayMs`.
    "lab-search-slow": () => {
      const id = "lab-search-slow";
      const delayMs = wholeNumber(config, id, "delayMs", 0);
      const budgetMs = Number(config.get("merchants.handlerTimeoutMs"));
      const timeoutMs = Number(config.get("merchants.maxTimeoutSeconds")) * 1000;
      if (delayMs >= budgetMs || delayMs >= timeoutMs)
        throw new Error(
          `${key(id, "delayMs")} must stay inside merchants.handlerTimeoutMs and merchants.maxTimeoutSeconds`,
        );
      return searchService(
        id,
        "Search a fixed index of protocol documentation (Czar test merchant, slow)",
        async ({ q }) => {
          await sleep(delayMs);
          return search(q);
        },
      );
    },

    // Schema-breaking: `schemaBreakRate` of the answers are JSON missing `text`.
    "lab-extract-schemabreak": () => {
      const id = "lab-extract-schemabreak";
      const schemaBreakRate = rate(config, id, "schemaBreakRate");
      const maxChars = Number(config.get("merchants.extractMaxChars"));
      const breaks = labCoin(seed, id, "schema", schemaBreakRate);
      return extractService(id, "schema-breaking", {
        handle: async ({ page }) => {
          const intact = intactPage(page, maxChars);
          if (!breaks()) return intact;
          const { text: _text, ...broken } = intact;
          return broken;
        },
      });
    },

    // Price-drifting: `driftRate` of the live 402s quote the price `driftBps` above the indexed one.
    "lab-extract-drift": () => {
      const id = "lab-extract-drift";
      const driftRate = rate(config, id, "driftRate");
      const driftBps = BigInt(wholeNumber(config, id, "driftBps", 1));
      const maxChars = Number(config.get("merchants.extractMaxChars"));
      const drifts = labCoin(seed, id, "drift", driftRate);
      return extractService(id, "price-drifting", {
        handle: async ({ page }) => intactPage(page, maxChars),
        alternate: (indexed) => {
          // Rounded up, so a drifted price always differs from the indexed one.
          const base = BigInt(indexed);
          const drifted =
            (base * (DECIMAL_BASIS_POINTS + driftBps) + DECIMAL_BASIS_POINTS - 1n) /
            DECIMAL_BASIS_POINTS;
          return {
            priceAtomic: drifted.toString(),
            choose: () => drifts(),
          };
        },
      });
    },

    // Payee-changing: the live 402 names a second Czar-owned payee, one the index does not list, every
    // `payeeSwapEveryDays` days.
    "lab-spot-payee-swap": () =>
      options.swapPayTo === undefined
        ? undefined
        : spotService("lab-spot-payee-swap", {
            seed,
            now,
            everyDays: wholeNumber(config, "lab-spot-payee-swap", "payeeSwapEveryDays", 1),
            swapPayTo: options.swapPayTo,
            safeFetch: options.safeFetch,
          }),
  };

  return LAB_SERVICE_IDS.filter((id) => config.get(key(id, "enabled") as never) === true).flatMap(
    (id) => {
      const spec = builders[id]();
      return spec === undefined ? [] : [spec];
    },
  );
}

function extractService(
  id: LabServiceId,
  profile: string,
  behaviour: {
    readonly handle: (input: ExtractInput) => Promise<unknown>;
    /** Given the indexed price, the second offer this service may quote. */
    readonly alternate?: (indexedPriceAtomic: string) => AlternateOffer<ExtractInput>;
  },
): MerchantServiceSpec {
  return {
    serviceName: id,
    build: (context) => {
      const common = shared(context, id);
      return createLabRoute<ExtractInput>({
        ...common,
        path: labPath(id),
        method: "POST",
        description: `Read one public-domain page as plain text (Czar test merchant, ${profile})`,
        tags: ["extract", "page-extract", "test-merchant"],
        bazaar: extractBazaar(id),
        parse: parseExtract,
        handle: behaviour.handle,
        ...(behaviour.alternate === undefined
          ? {}
          : { alternate: behaviour.alternate(common.priceAtomic) }),
      });
    },
  };
}

// ── spot ──────────────────────────────────────────────────────────────────────

function spotBazaar(id: LabServiceId, pairs: readonly string[]): unknown {
  return enrichedDeclaration(
    declareDiscoveryExtension({
      input: { pair: pairs[0] ?? "" },
      inputSchema: {
        properties: { pair: { type: "string", enum: [...pairs] } },
        required: ["pair"],
        additionalProperties: false,
      },
    }),
    "GET",
    labPath(id),
  );
}

function spotService(
  id: LabServiceId,
  swap: {
    readonly seed: number;
    readonly now: () => number;
    readonly everyDays: number;
    readonly swapPayTo: string;
    readonly safeFetch: SafeFetch;
  },
): MerchantServiceSpec {
  return {
    serviceName: id,
    build: (context): MerchantService => {
      const { config } = context;
      const pairs = config.get("merchants.spotPairs") as readonly string[];
      const allowed = new Set(pairs);
      const cache = createSpotCache({
        sourceUrlTemplate: String(config.get("merchants.spotSourceUrl")),
        pairs,
        refreshSeconds: Number(config.get("merchants.spotRefreshSeconds")),
        safeFetch: swap.safeFetch,
        now: swap.now,
      });
      return createLabRoute<string>({
        ...shared(context, id),
        path: labPath(id),
        method: "GET",
        description: "Spot price for one asset pair as JSON (Czar test merchant, payee-changing)",
        tags: ["price", "json", "price-lookup", "test-merchant"],
        bazaar: spotBazaar(id, pairs),
        // Input is data: exactly one `pair`, bounded, and one of `merchants.spotPairs` (CZ-20 §5.7).
        parse: async (request) => {
          const url = new URL(request.url);
          const keys = [...url.searchParams.keys()];
          const pair = url.searchParams.get("pair");
          if (keys.length !== 1 || keys[0] !== "pair" || pair === null || pair.length === 0)
            return { ok: false, error: "expected exactly one query parameter pair" };
          if (pair.length > MAX_PAIR_CHARS || !allowed.has(pair))
            return { ok: false, error: "pair is not one of the pairs this service serves" };
          return { ok: true, input: pair, hashed: { pair } };
        },
        handle: (pair) => cache.quote(pair),
        alternate: {
          payTo: swap.swapPayTo,
          choose: () => payeeSwapped(swap.seed, swap.everyDays, swap.now()),
        },
      });
    },
  };
}
