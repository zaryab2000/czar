# 14 — `@czar/vault-client`

## 1. Scope
- **Task:** T-026, `packages/vault-client/`. Its job is to let the server, signer and app talk to the vault and factory.
- **What the package provides:**
  - typed contract handles
  - the four signature-envelope encoders: `USDC_3009`, `GATEWAY_BURN`, `SL_RECEIPT` v2 and the 65-byte fallback
  - revert decoding to custom-error names
  - P-256 low-s normalisation for `executeOwnerAction` (RV-034)
  - the 20 Gwei fee floor (p1-A6)
- **No contract changes.** The package reads the ABI from the compiled interfaces, which are byte-identical to the spec copies.
- **Dependencies:**
  - PRD 13 is done: the integration test deploys with `contracts/script/deploy.sh`.
  - T-007 `@czar/hashing` exists; it is reused for every digest, nonce and Merkle tree. The vault client never re-implements a hash.
  - The workspace from T-001 (pnpm 10.28.0, TypeScript 6.0.3, vitest 5.0.5, oxlint, oxfmt) is in place.

## 2. This PRD is already verified
- **Built in a copy of the repository** with PRDs 01–13 applied:
  - `pnpm --filter @czar/vault-client test`: 5 files, 80 tests passed. This includes the `arc-anvil` integration test, which takes about 15 seconds.
  - `tsc` was clean, and so were `oxlint --deny-warnings` and `oxfmt --check`.
- **What the integration test proved:**
  - It deployed the real contracts with `deploy.sh` on `arc-anvil --network arc --chain-id 5042002`.
  - A `USDC_3009` envelope from the encoder moved `unitAmount` to the payee through Arc's native USDC (`transferWithAuthorization` bytes overload), and the vault then settled that index.
  - It called all 62 `ICzarVault` functions once as a stranger:
    - 32 succeeded (the views and `sync`).
    - 30 reverted, and every one decoded to a named custom error, for example `withdraw` → `NotOwner`, `reserve` → `NotAgent`, `freeze` → `NotAuthorized`, `executeOwnerAction` → `PasskeyNotSet`.

## 3. Sources (read these, nothing else)
- `docs/specs/05-build-plan/phase-1-tasks.md` T-026.
- `docs/specs/04-components/cross-cutting.md`:
  - §2 (`@czar/vault-client` guarantee)
  - §3.1 (local environment: `arc-anvil --network arc --chain-id 5042002`)
  - §7 (pinned versions)
- `docs/specs/02-data-and-protocol/data-and-protocol.md` §6.3 (the four envelopes).
- `docs/specs/03-smart-contracts/czar-vault.md`:
  - §6 (layout table, never-revert rules)
  - §9.2 (errors)
  - §15.1 (callers)
- `docs/specs/03-smart-contracts/interfaces/ICzarVault.sol`, `ICzarVaultFactory.sol`.
- `packages/hashing/src/` (the functions you import: `KIND_TAGS`, `SlReceipt`, `derivedNonce`, `usdcTransferWithAuthorizationDigest`, `payeeLeaf`, `buildTree`, `PAYEE_KIND`).

## 4. Files
| File | Action | Section |
|---|---|---|
| `packages/vault-client/.gitkeep` | delete | — |
| `packages/vault-client/package.json` | create | §5 |
| `packages/vault-client/tsconfig.json` | create | §5 |
| `packages/vault-client/vitest.config.ts` | create | §5 |
| `packages/vault-client/scripts/gen-abi.ts` | create | §6 |
| `packages/vault-client/src/abi.ts` | generate | §6 |
| `packages/vault-client/src/encoders.ts` | create | §7 |
| `packages/vault-client/src/errors.ts` | create | §7 |
| `packages/vault-client/src/webauthn.ts` | create | §7 |
| `packages/vault-client/src/fees.ts` | create | §7 |
| `packages/vault-client/src/client.ts` | create | §7 |
| `packages/vault-client/src/index.ts` | create | §7 |
| `packages/vault-client/test/*.test.ts` (4 files) | create | §8 |
| `packages/vault-client/test/integration/anvil.test.ts` | create | §9 |
| `pnpm-lock.yaml` | updated by `pnpm install` | §5 |
| `.gitignore` (root) | add one line | §9 |

## 5. Package setup
- `viem` is pinned to `2.57.7`, the same version `@czar/hashing` uses.
```json
{
  "name": "@czar/vault-client",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "gen-abi": "node scripts/gen-abi.ts",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@czar/hashing": "workspace:*",
    "viem": "2.57.7"
  }
}
```
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test", "scripts"]
}
```
```ts
import { defineConfig } from "vitest/config";

// The arc-anvil integration test deploys the contracts and needs minutes, not the default 5 s (07 PRD 14 §9).
const INTEGRATION_TIMEOUT_MS = 600_000;

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: INTEGRATION_TIMEOUT_MS,
    hookTimeout: INTEGRATION_TIMEOUT_MS,
  },
});
```
- Run `pnpm install` from the repository root. The lockfile gains exactly one importer, `packages/vault-client`, with `@czar/hashing` (`link:../hashing`) and `viem` 2.57.7.

## 6. The ABI
- `scripts/gen-abi.ts` writes `src/abi.ts` from `contracts/out` with `as const`, so viem types every call and argument.
- **Run order:**
  1. `cd contracts && FOUNDRY_PROFILE=arc arc-forge build`.
  2. `pnpm --filter @czar/vault-client gen-abi`.
  3. `pnpm exec oxfmt packages/vault-client/src/abi.ts`.
- `test/abi.test.ts` fails when `abi.ts` no longer equals the compiled interfaces, for example when an SCR changed an interface and nobody regenerated it.
- **Expected content:** `czarVaultAbi` holds 55 errors and `czarVaultFactoryAbi` 6 (61 in total). Commit the generated file.
```ts
// T-026 (07 PRD 14 §5): writes src/abi.ts from the compiled interfaces in contracts/out. Run after
// `FOUNDRY_PROFILE=arc arc-forge build` in contracts/. The interfaces are byte-identical to
// docs/specs/03-smart-contracts/interfaces (00-conventions §2.3), so this ABI is the spec's ABI.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = new URL("../../../contracts/out/", import.meta.url);
const TARGET = fileURLToPath(new URL("../src/abi.ts", import.meta.url));

