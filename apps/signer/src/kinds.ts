// Key ids, signing kinds and which key may use which kind (CZ-27 §4, §5.1).

export const KEY_IDS = [
  "K3",
  "K4",
  "K5",
  "K6",
  "K7",
  "K8",
  "K10",
  "K20",
  "K21a",
  "K21b",
  "relayer",
] as const;
export type KeyId = (typeof KEY_IDS)[number];

export const KINDS = [
  "vault-call",
  "usdc-3009",
  "gateway-burn",
  "sl-receipt",
  "autonomy-raise",
  "evaluator-call",
  "sl-validation-report",
  "oel-commit",
  "merchant-seller-proof",
  "relayer-tx",
  "gas-refill",
  "gateway-nano",
  "pocket-delegate",
  "pocket-return",
  "pocket-slow-withdraw",
  "provider-call",
] as const;
export type Kind = (typeof KINDS)[number];

/** The CZ-20 §5.11 test-provider keys (H7, N12): `provider-call` only, testnet only, never a vault role. */
export const PROVIDER_KEY_IDS = ["K21a", "K21b"] as const;
export type ProviderKeyId = (typeof PROVIDER_KEY_IDS)[number];

/** Allowed kinds per key (CZ-27 §5.1). K6 and K20 sign only through the interactive CLI (D80). */
export const KEY_KINDS: Readonly<Record<KeyId, readonly Kind[]>> = {
  K3: ["vault-call", "usdc-3009", "gateway-burn", "sl-receipt"],
  K4: ["gateway-nano", "pocket-delegate", "pocket-return", "pocket-slow-withdraw"],
  K5: ["autonomy-raise"],
  K6: [],
  K7: ["evaluator-call", "sl-validation-report"],
  K8: ["oel-commit"],
  K10: ["merchant-seller-proof"],
  K20: [],
  K21a: ["provider-call"],
  K21b: ["provider-call"],
  relayer: ["relayer-tx", "gas-refill"],
};

/**
 * Kinds whose result is a signed transaction rather than a 65-byte signature. `provider-call` is not listed: its
 * `setBudget`/`submit` actions are transactions and its `brief-request`/`deliverable-upload` actions are
 * digests, and no key that holds it is in `NEVER_SENDS`.
 */
export const TRANSACTION_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  "vault-call",
  "evaluator-call",
  "oel-commit",
  "relayer-tx",
  "gas-refill",
  "pocket-delegate",
  "pocket-return",
  "pocket-slow-withdraw",
]);

/** Keys that never send a transaction (K5: raises are relayed, RV-017). */
export const NEVER_SENDS: ReadonlySet<KeyId> = new Set<KeyId>(["K5", "K10"]);

/** Keys whose requests need an interactive confirmation in Phase 1 (D80). */
export const INTERACTIVE_KEYS: ReadonlySet<KeyId> = new Set<KeyId>(["K6", "K20"]);
