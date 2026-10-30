// SCR-159 §2: the signer assigns transaction nonces per key under an in-process lock, as
// `max(pending count from the RPC, last nonce assigned to that key + 1)`. Two concurrent requests for one key
// (the dispatcher and the freeze handler's `lowerAutoLimit`, both K3) never get the same nonce.
import { describe, expect, it } from "vitest";
import { parseTransaction, type Hex, type TransactionSerializableEIP1559 } from "viem";
import type { TransactionPreparer } from "../src/service.ts";
import { archiveUri, h, harness, NETWORK, uriHash, VAULT } from "./helpers.ts";

const closeEnvelope = (envelopeId: string) => ({
  keyId: "K3",
  kind: "vault-call",
  payload: { vault: VAULT, selector: "closeEnvelope", args: { envelopeId } },
});

/** An RPC preparer whose pending count is `pending()`, resolved after `delayMs` (a slow RPC). */
function rpcPreparer(pending: () => number, delayMs = 0): TransactionPreparer {
  return async (_from, call) => {
    const nonce = pending();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const tx: TransactionSerializableEIP1559 = {
      type: "eip1559",
      chainId: NETWORK.chainId,
      nonce,
      gas: 200_000n,
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 1n,
      to: call.to,
      data: call.data,
      value: call.value,
    };
    return tx;
  };
}

function nonceOf(result: unknown): number {
  return parseTransaction((result as { signedTransaction: Hex }).signedTransaction).nonce ?? -1;
}

describe("signer transaction nonces (SCR-159 §2)", () => {
  it("gives two concurrent K3 requests consecutive nonces while the RPC pending count is unchanged", async () => {
    const t = await harness({ prepareTransaction: rpcPreparer(() => 7, 5) });

    const [first, second] = await Promise.all([
      t.signer.sign("cz-15", closeEnvelope("1")),
      t.signer.sign("cz-15", closeEnvelope("2")),
    ]);

    expect([nonceOf(first), nonceOf(second)].toSorted()).toEqual([7, 8]);
  });

  it("uses the RPC pending count once it is past the last assigned nonce", async () => {
    let pending = 3;
    const t = await harness({ prepareTransaction: rpcPreparer(() => pending) });

    expect(nonceOf(await t.signer.sign("cz-15", closeEnvelope("1")))).toBe(3);
    pending = 9;
    expect(nonceOf(await t.signer.sign("cz-15", closeEnvelope("2")))).toBe(9);
    expect(nonceOf(await t.signer.sign("cz-15", closeEnvelope("3")))).toBe(10);
  });

  it("counts nonces per key: a K8 transaction does not move K3's next nonce", async () => {
    const t = await harness({ prepareTransaction: rpcPreparer(() => 0) });

    expect(nonceOf(await t.signer.sign("cz-15", closeEnvelope("1")))).toBe(0);
    await t.signer.sign("cz-17", {
      keyId: "K8",
      kind: "oel-commit",
      payload: {
        kind: "0",
        root: h("7"),
        prev: h("0"),
        uriHash: uriHash(archiveUri(h("7"))),
        uri: archiveUri(h("7")),
      },
    });
    expect(nonceOf(await t.signer.sign("cz-15", closeEnvelope("2")))).toBe(1);
  });

  it("assigns no nonce to a refused request", async () => {
    const t = await harness({ prepareTransaction: rpcPreparer(() => 4) });

    await expect(
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "vault-call",
        payload: { vault: VAULT, selector: "approve", args: {} },
      }),
    ).rejects.toMatchObject({ name: "Denied" });
    expect(nonceOf(await t.signer.sign("cz-15", closeEnvelope("1")))).toBe(4);
  });
});
