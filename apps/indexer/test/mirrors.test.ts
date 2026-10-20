import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  envelopeMirror,
  jobMirror,
  jobState,
  pocketMirror,
  reservationMirror,
} from "@czar/indexer/mirrors";

const vault: Address = "0x00000000000000000000000000000000000c2a21";
const payee: Address = "0x00000000000000000000000000000000000c2a22";
const pocket: Address = "0x00000000000000000000000000000000000c2a23";
const hash = `0x${"a".repeat(64)}` as const;
const zero = `0x${"0".repeat(64)}` as const;

function schema(name: string): object {
  return JSON.parse(
    readFileSync(
      new URL(
        `../../../docs/specs/02-data-and-protocol/schemas/${name}.schema.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as object;
}

const ajv = new Ajv2020.default({ strict: false });
ajv.addSchema(schema("common"));
for (const name of ["envelope", "reservation", "pocket-record", "job-record"]) {
  ajv.addSchema(schema(name), name);
}
const pocketProjectionSchema = schema("pocket-record") as {
  $id: string;
  required: string[];
};
pocketProjectionSchema.$id = "https://czar.dev/schemas/pocket-record-projection.schema.json";
pocketProjectionSchema.required = pocketProjectionSchema.required.filter(
  (field) => field !== "keyRef",
);
ajv.addSchema(pocketProjectionSchema, "pocket-projection");

function valid(name: string, value: unknown): void {
  const validate = ajv.getSchema(name);
  if (!validate) throw new Error(`Schema ${name} was not registered`);
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

describe("vault mirror schema and derived states", () => {
  it("builds an Envelope and derives Closing from expiry or pullback", () => {
    const view = {
      cap: 1_000_000n,
      maxStepAmount: 100_000n,
      spent: 50n,
      reserved: 100n,
      pocketOutstanding: 0n,
      jobEscrowed: 0n,
      shortfall: 2n,
      categoryId: hash,
      objectiveHash: hash,
      planHash: hash,
      payeeRoot: hash,
      pocket,
      expiresAt: 1000n,
      pocketCapBps: 2500,
      state: 1,
      approverIsOwner: true,
    };
    const base = { vault, envelopeId: 1n, view, approvalTx: hash, block: 4n };
    const opened = envelopeMirror({ ...base, timestamp: 900n, closeStarted: false });
    expect(opened.state).toBe("Open");
    valid("envelope", opened);
    const expired = envelopeMirror({ ...base, timestamp: 1000n, closeStarted: false });
    expect(expired.state).toBe("Closing");
    valid("envelope", expired);
    const draining = envelopeMirror({ ...base, timestamp: 900n, closeStarted: true });
    expect(draining.state).toBe("Closing");
    valid("envelope", draining);
    valid(
      "envelope",
      envelopeMirror({
        ...base,
        timestamp: 1001n,
        closeStarted: true,
        view: { ...view, state: 2 },
      }),
    );
  });

  it("builds a Reservation from counters and the settled mask", () => {
    const mirror = reservationMirror(vault, 3n, {
      envelopeId: 1n,
      stepIndex: 0,
      payee,
      unitAmount: 100n,
      count: 2,
      validBefore: 1000n,
      mode: 1,
      state: 3,
      settledCount: 1,
      releasedCount: 1,
      settledMask: 1n,
    });
    expect(mirror.state).toBe("Final");
    expect(mirror.mode).toBe("digest");
    expect(mirror.settledMask).toBe(`0x${"0".repeat(63)}1`);
    valid("reservation", mirror);
  });

  it("builds the event-sourced PocketRecord fields and pullback credit", () => {
    const mirror = pocketMirror({
      vault,
      pocket,
      delegateReady: false,
      view: {
        envelopeId: 1n,
        state: 1,
        funded: 0n,
        gasGranted: 100n,
        outstanding: 0n,
        pendingPullback: 0n,
      },
      pullbacks: [
        {
          pullbackId: 2,
          value: "50",
          salt: zero,
          maxFee: "1",
          maxBlockHeight: 15,
          transferSpecHash: hash,
          requestedAtBlock: 4,
          state: "Confirmed",
          recovery: false,
          creditedToEnvelope: true,
        },
      ],
    });
    expect(mirror.state).toBe("Registered");
    expect(mirror).not.toHaveProperty("keyRef");
    valid("pocket-projection", mirror);
    expect(ajv.getSchema("pocket-record")?.(mirror)).toBe(false);
  });

  it("builds JobRecord and maps every vault JobSynced state", () => {
    expect([1, 2, 3, 4, 5, 6].map(jobState)).toEqual([
      "Opened",
      "Funded",
      "Submitted",
      "Completed",
      "Refunded",
      "Released",
    ]);
    expect(() => jobState(7)).toThrow("Invalid JobSynced.state");
    const mirror = jobMirror({
      vault,
      jobKey: hash,
      jobEscrow: pocket,
      evaluator: payee,
      descriptionHash: zero,
      view: {
        provider: payee,
        envelopeId: 1n,
        stepIndex: 1,
        state: 6,
        expiredAt: 1000n,
        jobId: 7n,
        reservedCap: 100n,
        budget: 0n,
      },
    });
    expect(mirror.state).toBe("Released");
    valid("job-record", mirror);
  });
});