const abiOf = (name: string): unknown => {
  const artifact = JSON.parse(readFileSync(new URL(`${name}.sol/${name}.json`, OUT), "utf8")) as {
    abi: unknown;
  };
  return artifact.abi;
};

const body = [
  "// Generated by scripts/gen-abi.ts from contracts/out (T-026). Do not edit; run `pnpm gen-abi`.",
  `export const czarVaultAbi = ${JSON.stringify(abiOf("ICzarVault"), null, 2)} as const;`,
  "",
  `export const czarVaultFactoryAbi = ${JSON.stringify(abiOf("ICzarVaultFactory"), null, 2)} as const;`,
  "",
].join("\n");
writeFileSync(TARGET, body);
process.stdout.write(`wrote ${TARGET}; run \`pnpm exec oxfmt src/abi.ts\` next\n`);
```

## 7. Sources of the package

### 7.1 `src/encoders.ts`
- **Every encoder checks the agent signature first:** 65 bytes, low s, and `v` of 27 or 28. These are the vault's `_agentSigned` rules, so a bad signature fails here and not on chain.
- **Every encoder then checks its own length:**
  - `USDC_3009` and `GATEWAY_BURN` must be exactly the §6 table length.
  - `SL_RECEIPT` must be `672 + 32 × ⌈L / 32⌉`, with `L` measured in UTF-8 bytes.
```ts
// T-026: the signature envelopes the vault's isValidSignature reads (02 §6.3; 03 czar-vault.md §6 layout table).
import { KIND_TAGS, type SlReceipt } from "@czar/hashing";
import { encodeAbiParameters, hexToBigInt, size, slice, type Hex } from "viem";

export type Address = `0x${string}`;
export type Hash32 = `0x${string}`;

/** r ‖ s ‖ v (02 §6.3.1). */
export const AGENT_SIG_BYTES = 65;
/** 9 head words + the bytes tail (32 length + 65 padded to 96) (czar-vault.md §6). */
export const USDC_3009_BYTES = 416;
/** 3 head words + the bytes tail (czar-vault.md §6). */
export const GATEWAY_BURN_BYTES = 224;
/** The fixed part of an SL_RECEIPT envelope; the originAsserted string adds 32 × ⌈L / 32⌉ (czar-vault.md §6). */
export const SL_RECEIPT_FIXED_BYTES = 672;
const WORD_BYTES = 32;
/** secp256k1 n / 2: signatures with a larger s are refused by the vault and by USDC (A1-09). */
export const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const V_LOW = 27;
const V_HIGH = 28;

export class EncodingError extends Error {
  override readonly name = "EncodingError";
}

/** Checks the 65-byte agent signature the vault accepts: length, low s, v ∈ {27, 28} (czar-vault.md §6 `_agentSigned`). */
export function assertAgentSig(sig: Hex): void {
  if (size(sig) !== AGENT_SIG_BYTES)
    throw new EncodingError(`agentSig must be ${AGENT_SIG_BYTES} bytes`);
  const s = hexToBigInt(slice(sig, WORD_BYTES, 2 * WORD_BYTES));
  if (s > SECP256K1_HALF_N) throw new EncodingError("agentSig has a high s");
  const v = Number(hexToBigInt(slice(sig, 2 * WORD_BYTES, AGENT_SIG_BYTES)));
  if (v !== V_LOW && v !== V_HIGH) throw new EncodingError("agentSig v must be 27 or 28");
}

export interface Usdc3009Envelope {
  readonly reservationId: bigint;
  readonly index: number;
  readonly to: Address;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: Hash32;
  readonly agentSig: Hex;
}

/** 02 §6.3.1: the primary encoding Circle's relayer passes to USDC's bytes overload (A1-18). Always 416 bytes. */
export function encodeUsdc3009Signature(e: Usdc3009Envelope): Hex {
  assertAgentSig(e.agentSig);
  const out = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint64" },
      { type: "uint32" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes" },
    ],
    [
      KIND_TAGS.USDC_3009,
      e.reservationId,
      e.index,
      e.to,
      e.value,
      e.validAfter,
      e.validBefore,
      e.nonce,
      e.agentSig,
    ],
  );
  if (size(out) !== USDC_3009_BYTES) throw new EncodingError("USDC_3009 envelope length");
  return out;
}

/** 02 §6.3.2: the burn-intent envelope Circle's TEE checks through eth_call. Always 224 bytes. */
export function encodeGatewayBurnSignature(pullbackId: bigint, agentSig: Hex): Hex {
  assertAgentSig(agentSig);
  const out = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes" }],
    [KIND_TAGS.GATEWAY_BURN, pullbackId, agentSig],
  );
  if (size(out) !== GATEWAY_BURN_BYTES) throw new EncodingError("GATEWAY_BURN envelope length");
  return out;
}

/** The SL Receipt tuple in type-string order (02 §6.3.3). */
const SL_RECEIPT_TUPLE = {
  type: "tuple",
  components: [
    { name: "paymentRefHash", type: "bytes32" },
    { name: "requestCommit", type: "bytes32" },
    { name: "responseCommit", type: "bytes32" },
    { name: "statusCode", type: "uint16" },
    { name: "originAsserted", type: "string" },
    { name: "requirementsHashSeen", type: "bytes32" },
    { name: "tRequest", type: "uint64" },
    { name: "tPaymentSigned", type: "uint64" },
    { name: "tComplete", type: "uint64" },
    { name: "outcome", type: "uint8" },
    { name: "localChecksCommit", type: "bytes32" },
    { name: "disclosure", type: "uint8" },
    { name: "createdAt", type: "uint64" },
  ],
} as const;

