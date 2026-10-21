import { describe, expect, it } from "vitest";
import {
  burnSalt,
  callInputsHash,
  demandSalt,
  descriptionHash,
  descriptionHashFromBrief,
  H,
  inputCommit,
  jobDescription,
  objectiveHash,
  paymentRefHash,
  planHash,
  reportHash,
  soulVersionCommit,
  soulVersionHash,
  taskSpecHash,
  type Hash32,
} from "@czar/hashing";
import { encodeAbiParameters, keccak256 } from "viem";
import type { TaskSpec } from "@czar/schemas";

const hash = (c: string) => `0x${c.repeat(64)}` as Hash32;
const VAULT = "0x00000000000000000000000000000000000c2a21";

describe("named hashes (02 §5.2)", () => {
  const taskSpec: TaskSpec = {
    schemaVersion: "1.1",
    kind: "table-fill",
    topic: "Competitor pricing",
    subjects: [{ label: "Billora" }],
    fields: ["Starter price"],
    sourceTrust: "user-file",
  };
  const objective = {
    objectiveId: "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
    soulVersionHash: hash("1"),
    observationHashes: [hash("b"), hash("a")],
    detector: "repeated-error",
    goal: "Find a cheaper search API",
    capabilities: ["web-search"],
    minutesSaved: 30,
    hourlyBand: "40-80",
    taskSpecHash: taskSpecHash(taskSpec),
  };

  it("taskSpecHash nests the complete TaskSpec", () => {
    expect(taskSpecHash(taskSpec)).toBe(
      "0x542b740f10539164b1edf7138632d511aadc5da1f5f4dc8df59e19800f669a2e",
    );
  });

  it("objectiveHash binds subject-label changes through taskSpecHash", () => {
    const changedTaskSpec = {
      ...taskSpec,
      subjects: [{ label: "InvoiceKite" }],
    };
    expect(objectiveHash(objective)).toBe(
      "0x9e1b1c2c1df2ebf55064af01805ecf2eceea98af7dc795199cf6a7a9daec8422",
    );
    expect(objectiveHash({ ...objective, taskSpecHash: taskSpecHash(changedTaskSpec) })).toBe(
      "0x5145624fb9c23804cd833386c3decde04f8cdef99b0e9ebdc63a25c2cc949d0a",
    );
  });

  it("objectiveHash sorts observation hashes and omits an absent deadline", () => {
    expect(objectiveHash(objective)).toBe(
      H({
        hashRule: "czar-hash-v1",
        kind: "objective",
        ...objective,
        observationHashes: [hash("a"), hash("b")],
      }),
    );
    expect(objectiveHash({ ...objective, observationHashes: [hash("a"), hash("b")] })).toBe(
      objectiveHash(objective),
    );
    expect(objectiveHash({ ...objective, deadline: "2026-10-20T00:00:00Z" })).not.toBe(
      objectiveHash(objective),
    );
  });

  it("planHash excludes resource URLs and inputTemplate", () => {
    const step = {
      stepIndex: 0,
      kind: "x402-exact",
      payee: VAULT,
      unitAmount: "1000",
      expectedCalls: 2,
      stepCap: "2000",
      acceptanceProfileId: "delivery",
    };
    const plan = {
      planId: "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
      objectiveHash: hash("2"),
      network: "eip155:5042002",
      category: "research",
      cap: "5000",
      slackBps: 1000,
      maxStepAmount: "2000",
      pocketCapBps: 0,
      expiresAt: "2026-10-20T00:00:00Z",
      payeeRoot: hash("3"),
      taskSpecHash: taskSpecHash(taskSpec),
      steps: [step],
    };
    const withExtras = {
      ...plan,
      steps: [{ ...step, resource: "https://x.example/api", inputTemplate: { q: "x" } }],
    };
    expect(planHash(withExtras)).toBe(planHash(plan));
  });

  it("binds callInputs and omits their hash when a step has no callInputs", () => {
    const base = {
      planId: "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
      objectiveHash: hash("2"),
      network: "eip155:5042002",
      category: "research",
      cap: "5000",
      slackBps: 1000,
      maxStepAmount: "2000",
      pocketCapBps: 0,
      expiresAt: "2026-10-20T00:00:00Z",
      payeeRoot: hash("3"),
      taskSpecHash: taskSpecHash(taskSpec),
    };
    const step = {
      stepIndex: 0,
      kind: "x402-exact",
      payee: VAULT,
      unitAmount: "1000",
      expectedCalls: 1,
      stepCap: "2000",
      acceptanceProfileId: "delivery",
    };
    const withoutInputs = { ...base, steps: [step] };
    expect(planHash(withoutInputs)).toBe(
      H({
        hashRule: "czar-hash-v1",
        kind: "plan",
        ...base,
        steps: [step],
      }),
    );

    const callInputs = [{ callIndex: 0, subjectIndex: 0, input: { query: "Billora prices" } }];
    expect(callInputsHash(callInputs)).toBe(H(callInputs));
    expect(callInputsHash(callInputs)).toBe(
      "0xe91c923f4e32dadf4742356020e6fd17b6a5048158d0b88a72aea7a35e63bfa5",
    );
    const withInputs = {
      ...base,
      steps: [{ ...step, fanOut: "subjects" as const, callInputsHash: callInputsHash(callInputs) }],
    };
    const changedInputs = [
      { callIndex: 0, subjectIndex: 0, input: { query: "InvoiceKite prices" } },
    ];
    const changed = {
      ...base,
      steps: [
        { ...step, fanOut: "subjects" as const, callInputsHash: callInputsHash(changedInputs) },
      ],
    };
    expect(planHash(changed)).not.toBe(planHash(withInputs));
  });

  it("reportHash and paymentRefHash drop only their excluded fields", () => {
    expect(reportHash({ a: 1, reportHash: hash("9") })).toBe(H({ a: 1 }));
    const ref = {
      rail: "x402-exact",
      network: "eip155:5042002",
      amount: "1000",
      reservationId: 12,
      index: 3,
      settlementTx: hash("4"),
    };
    expect(paymentRefHash(ref)).toBe(
      H({ rail: "x402-exact", network: "eip155:5042002", amount: "1000", settlementTx: hash("4") }),
    );
  });

  it("descriptionHash from a JobBrief recomputes inputCommit", () => {
    const brief = {
      planHash: hash("5"),
      stepIndex: 1,
      acceptanceProfileId: "structural",
      inputs: { url: "https://a.example" },
      inputSalt: hash("6"),
    };
    const commit = inputCommit(brief.inputs, brief.inputSalt);
    expect(commit).toBe(
      H({
        hashRule: "czar-hash-v1",
        kind: "job-input",
        inputs: brief.inputs,
        inputSalt: brief.inputSalt,
      }),
    );
    const d = {
      planHash: brief.planHash,
      stepIndex: 1,
      acceptanceProfileId: "structural",
      inputCommit: commit,
    };
    expect(descriptionHashFromBrief(brief)).toBe(descriptionHash(d));
    expect(jobDescription(d)).toBe(`czar:${descriptionHash(d)}`);
  });

  it("soulVersionHash nests section hashes; previousHash is optional", () => {
    const belief = {
      beliefId: "blf_1",
      text: "works late",
      confidence: 0.5,
      firstSeen: "2026-10-01",
      lastSeen: "2026-10-18",
      receipts: ["evt_b", "evt_a"],
    };
    const a = soulVersionHash({
      version: 2,
      compiledAt: "2026-10-19T02:00:00Z",
      sections: { rituals: [belief] },
    });
    const b = soulVersionHash({
      version: 2,
      compiledAt: "2026-10-19T02:00:00Z",
      sections: { rituals: [{ ...belief, receipts: ["evt_a", "evt_b"] }] },
    });
    expect(a).toBe(b);
    expect(
      soulVersionHash({
        version: 2,
        compiledAt: "2026-10-19T02:00:00Z",
        previousHash: hash("7"),
        sections: { rituals: [belief] },
      }),
    ).not.toBe(a);
  });

  it("demandSalt, soulVersionCommit and burnSalt follow their abi.encode rules", () => {
    const salt = demandSalt(hash("8"), VAULT, 4n);
    expect(salt).toBe(
      keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "address" }, { type: "uint64" }],
          [hash("8"), VAULT, 4n],
        ),
      ),
    );
    expect(soulVersionCommit(hash("9"), salt)).toBe(
      keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [hash("9"), salt])),
    );
    expect(burnSalt(VAULT, 1n)).not.toBe(burnSalt(VAULT, 2n));
  });
});
