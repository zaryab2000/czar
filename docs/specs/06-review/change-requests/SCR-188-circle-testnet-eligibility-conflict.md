# SCR-188: Circle testnet eligibility conflicts with the named paid acceptance case

| Field | Value |
|---|---|
| ID | SCR-188 |
| Filed by | GPT orchestrator, 2026-11-05 |
| Spec and section | `docs/specs/06-review/change-requests/SCR-187-circle-registry-discovery-and-gateway.md` §§4.6–4.7, 8, 13 test 12, 14; `docs/tracker/demo-v1-tracker.md` C11/CD-07 and DD-07 |
| Status | Accepted |

## Problem

- SCR-187 §13 test 12 requires an end-to-end paid call to Quicknode `arc-testnet`, but §§4.6 and 4.7 reject its SIWX and session requirements, and §8 P0 rejects its multi-field input schema. The builder cannot satisfy both without a new authentication and input contract.
- In the current Arc testnet registry snapshot, no listing passes the combined §4.6 and §8 P0 gates. Thus discovery can be implemented and tested, but CD-07 cannot use a currently eligible Circle merchant.

## Evidence

- On 2026-11-05, a read-only server `safeFetch` of Circle discovery with `network=eip155:5042002`, `type=http`, `scheme=exact`, Arc USDC, and `limit=200` returned 134 listings. All 134 fit the payment network and the 1,000,000-atomic default price cap. Of these, 132 declare `metadata.siwx=true`; none has exactly one required string input property; zero pass both current gates. This is a time-bound registry observation, not a claim about future listings.
- The Quicknode `https://x402.quicknode.com/arc-testnet/` listing is `POST`, amount 100 atomic, declares SIWX, and requires `jsonrpc` and `method`. Its live 402 also declares `sign-in-with-x` and `quicknode-session` (SCR-187 §2.2). SCR-187 §4.7 explicitly rejects these extensions.
- BotPay `https://api.botpay.network/go` is `GET`, amount 100000 atomic, has no SIWX declaration but no required query property. It fails the exactly-one-required-string P0 input rule in §8.

## Proposed change

**Recommended: keep the fail-closed eligibility and probe rules.** Replace SCR-187 §13 test 12 and the CD-07 completion rule with: “A paid Circle-listing end-to-end check is pending until at least one Arc testnet listing passes §§4.6–4.7 and §8, or an accepted SCR adds the specific SIWX/session and input support needed for a named listing. Do not bypass those gates for a demo. Validate the Gateway pocket payment and sweep against an eligible Czar merchant after the CD-02 live checks and Zaryab's funds approval. Record the Circle paid check as an open C11 gate rather than a pass.”

An alternative is to make Quicknode support P0 by specifying the SIWX/session exchange and a bounded JSON-RPC input template in a separate money and security review. That is a larger implementation and cannot be inferred from the listing.

The architect should also decide whether the Circle paid check remains a Demo v1 P0 blocker or becomes a later gate while registry discovery and Gateway for eligible merchants ship.

## Affected tasks

- CD-05, CD-06, CD-07; DD-07 acceptance; no change to CD-02's pocket return requirement.

## Decision

- **Accepted by Zaryab, 2026-11-05.** Keep the fail-closed eligibility and probe gates.
  Use an eligible Czar merchant for the Gateway pocket and sweep proof. Defer the paid
  Circle-listing check until a compatible listing exists or a separate accepted SCR
  specifies the required SIWX, session and input support. The deferred Circle payment
  is not a Demo v1 P0 completion gate. Discovery may return zero eligible Circle
  candidates on the observed Arc testnet catalog; report that result truthfully.