/** Expected SL_RECEIPT length for an originAsserted of `utf8Bytes` bytes (czar-vault.md §6). */
export const slReceiptLength = (utf8Bytes: number): number =>
  SL_RECEIPT_FIXED_BYTES + WORD_BYTES * Math.ceil(utf8Bytes / WORD_BYTES);

/** 02 §6.3.3 (v2, RV-013): the receipt fields plus the agent's ReceiptAttestation signature. */
export function encodeSlReceiptSignature(receipt: SlReceipt, agentSig: Hex): Hex {
  assertAgentSig(agentSig);
  const out = encodeAbiParameters(
    [{ type: "bytes32" }, SL_RECEIPT_TUPLE, { type: "bytes" }],
    [KIND_TAGS.SL_RECEIPT, receipt, agentSig],
  );
  const expected = slReceiptLength(new TextEncoder().encode(receipt.originAsserted).length);
  if (size(out) !== expected) throw new EncodingError("SL_RECEIPT envelope length");
  return out;
}

/** 02 §6.3.4: the 65-byte fallback for digest-mode reservations is the agent signature itself. */
export function encodeFallbackSignature(agentSig: Hex): Hex {
  assertAgentSig(agentSig);
  return agentSig;
}
```

### 7.2 `src/errors.ts`
- `decodeRevert` never throws.
- **Order of decoding:**
  - `Error(string)` and `Panic(uint256)` are checked by selector first, because viem would otherwise decode them as "custom".
  - Next comes the combined vault and factory error ABI.
  - Anything else is `Unknown`.
- `decodeViemError` finds the revert data inside the error viem throws from `simulateContract`, `readContract` or `writeContract`.
```ts
// T-026: revert data decoded to the custom-error names of ICzarVault and ICzarVaultFactory (03 czar-vault.md §9.2).
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Hex } from "viem";
import { czarVaultAbi, czarVaultFactoryAbi } from "./abi.ts";

/** The vault and the factory share no selector, so one combined ABI decodes both. */
const ERRORS_ABI = [...czarVaultAbi, ...czarVaultFactoryAbi].filter(
  (item) => item.type === "error",
);

export type DecodedRevert =
  | { readonly kind: "custom"; readonly name: string; readonly args: readonly unknown[] }
  | { readonly kind: "string"; readonly name: "Error"; readonly message: string }
  | { readonly kind: "panic"; readonly name: "Panic"; readonly code: bigint }
  | { readonly kind: "empty"; readonly name: "EmptyRevert" }
  | { readonly kind: "unknown"; readonly name: "Unknown"; readonly data: Hex };

const ERROR_STRING_SELECTOR = "0x08c379a0";
const PANIC_SELECTOR = "0x4e487b71";
const SELECTOR_HEX_CHARS = 10;

/** Decodes raw revert data. Never throws: data that matches nothing comes back as `Unknown`. */
export function decodeRevert(data: Hex | undefined): DecodedRevert {
  if (data === undefined || data === "0x") return { kind: "empty", name: "EmptyRevert" };
  const selector = data.slice(0, SELECTOR_HEX_CHARS).toLowerCase();
  // viem also knows Error(string) and Panic(uint256); check those selectors first so they keep their own kinds.
  if (selector !== ERROR_STRING_SELECTOR && selector !== PANIC_SELECTOR) {
    try {
      const r = decodeErrorResult({ abi: ERRORS_ABI, data });
      return { kind: "custom", name: r.errorName, args: r.args ?? [] };
    } catch {
      return { kind: "unknown", name: "Unknown", data };
    }
  }
  try {
    if (selector === ERROR_STRING_SELECTOR) {
      const r = decodeErrorResult({ data });
      return { kind: "string", name: "Error", message: String(r.args?.[0] ?? "") };
    }
    if (selector === PANIC_SELECTOR) {
      const r = decodeErrorResult({ data });
      return { kind: "panic", name: "Panic", code: BigInt(r.args?.[0] as bigint) };
    }
  } catch {
    // malformed built-in error
  }
  return { kind: "unknown", name: "Unknown", data };
}

/** Finds the revert data inside an error viem threw (simulate, call or write) and decodes it. */
export function decodeViemError(error: unknown): DecodedRevert | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) {
    if (reverted.raw !== undefined) return decodeRevert(reverted.raw);
  }
  const withData = error.walk((e) => typeof (e as { data?: unknown }).data === "string") as {
    data?: Hex;
  } | null;
  if (withData?.data !== undefined) return decodeRevert(withData.data);
  return undefined;
}

/** The names of every custom error the client decodes (vault and factory). */
export const errorNames = (): readonly string[] => ERRORS_ABI.map((e) => e.name);
```

### 7.3 `src/webauthn.ts`
```ts
// T-026: WebAuthn assertion helpers for executeOwnerAction (D30; RV-034 low-s normalisation).
import { hexToBigInt, numberToHex, type Hex } from "viem";

/** The order of the P-256 group (NIST SP 800-186). */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const HALF_N = P256_N / 2n;
const WORD_BYTES = 32;

/** The struct `executeOwnerAction` takes (ICzarVault.WebAuthnAuth; OpenZeppelin v5.7.0 WebAuthn.WebAuthnAuth). */
export interface WebAuthnAuth {
  readonly r: Hex;
  readonly s: Hex;
  readonly challengeIndex: bigint;
  readonly typeIndex: bigint;
  readonly authenticatorData: Hex;
  readonly clientDataJSON: string;
}

/**
 * Browsers return either s; OpenZeppelin's P256 verifier refuses s > n/2 (RV-034). Returns `n − s` for a high s and
 * the same s otherwise. Both values verify the same message, so normalising never changes what was signed.
 */
