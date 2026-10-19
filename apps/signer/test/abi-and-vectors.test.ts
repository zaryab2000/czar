// The signer's ABIs match the Solidity interfaces, and the 02 §6.4 vectors reproduce through the signer
// (digest equality before signing, CZ-27 §14 "Replay").
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { derivedNonce } from "@czar/hashing";
import vectors from "@czar/hashing/vectors" with { type: "json" };
import { decide, FACTORY_ABI, K3_ALLOWED, K3_NEVER, VAULT_ABI } from "../src/index.ts";
import { defaultState, fakeProjection, NETWORK, VAULT } from "./helpers.ts";

const INTERFACES = resolve(import.meta.dirname, "../../../contracts/src/interfaces");
const externalFunctions = (file: string) =>
  [
    ...readFileSync(resolve(INTERFACES, file), "utf8").matchAll(
      /function (\w+)\(([^)]*)\)\s*([^;{]*)/g,
    ),
  ]
    .filter((m) => !/\b(view|pure)\b/.test(m[3] ?? ""))
    .map((m) => m[1] as string);

describe("ABI drift", () => {
  it("covers every state-changing ICzarVault function except sync", () => {
    const sol = new Set(externalFunctions("ICzarVault.sol"));
    sol.delete("sync");
    expect(new Set(VAULT_ABI.map((fn) => fn.name))).toEqual(sol);
  });

  it("puts every vault function in exactly one of the K3 allow or never lists", () => {
    for (const fn of VAULT_ABI) {
      expect(Number(K3_ALLOWED.includes(fn.name)) + Number(K3_NEVER.includes(fn.name))).toBe(1);
    }
  });

  it("lists every state-changing factory function as a factory selector", () => {
    const sol = new Set(externalFunctions("ICzarVaultFactory.sol"));
    for (const name of sol) expect(FACTORY_ABI.map((fn) => fn.name)).toContain(name);
  });
});

const ctx = (state = defaultState("0x000000000000000000000000000000000000b0c0")) => ({
  projection: fakeProjection(state),
  network: NETWORK,
  now: () => 1_760_800_000,
  freezeStateMaxAgeSec: 30,
  keyAddress: () => VAULT,
  gasMaxAtomic: { K3: 0n, K7: 0n, K8: 0n },
});

describe("vector replay through the signer", () => {
  const v = vectors.vectors;

  it("gateway-burn reproduces gatewayBurnIntent_sameChain", async () => {
    const m = v.gatewayBurnIntent_sameChain.message;
    const state = defaultState("0x000000000000000000000000000000000000b0c0");
    state.pullback = {
      pocket: "0x000000000000000000000000000000000000b0c0",
      value: BigInt(m.spec.value),
      maxFee: BigInt(m.maxFee),
      maxBlockHeight: BigInt(m.maxBlockHeight),
      salt: m.spec.salt as `0x${string}`,
      state: "Pending",
    };
    const decision = await decide(ctx(state), "gateway-burn", { vault: VAULT, pullbackId: 1n });
    expect(decision.type === "digest" && decision.digest).toBe(
      v.gatewayBurnIntent_sameChain.digest,
    );
  });

  it("sl-receipt reproduces receiptAttestation_5042002 from the slReceipt_5042002 fields", async () => {
    const m = v.slReceipt_5042002.message;
    const receipt = {
      ...m,
      tRequest: BigInt(m.tRequest),
      tPaymentSigned: BigInt(m.tPaymentSigned),
      tComplete: BigInt(m.tComplete),
      createdAt: BigInt(m.createdAt),
    };
    const state = defaultState("0x000000000000000000000000000000000000b0c0");
    state.settled.add(m.paymentRefHash);
    const decision = await decide(ctx(state), "sl-receipt", { vault: VAULT, receipt });
    expect(decision.type === "digest" && decision.digest).toBe(v.receiptAttestation_5042002.digest);
  });

  it("autonomy-raise reproduces autonomyRaise_5042002", async () => {
    const m = v.autonomyRaise_5042002.message;
    const state = defaultState("0x000000000000000000000000000000000000b0c0");
    state.autonomy = {
      autoLimit: 1n,
      userMax: 10n ** 12n,
      maxStepTo: 10n ** 12n,
      lastRaiseAt: 0,
      periodLength: 1,
      nonce: BigInt(m.nonce),
    };
    const decision = await decide(ctx(state), "autonomy-raise", {
      vault: VAULT,
      categoryId: m.category,
      newLimit: BigInt(m.newLimit),
      periodId: BigInt(m.periodId),
      deadline: BigInt(m.deadline),
    });
    expect(decision.type === "digest" && decision.digest).toBe(v.autonomyRaise_5042002.digest);
  });

  it("usdc-3009 derives the derivedNonce_example nonce", () => {
    const d = v.derivedNonce_example;
    expect(derivedNonce(d.vault as `0x${string}`, BigInt(d.reservationId), d.index)).toBe(d.nonce);
  });
});
