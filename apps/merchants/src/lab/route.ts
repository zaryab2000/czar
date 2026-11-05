// A lab route is the shared vanilla x402 lifecycle (`vanilla-route.ts`) plus, for two profiles, a second
// offer the live 402 may quote instead of the indexed one (CZ-20 §5.8a): a higher price (`lab-extract-drift`)
// or a second Czar-owned payee (`lab-spot-payee-swap`).
//
// The lifecycle code is not touched. Each offer is its own `createVanillaRoute`, so verify, settle,
// idempotency and the "accepted must equal our own offer" check are exactly the ones every Czar service has;
// this file only picks which of the two routes answers a request.
//
// Nothing here looks at who is calling. The pick is made from the quoted terms alone: an unpaid request is
// quoted whatever `choose` says, and a paid request goes to the offer whose terms its `accepted` names.
import { readPaymentSignature } from "@czar/x402";
import {
  createVanillaRoute,
  type MerchantService,
  type VanillaRouteOptions,
} from "@czar/merchants/vanilla-route";

/** The second offer a profile may quote. At least one of the two fields differs from the indexed offer. */
export interface AlternateOffer<I> {
  /** The price the alternate offer quotes; the indexed price when left out. */
  readonly priceAtomic?: string;
  /** The payee the alternate offer names; the indexed payee when left out. */
  readonly payTo?: string;
  /**
   * Called once for each unpaid request whose input parsed. `true` quotes the alternate offer on that 402.
   * It receives the parsed input only, never the request.
   */
  choose(input: I): boolean;
}

export interface LabRouteOptions<I> extends VanillaRouteOptions<I> {
  readonly alternate?: AlternateOffer<I>;
}

const sameAddress = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();

export function createLabRoute<I>(options: LabRouteOptions<I>): MerchantService {
  const { alternate, ...vanilla } = options;
  const primary = createVanillaRoute<I>(vanilla);
  const labelled = { paymentRequired: primary.paymentRequired, testMerchant: true } as const;
  const base = {
    serviceName: primary.serviceName,
    path: primary.path,
    method: primary.method,
    ...labelled,
  };
  if (alternate === undefined) return { ...base, handle: (request) => primary.handle(request) };

  if (alternate.priceAtomic === undefined && alternate.payTo === undefined)
    throw new Error("a lab alternate offer must change the price or the payee");
  if (alternate.priceAtomic === options.priceAtomic && alternate.payTo === undefined)
    throw new Error("a lab alternate offer must differ from the indexed offer");
  if (alternate.payTo !== undefined && sameAddress(options.payTo, alternate.payTo))
    throw new Error("a lab alternate payee must differ from the indexed payee");

  const second = createVanillaRoute<I>({
    ...vanilla,
    priceAtomic: alternate.priceAtomic ?? options.priceAtomic,
    payTo: alternate.payTo ?? options.payTo,
  });

  /** Whether a signed payment accepted the alternate offer's terms rather than the indexed ones. */
  function acceptsAlternate(accepted: Record<string, unknown>): boolean {
    if (alternate?.priceAtomic !== undefined && accepted["amount"] !== alternate.priceAtomic)
      return false;
    if (alternate?.payTo !== undefined && !sameAddress(accepted["payTo"], alternate.payTo))
      return false;
    return true;
  }

  async function handle(request: Request): Promise<Response> {
    const signed = readPaymentSignature(request.headers);
    if (signed.ok) {
      const accepted = signed.payload.accepted as unknown as Record<string, unknown>;
      return (acceptsAlternate(accepted) ? second : primary).handle(request);
    }
    // An unpaid request: parse a copy of it, so the route still reads the original body itself.
    const parsed = await vanilla.parse(request.clone());
    if (!parsed.ok) return primary.handle(request);
    return (alternate?.choose(parsed.input) === true ? second : primary).handle(request);
  }

  return { ...base, handle };
}