export function normaliseP256S(s: Hex): Hex {
  const value = hexToBigInt(s);
  if (value === 0n || value >= P256_N) throw new Error("P-256 s out of range");
  return numberToHex(value > HALF_N ? P256_N - value : value, { size: WORD_BYTES });
}

/** Returns the assertion with a low s, ready for executeOwnerAction. */
export const withLowS = (a: WebAuthnAuth): WebAuthnAuth => ({ ...a, s: normaliseP256S(a.s) });
```

### 7.4 `src/fees.ts`
```ts
// T-026: the gas price floor every Czar transaction on Arc uses (p1-A6: maxFeePerGas ≥ 20 Gwei).
import { parseGwei } from "viem";

export const MIN_MAX_FEE_PER_GAS = parseGwei("20");

/** Raises `maxFeePerGas` (and caps `maxPriorityFeePerGas` at it) so a transaction never goes out below the floor. */
export function withFeeFloor<T extends { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }>(
  fees: T,
): T {
  const maxFeePerGas =
    fees.maxFeePerGas === undefined || fees.maxFeePerGas < MIN_MAX_FEE_PER_GAS
      ? MIN_MAX_FEE_PER_GAS
      : fees.maxFeePerGas;
  const priority = fees.maxPriorityFeePerGas;
  return {
    ...fees,
    maxFeePerGas,
    ...(priority === undefined
      ? {}
      : { maxPriorityFeePerGas: priority > maxFeePerGas ? maxFeePerGas : priority }),
  };
}
```

### 7.5 `src/client.ts` and `src/index.ts`
```ts
// T-026: typed contract handles over the compiled interfaces (viem 2.57.x). Every call and its arguments are typed
// from the ABI, so a renamed function or a wrong argument fails at compile time.
import { getContract, type Address, type Client } from "viem";
import { czarVaultAbi, czarVaultFactoryAbi } from "./abi.ts";

export const getVault = (address: Address, client: Client | { public: Client; wallet?: Client }) =>
  getContract({ address, abi: czarVaultAbi, client });

export const getVaultFactory = (
  address: Address,
  client: Client | { public: Client; wallet?: Client },
) => getContract({ address, abi: czarVaultFactoryAbi, client });
```
```ts
export * from "./abi.ts";
export * from "./client.ts";
export * from "./encoders.ts";
export * from "./errors.ts";
export * from "./fees.ts";
export * from "./webauthn.ts";
```

## 8. Unit tests
- **`encoders.test.ts`:**
  - the §6 offsets and lengths of each envelope, and a decode round trip
  - `SL_RECEIPT` at `L` = 0, 1, 24, 31, 32, 33 and 256 (the lengths czar-vault.md §6 lists)
  - refusal of a wrong length, a high s and a bad v
- **`errors.test.ts`:** all 61 custom errors decode by name; `Error(string)`, `Panic`, empty data and unknown data each get their own kind.
- **`webauthn-fees.test.ts`:**
  - low-s normalisation, including the `n/2` boundary and out-of-range values
  - the fee floor
- **`abi.test.ts`:** the generated ABI equals the compiled interfaces (§6).
- **Keys in the tests are generated in memory with `generatePrivateKey()`** for each run and never printed or written. No private key appears in any file (CLAUDE.md).
```ts
// T-026 (07 PRD 14 §7): every encoder output matches the czar-vault.md §6 layout table.
import { KIND_TAGS, type SlReceipt } from "@czar/hashing";
import { concat, decodeAbiParameters, hexToBigInt, numberToHex, size, slice, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  encodeFallbackSignature,
  encodeGatewayBurnSignature,
  encodeSlReceiptSignature,
  encodeUsdc3009Signature,
  EncodingError,
  GATEWAY_BURN_BYTES,
  SECP256K1_HALF_N,
  slReceiptLength,
  USDC_3009_BYTES,
} from "@czar/vault-client";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const word = (sig: Hex, i: number): bigint => hexToBigInt(slice(sig, 32 * i, 32 * (i + 1)));
const account = privateKeyToAccount(generatePrivateKey()); // ephemeral, never printed
const agentSig = async (): Promise<Hex> => account.sign({ hash: `0x${"11".repeat(32)}` });

const receipt = (originAsserted: string): SlReceipt => ({
  paymentRefHash: `0x${"01".repeat(32)}`,
  requestCommit: `0x${"02".repeat(32)}`,
  responseCommit: `0x${"03".repeat(32)}`,
  statusCode: 200,
  originAsserted,
  requirementsHashSeen: `0x${"04".repeat(32)}`,
  tRequest: 1n,
  tPaymentSigned: 2n,
  tComplete: 3n,
  outcome: 1,
  localChecksCommit: `0x${"05".repeat(32)}`,
  disclosure: 0,
  createdAt: 4n,
});

describe("USDC_3009 (02 §6.3.1)", () => {
  it("is 416 bytes with the §6 offsets and decodes back to its fields", async () => {
    const sig = await agentSig();
    const out = encodeUsdc3009Signature({
      reservationId: 7n,
      index: 3,
      to: "0x000000000000000000000000000000000000bEEF",
      value: 1_000n,
      validAfter: 0n,
      validBefore: 1_792_000_300n,
      nonce: `0x${"ab".repeat(32)}`,
      agentSig: sig,
    });
    expect(size(out)).toBe(USDC_3009_BYTES);
    expect(slice(out, 0, 32)).toBe(KIND_TAGS.USDC_3009);
    expect(word(out, 8)).toBe(0x120n); // offset of agentSig
    expect(word(out, 9)).toBe(65n); // its length
    const d = decodeAbiParameters(
      [
        "bytes32",
        "uint64",
        "uint32",
        "address",
        "uint256",
        "uint256",
        "uint256",
        "bytes32",
        "bytes",
      ].map((type) => ({ type })),
      out,
    );
    expect(d[1]).toBe(7n);
    expect(d[2]).toBe(3);
    expect(d[8]).toBe(sig);
  });
});

