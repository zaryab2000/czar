// The fixed index behind `czar-search` (CZ-20 §5.1): Czar controls it, so results are deterministic and
// the Phase 1 acceptance scenario is repeatable. Entries point at public documentation pages.

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export const MAX_RESULTS = 10;

export const SEARCH_INDEX: readonly SearchResult[] = [
  {
    title: "x402 protocol specification",
    url: "https://github.com/coinbase/x402",
    snippet: "HTTP 402 payments: PAYMENT-REQUIRED, PAYMENT-SIGNATURE and PAYMENT-RESPONSE headers.",
  },
  {
    title: "EIP-3009: Transfer With Authorization",
    url: "https://eips.ethereum.org/EIPS/eip-3009",
    snippet: "Gasless USDC transfers authorized by an EIP-712 signature with a single-use nonce.",
  },
  {
    title: "EIP-712: Typed structured data hashing and signing",
    url: "https://eips.ethereum.org/EIPS/eip-712",
    snippet: "Domain separators and struct hashes for signing typed data.",
  },
  {
    title: "ERC-1271: Standard signature validation for contracts",
    url: "https://eips.ethereum.org/EIPS/eip-1271",
    snippet: "isValidSignature lets a smart contract account approve a digest.",
  },
  {
    title: "Arc network documentation",
    url: "https://docs.arc.network",
    snippet: "Arc is a layer-1 chain where USDC is the native gas token.",
  },
  {
    title: "Circle Gateway documentation",
    url: "https://developers.circle.com/gateway",
    snippet: "Unified USDC balances, burn intents and nanopayments through Gateway.",
  },
  {
    title: "RFC 8785: JSON Canonicalization Scheme",
    url: "https://www.rfc-editor.org/rfc/rfc8785",
    snippet: "Deterministic JSON serialization for hashing and signing.",
  },
  {
    title: "ERC-8183: Agentic commerce job escrow",
    url: "https://eips.ethereum.org/EIPS/eip-8183",
    snippet: "Jobs with a client, a provider and an evaluator who completes or rejects delivery.",
  },
];

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);

/** Every query word must appear in the title or snippet; index order is the ranking. */
export function search(q: string): { results: SearchResult[] } {
  const wanted = words(q);
  if (wanted.length === 0) return { results: [] };
  const results = SEARCH_INDEX.filter((entry) => {
    const have = new Set(words(`${entry.title} ${entry.snippet}`));
    return wanted.every((word) => have.has(word));
  }).slice(0, MAX_RESULTS);
  return { results };
}
