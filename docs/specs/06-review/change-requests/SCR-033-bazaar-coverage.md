# SCR-033: How many real 402s declare `extensions.bazaar`

| Field | Value |
|---|---|
| ID | SCR-033 |
| Filed by | Architect (Claude), 2026-10-20, from D91 items 1 and 4 |
| Spec and section | `docs/specs/04-components/server/server-acceptance-evidence-selection.md` CZ-18 §5.3b; `docs/specs/02-data-and-protocol/data-and-protocol.md` §4.27, §15.3 |
| Status | Open (research). Does not block T-115; it sets how useful mainnet cards will be. |

## Problem
- D91 builds capability cards from the seller's own 402. Cards are rich only when the 402 carries `extensions.bazaar` (input and output schema, A3-35). How many live sellers do that is unknown.
- Without the number, the match set (T-117) may be built on cards that hold only a price and a URL.

## Evidence
- A3-35 defines `extensions.bazaar`; A3-37 and F4-02 say Circle's items use a non-spec `metadata` object; p1-D6 counts 2,195 mainnet and 134 testnet listings.

## Proposed change
- Measure, with Czar's unpaid probe rules (CZ-18 §5.3a: no payment header, polite budget), the share of Arc mainnet and testnet listings whose 402 carries a valid `extensions.bazaar`, `outputSchema` or equivalent, by category; record the fact in ground truth with date and method.
- If coverage is low, add a fallback card source in a follow-up SCR (for example a signed seller registration) rather than reading Circle's `metadata`.

## Affected tasks
- T-115 (card fill rate), T-117 (match set).

## Decision
- Pending.