describe("GATEWAY_BURN (02 §6.3.2)", () => {
  it("is 224 bytes with offset 0x60 and length 65", async () => {
    const out = encodeGatewayBurnSignature(5n, await agentSig());
    expect(size(out)).toBe(GATEWAY_BURN_BYTES);
    expect(slice(out, 0, 32)).toBe(KIND_TAGS.GATEWAY_BURN);
    expect(word(out, 1)).toBe(5n);
    expect(word(out, 2)).toBe(0x60n);
    expect(word(out, 3)).toBe(65n);
  });
});

describe("SL_RECEIPT v2 (02 §6.3.3)", () => {
  // The lengths czar-vault.md §6 checked with viem: L = 0, 1, 24, 31, 32, 33 and 256.
  for (const length of [0, 1, 24, 31, 32, 33, 256]) {
    it(`is 672 + 32 × ⌈${length} / 32⌉ bytes with the tuple offsets`, async () => {
      const out = encodeSlReceiptSignature(receipt("a".repeat(length)), await agentSig());
      expect(size(out)).toBe(slReceiptLength(length));
      expect(slice(out, 0, 32)).toBe(KIND_TAGS.SL_RECEIPT);
      expect(word(out, 1)).toBe(0x60n); // offset of the receipt tuple
      expect(hexToBigInt(slice(out, 0x60 + 32 * 4, 0x60 + 32 * 5))).toBe(0x1a0n); // originAsserted offset in the tuple
      expect(hexToBigInt(slice(out, 0x200, 0x220))).toBe(BigInt(length)); // the string's length word
    });
  }
});

describe("fallback (02 §6.3.4) and the agent-signature checks", () => {
  it("passes a valid 65-byte signature through unchanged", async () => {
    const sig = await agentSig();
    expect(encodeFallbackSignature(sig)).toBe(sig);
  });

  it("refuses a wrong length, a high s and a bad v", async () => {
    const sig = await agentSig();
    expect(() => encodeFallbackSignature(slice(sig, 0, 64))).toThrow(EncodingError);
    const s = hexToBigInt(slice(sig, 32, 64));
    const highS = numberToHex(SECP256K1_N - s, { size: 32 });
    expect(SECP256K1_N - s > SECP256K1_HALF_N).toBe(true);
    expect(() =>
      encodeFallbackSignature(concat([slice(sig, 0, 32), highS, slice(sig, 64, 65)])),
    ).toThrow("high s");
    expect(() => encodeFallbackSignature(concat([slice(sig, 0, 64), "0x01"]))).toThrow("27 or 28");
  });
});
```
```ts
// T-026 (07 PRD 14 §7): every custom error of the vault and the factory decodes by name.
import { encodeErrorResult, zeroAddress, type AbiParameter } from "viem";
import { describe, expect, it } from "vitest";
import { czarVaultAbi, czarVaultFactoryAbi, decodeRevert, errorNames } from "@czar/vault-client";

const VAULT_ERRORS = 55;
const FACTORY_ERRORS = 6;

/** A value of the right type for any error argument. */
function sample(p: AbiParameter): unknown {
  if (p.type === "address") return zeroAddress;
  if (p.type === "bool") return true;
  if (p.type === "string") return "x";
  if (p.type.startsWith("bytes") && p.type !== "bytes")
    return `0x${"00".repeat(Number(p.type.slice(5)))}`;
  if (p.type === "bytes") return "0x";
  if (p.type.startsWith("uint") || p.type.startsWith("int")) return 1n;
  throw new Error(`no sample for ${p.type}`);
}

describe("decodeRevert", () => {
  const errors = [...czarVaultAbi, ...czarVaultFactoryAbi].filter((i) => i.type === "error");

  it("knows 55 vault errors and 6 factory errors", () => {
    expect(czarVaultAbi.filter((i) => i.type === "error")).toHaveLength(VAULT_ERRORS);
    expect(czarVaultFactoryAbi.filter((i) => i.type === "error")).toHaveLength(FACTORY_ERRORS);
    expect(errorNames()).toHaveLength(VAULT_ERRORS + FACTORY_ERRORS);
  });

  for (const e of errors) {
    it(`decodes ${e.name}`, () => {
      const args = e.inputs.map(sample);
      const data = encodeErrorResult({ abi: [e], errorName: e.name, args } as never);
      const d = decodeRevert(data);
      expect(d.kind).toBe("custom");
      expect(d.name).toBe(e.name);
    });
  }

  it("decodes Error(string), Panic, empty and unknown data", () => {
    expect(
      decodeRevert(
        encodeErrorResult({
          abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }],
          errorName: "Error",
          args: ["boom"],
        }),
      ),
    ).toEqual({ kind: "string", name: "Error", message: "boom" });
    expect(
      decodeRevert(
        encodeErrorResult({
          abi: [{ type: "error", name: "Panic", inputs: [{ type: "uint256" }] }],
          errorName: "Panic",
          args: [0x11n],
        }),
      ),
    ).toEqual({ kind: "panic", name: "Panic", code: 0x11n });
    expect(decodeRevert("0x")).toEqual({ kind: "empty", name: "EmptyRevert" });
    expect(decodeRevert("0xdeadbeef").name).toBe("Unknown");
  });
});
```
```ts
// T-026 (07 PRD 14 §7): low-s normalisation (RV-034) and the 20 Gwei fee floor (p1-A6).
import { numberToHex, parseGwei } from "viem";
import { describe, expect, it } from "vitest";
import { MIN_MAX_FEE_PER_GAS, normaliseP256S, P256_N, withFeeFloor } from "@czar/vault-client";

describe("normaliseP256S", () => {
  it("maps a high s to n − s and leaves a low s alone", () => {
    const low = 5n;
    expect(normaliseP256S(numberToHex(low, { size: 32 }))).toBe(numberToHex(low, { size: 32 }));
    expect(normaliseP256S(numberToHex(P256_N - low, { size: 32 }))).toBe(
      numberToHex(low, { size: 32 }),
    );
    const half = P256_N / 2n;
    expect(normaliseP256S(numberToHex(half, { size: 32 }))).toBe(numberToHex(half, { size: 32 }));
    expect(normaliseP256S(numberToHex(half + 1n, { size: 32 }))).toBe(
      numberToHex(P256_N - half - 1n, { size: 32 }),
    );
  });

  it("refuses 0 and values ≥ n", () => {
    expect(() => normaliseP256S(numberToHex(0n, { size: 32 }))).toThrow();
    expect(() => normaliseP256S(numberToHex(P256_N, { size: 32 }))).toThrow();
  });
});

describe("withFeeFloor", () => {
  it("raises a low or missing maxFeePerGas to 20 Gwei and keeps a higher one", () => {
    expect(MIN_MAX_FEE_PER_GAS).toBe(parseGwei("20"));
    expect(withFeeFloor<{ maxFeePerGas?: bigint }>({}).maxFeePerGas).toBe(parseGwei("20"));
    expect(withFeeFloor({ maxFeePerGas: parseGwei("1") }).maxFeePerGas).toBe(parseGwei("20"));
    expect(withFeeFloor({ maxFeePerGas: parseGwei("50") }).maxFeePerGas).toBe(parseGwei("50"));
    expect(
      withFeeFloor({ maxFeePerGas: parseGwei("1"), maxPriorityFeePerGas: parseGwei("30") })
        .maxPriorityFeePerGas,
    ).toBe(parseGwei("20"));
  });
});
```
```ts
// T-026 (07 PRD 14 §6): src/abi.ts is the ABI of the compiled interfaces, which equal the spec copies (00-conventions
// §2.3). Fails when an interface changed and `pnpm gen-abi` was not run. Needs `arc-forge build` in contracts/.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { czarVaultAbi, czarVaultFactoryAbi } from "@czar/vault-client";

const compiled = (name: string): unknown =>
  (
    JSON.parse(
      readFileSync(
        new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url),
        "utf8",
      ),
    ) as { abi: unknown }
  ).abi;

describe("generated ABI", () => {
  it("equals the compiled ICzarVault and ICzarVaultFactory", () => {
    expect(czarVaultAbi).toEqual(compiled("ICzarVault"));
    expect(czarVaultFactoryAbi).toEqual(compiled("ICzarVaultFactory"));
  });
});
```

## 9. Integration test (`test/integration/anvil.test.ts`, the T-026 acceptance)
- **Setup:**
  - Starts `arc-anvil --network arc --chain-id 5042002 --port 18545` (cross-cutting §3.1).
  - Writes a keys file with **addresses only** to `deployments/.vault-client-test-keys.json`.
  - Runs `contracts/script/deploy.sh` with `--unlocked --sender` anvil's account 0. That account is unlocked by the node, so no key is passed anywhere.
  - Funds the generated accounts with `anvil_setBalance` (native USDC, A1-05).
  - Creates a vault for the generated owner.
- **Test 1, the T-016 acceptance through the client:**
  1. Open an envelope with a one-leaf payee tree, built with `@czar/hashing`.
  2. Reserve 2 indices.
  3. Sign the USDC digest with the agent key and encode it with `encodeUsdc3009Signature` (416 bytes).
  4. A relayer calls USDC's `transferWithAuthorization(…, bytes)`.
  5. The payee's balance rises by `unitAmount` and `authorizationState` is `true`.
  6. `settle` succeeds.
- **Test 2:** every function in `czarVaultAbi` is simulated once from a stranger with type-correct sample arguments.
  - Each call either succeeds or reverts with a custom error that `decodeViemError` names.
  - Spot checks: `withdraw` → `NotOwner`, `reserve` → `NotAgent`, `freeze` → `NotAuthorized`, `owner` → succeeds.
- **Tool lookup:**
  - `ARC_ANVIL` and `ARC_FORGE` name the tools, defaulting to `arc-anvil` and `arc-forge` on `PATH` (T-003 installs them).
  - `ARC_FORGE_FLAGS` may add compiler flags such as `--use <solc> --offline`.
  - None of these is a secret.
- **Cleanup:** the test removes its two files from `deployments/` and stops the node. Add `deployments/.vault-client-test*.json` to the root `.gitignore` in case a run is interrupted.
```ts
// T-026 acceptance (07 PRD 14 §8): on a local arc-anvil, the client deploys the real contracts (contracts/script/deploy.sh),
// calls every ICzarVault function once and decodes each revert by name, and a USDC_3009 envelope from the encoder is
// accepted by USDC through the vault's isValidSignature (the T-016 contract).
//
// Needs `arc-anvil` and `arc-forge` (T-003) on PATH, or ARC_ANVIL / ARC_FORGE pointing at them; ARC_FORGE_FLAGS may add
// compiler flags such as `--use <solc> --offline`. Every key is generated in memory for this run and never printed;
// only addresses are written to the keys file the deploy script reads.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildTree,
  derivedNonce,
  PAYEE_KIND,
  payeeLeaf,
  usdcTransferWithAuthorizationDigest,
} from "@czar/hashing";
import {
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  type Hex,
  http,
  parseAbi,
  parseEther,
  zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  czarVaultAbi,
  czarVaultFactoryAbi,
  decodeViemError,
  encodeUsdc3009Signature,
  withFeeFloor,
} from "@czar/vault-client";

const ROOT = new URL("../../../../", import.meta.url);
const CONTRACTS = fileURLToPath(new URL("contracts/", ROOT));
const KEYS_FILE = "deployments/.vault-client-test-keys.json";
const OUT_FILE = "deployments/.vault-client-test.json";
const PORT = 18545;
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 5042002; // cross-cutting §3.1: the local environment runs arc-anvil with the testnet chain id
const ANVIL_SENDER: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // anvil's unlocked account 0 (no key here)
const USDC: Address = "0x3600000000000000000000000000000000000000";
const RPC_READY_TRIES = 100;
const RPC_READY_DELAY_MS = 100;
const ACCOUNT_BALANCE = parseEther("1000"); // native USDC (18 decimals on the native side, A1-05)
const VAULT_BALANCE = parseEther("10");
const ONE_USDC = 1_000_000n;
const UNIT = 1_000n;
const COUNT = 2;
const TTL_SECONDS = 300n;
const LIFETIME_SECONDS = 86_400n;
const PAYEE: Address = "0x000000000000000000000000000000000000bEEF";
const STEP = 0;

const usdcAbi = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "function balanceOf(address) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

const chain = {
  id: CHAIN_ID,
  name: "arc-anvil",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;
const transport = http(RPC);
const pub = createPublicClient({ chain, transport });
const test = createTestClient({ chain, transport, mode: "anvil" });

const keys = {
  owner: privateKeyToAccount(generatePrivateKey()),
  agent: privateKeyToAccount(generatePrivateKey()),
  autonomy: privateKeyToAccount(generatePrivateKey()),
  guardian: privateKeyToAccount(generatePrivateKey()),
  evaluator: privateKeyToAccount(generatePrivateKey()),
  admin: privateKeyToAccount(generatePrivateKey()),
  relayer: privateKeyToAccount(generatePrivateKey()),
  stranger: privateKeyToAccount(generatePrivateKey()),
};
const wallet = (who: keyof typeof keys) =>
  createWalletClient({ chain, transport, account: keys[who] });

let anvil: ChildProcess | undefined;
let factory: Address;
let vault: Address;

const splitFlags = (v: string | undefined): string[] =>
  v === undefined || v === "" ? [] : v.split(" ");

async function waitForRpc(): Promise<void> {
  for (let i = 0; i < RPC_READY_TRIES; i++) {
    try {
      await pub.getChainId();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, RPC_READY_DELAY_MS));
    }
  }
  throw new Error("arc-anvil did not start");
}

async function send(
  who: keyof typeof keys,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
) {
  const fees = withFeeFloor({ maxFeePerGas: await pub.getGasPrice() });
  const hash = await wallet(who).writeContract({
    address,
    abi,
    functionName,
    args,
    ...fees,
  } as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
  return receipt;
}

beforeAll(async () => {
  anvil = spawn(
    process.env["ARC_ANVIL"] ?? "arc-anvil",
    ["--network", "arc", "--chain-id", String(CHAIN_ID), "--port", String(PORT)],
    {
      stdio: "ignore",
    },
  );
  await waitForRpc();
  const keysJson = Object.fromEntries(
    Object.entries({
      K3: keys.agent,
      K5: keys.autonomy,
      K6: keys.guardian,
      K7: keys.evaluator,
      K20: keys.admin,
    }).map(([id, a]) => [id, { address: a.address, ref: `vault-client-test-${id}` }]),
  );
  writeFileSync(fileURLToPath(new URL(KEYS_FILE, ROOT)), `${JSON.stringify(keysJson, null, 2)}\n`);
  execFileSync(
    "script/deploy.sh",
    [
      RPC,
      `../${KEYS_FILE}`,
      `../${OUT_FILE}`,
      ...splitFlags(process.env["ARC_FORGE_FLAGS"]),
      "--broadcast",
      "--unlocked",
      "--sender",
      ANVIL_SENDER,
    ],
    {
      cwd: CONTRACTS,
      stdio: "ignore",
      env: { ...process.env, ARC_FORGE: process.env["ARC_FORGE"] ?? "arc-forge" },
    },
  );
  const record = JSON.parse(readFileSync(fileURLToPath(new URL(OUT_FILE, ROOT)), "utf8")) as {
    CzarVaultFactory: Address;
  };
  factory = record.CzarVaultFactory;
  for (const a of Object.values(keys))
    await test.setBalance({ address: a.address, value: ACCOUNT_BALANCE });
  await send("owner", factory, czarVaultFactoryAbi, "createVault", [keys.owner.address]);
  vault = await pub.readContract({
    address: factory,
    abi: czarVaultFactoryAbi,
    functionName: "vaultOf",
    args: [keys.owner.address],
  });
  await test.setBalance({ address: vault, value: VAULT_BALANCE });
});

afterAll(() => {
  anvil?.kill();
  for (const f of [KEYS_FILE, OUT_FILE]) rmSync(fileURLToPath(new URL(f, ROOT)), { force: true });
});

describe("vault-client against the deployed contracts", () => {
  it("a USDC_3009 envelope from the encoder pays the payee through USDC and the vault settles it (T-016)", async () => {
    const tree = buildTree([payeeLeaf(PAYEE, PAYEE_KIND.X402_PAY_TO, STEP, ONE_USDC)]);
    const now = (await pub.getBlock()).timestamp;
    await send("owner", vault, czarVaultAbi, "openEnvelope", [
      {
        cap: 2n * ONE_USDC,
        maxStepAmount: ONE_USDC,
        pocketCapBps: 0,
        expiresAt: now + LIFETIME_SECONDS,
        categoryId: `0x${"00".repeat(32)}`,
        objectiveHash: `0x${"00".repeat(32)}`,
        planHash: `0x${"00".repeat(32)}`,
        payeeRoot: tree.root,
      },
    ]);
    const envelopeId = await pub.readContract({
      address: vault,
      abi: czarVaultAbi,
      functionName: "envelopeCount",
    });
    const validBefore = now + TTL_SECONDS;
    await send("agent", vault, czarVaultAbi, "reserve", [
      envelopeId,
      STEP,
      PAYEE,
      ONE_USDC,
      [],
      UNIT,
      COUNT,
      validBefore,
    ]);
    const reservationId = await pub.readContract({
      address: vault,
      abi: czarVaultAbi,
      functionName: "reservationCount",
    });

    const nonce = derivedNonce(vault, reservationId, 0);
    const digest = usdcTransferWithAuthorizationDigest(CHAIN_ID, {
      from: vault,
      to: PAYEE,
      value: UNIT,
      validAfter: 0n,
      validBefore,
      nonce,
    });
    const agentSig = await keys.agent.sign({ hash: digest });
    const signature = encodeUsdc3009Signature({
      reservationId,
      index: 0,
      to: PAYEE,
      value: UNIT,
      validAfter: 0n,
      validBefore,
      nonce,
      agentSig,
    });
    expect(signature.length).toBe(2 + 2 * 416);

    const before = await pub.readContract({
      address: USDC,
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [PAYEE],
    });
    await send("relayer", USDC, usdcAbi, "transferWithAuthorization", [
      vault,
      PAYEE,
      UNIT,
      0n,
      validBefore,
      nonce,
      signature,
    ]);
    expect(
      await pub.readContract({
        address: USDC,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [PAYEE],
      }),
    ).toBe(before + UNIT);
    expect(
      await pub.readContract({
        address: USDC,
        abi: usdcAbi,
        functionName: "authorizationState",
        args: [vault, nonce],
      }),
    ).toBe(true);
    await send("stranger", vault, czarVaultAbi, "settle", [reservationId, [0]]);
  });

  it("calls every ICzarVault function once; every revert decodes to a named custom error", async () => {
    const functions = czarVaultAbi.filter(
      (i): i is Extract<(typeof czarVaultAbi)[number], AbiFunction> => i.type === "function",
    );
    const outcomes: Record<string, string> = {};
    for (const fn of functions) {
      const args = fn.inputs.map(sample);
      try {
        await pub.simulateContract({
          address: vault,
          abi: [fn] as Abi,
          functionName: fn.name,
          args,
          account: keys.stranger,
        });
        outcomes[fn.name] = "ok";
      } catch (e) {
        const decoded = decodeViemError(e);
        outcomes[fn.name] =
          decoded?.kind === "custom" ? decoded.name : `UNDECODED ${decoded?.name ?? String(e)}`;
      }
    }
    const undecoded = Object.entries(outcomes).filter(([, o]) => o.startsWith("UNDECODED"));
    expect(undecoded).toEqual([]);
    // The caller is a stranger, so the role checks answer first (czar-vault.md §15.1, §15.3).
    expect(outcomes["withdraw"]).toBe("NotOwner");
    expect(outcomes["reserve"]).toBe("NotAgent");
    expect(outcomes["freeze"]).toBe("NotAuthorized");
    expect(outcomes["owner"]).toBe("ok");
    expect(Object.keys(outcomes)).toHaveLength(new Set(functions.map((f) => f.name)).size);
  });
});

/** A value of the right ABI type; addresses are non-zero so ZeroAddress checks do not hide the caller check. */
function sample(p: AbiParameter): unknown {
  if (p.type.endsWith("[]")) return [];
  if (p.type === "tuple") {
    const components = (p as { components: readonly AbiParameter[] }).components;
    return Object.fromEntries(components.map((c) => [c.name, sample(c)]));
  }
  if (p.type === "address") return "0x0000000000000000000000000000000000000001" satisfies Address;
  if (p.type === "bool") return false;
  if (p.type === "string") return "";
  if (p.type === "bytes") return "0x" satisfies Hex;
  if (p.type.startsWith("bytes")) return `0x${"00".repeat(Number(p.type.slice(5)))}`;
  if (p.type.startsWith("uint") || p.type.startsWith("int"))
    return p.type === "uint8" || p.type === "uint16" || p.type === "uint32" ? 1 : 1n;
  return zeroAddress;
}
```

## 10. Build steps
1. Delete `packages/vault-client/.gitkeep`; create §5 and run `pnpm install`.
2. Build the contracts and generate the ABI (§6).
3. Create the §8 unit tests, then run `pnpm --filter @czar/vault-client exec vitest run test/encoders.test.ts test/errors.test.ts test/webauthn-fees.test.ts test/abi.test.ts`. They fail: the sources do not exist yet. Tests come first for code that signs payments (CLAUDE.md).
4. Create the §7 sources. Run the same command: 78 passed.
5. Create the §9 test and run `pnpm --filter @czar/vault-client test`: 5 files, 80 passed.
6. Run `pnpm --filter @czar/vault-client typecheck`, `pnpm exec oxlint --deny-warnings packages/vault-client` and `pnpm exec oxfmt --check packages/vault-client`: all clean.

## 11. Definition of done
- `pnpm --filter @czar/vault-client test` → 80 passed, including both integration tests (T-026).
- The `USDC_3009` encoder output is 416 bytes and USDC accepts it through the vault (integration test 1, T-026).
- Every `ICzarVault` function is called once and every revert decodes by name (integration test 2, T-026).
- `typecheck`, `oxlint` and `oxfmt --check` are clean.
- `git ls-files | grep -iE 'vault-client-test|\.key|\.env'` → nothing.

## 12. Stop conditions
- **An integration call reverts `UNDECODED`.** The revert is not one of the interface's errors, so either the contract reverted raw or the ABI is stale. Rerun §6. If it persists, report the function and the decoded value; do not add a special case.
- **Test 1's `transferWithAuthorization` reverts with `FiatTokenV2: invalid signature`.**
  - Compare the digest from `usdcTransferWithAuthorizationDigest` with `arc-cast call 0x3600… "DOMAIN_SEPARATOR()(bytes32)"`. The chain id must be 5042002 on both sides.
  - Then compare the envelope bytes with `SignatureTest`'s `_envelope` in the contracts.
  - Stop and report.
- **The deploy step fails.** Run PRD 13 §8 step 6 by hand to see the error.

## Change log
| Date | Change |
|---|---|
| 2026-10-20 | First version, verified in a repository copy with PRDs 01–13 applied (80 tests, arc-anvil integration). |
