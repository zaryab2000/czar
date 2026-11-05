// PM-046 unit tests: the CZ-20 §5.11 test-provider loop with a fake signer client, a fake chain and the server
// double's two routes. Each behaviour mode is checked by the exact signer and chain calls it makes.
import { describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
import { jobKey, type Address, type Hash32 } from "@czar/hashing";
import type { JobBrief } from "@czar/schemas";
import { Denied, type SignRequest, type SignResult } from "@czar/signer";
import { bytesToHex, hexToString, keccak256, stringToHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  BEHAVIOUR_MODES,
  composeProviders,
  createHttpJobServer,
  createProviderInstance,
  DEFAULT_WORK_MODES,
  parseModes,
  placeholderWorkMode,
  providerIndexEntry,
  ProviderModeError,
  type BehaviourMode,
  type JobCreated,
  type ProviderChain,
  type WorkMode,
} from "#src/provider/index";
import { makeBrief, serverDouble } from "#test/provider-fixtures";

const CHAIN_ID = 5042002;
const ESCROW: Address = "0x000000000000000000000000000000000000e5c0";
const CLIENT: Address = "0x00000000000000000000000000000000000c2a21";
const K7: Address = "0x00000000000000000000000000000000000000c7";
// Throwaway in-memory keys standing in for the signer's K21a/K21b, generated per run and never stored.
const ACCOUNTS = {
  K21a: privateKeyToAccount(generatePrivateKey()),
  K21b: privateKeyToAccount(generatePrivateKey()),
};
const K21A: Address = ACCOUNTS.K21a.address;
const K21B: Address = ACCOUNTS.K21b.address;
const OTHER: Address = "0x000000000000000000000000000000000000dead";
const START = 1_792_100_000;
const EXPIRED_AT = START + 3_600;
const SUBMIT_BY = EXPIRED_AT - 600;
const BUDGET_CAP = 250_000n;
const TARGET = 200_000n;
const POLL_MS = 10;
/** Each fake sleep moves chain time forward this much, so every wait ends. */
const SLEEP_ADVANCE_SECONDS = 120;

type Sent = { action: string; jobId: string; args: Record<string, string> };

/** A fake signer client: one address per test-provider key, and CZ-27's `submit` rule on accepted uploads. */
function fakeSigner(accepted: Set<string>) {
  const addresses: Record<string, Address> = { K21a: K21A, K21b: K21B };
  const owners: Record<string, string> = { K21a: "czar-provider-a", K21b: "czar-provider-b" };
  const calls: { caller: string; action: string; args: Record<string, string> }[] = [];
  return {
    calls,
    actions: () => calls.map((call) => call.action),
    async keyAddress(caller: string, keyRef: string) {
      if (owners[keyRef] !== caller) throw new Denied("caller-not-owner");
      return addresses[keyRef] as Address;
    },
    async sign(caller: string, request: SignRequest): Promise<SignResult> {
      if (request.kind !== "provider-call" || owners[request.keyId] !== caller)
        throw new Denied("caller-not-owner");
      const payload = request.payload as {
        escrow: Address;
        jobId: string;
        action: string;
        args: Record<string, string>;
      };
      calls.push({ caller, action: payload.action, args: payload.args });
      const key = jobKey(payload.escrow, BigInt(payload.jobId));
      if (payload.action === "submit" && !accepted.has(`${key}:${payload.args["contentHash"]}`))
        throw new Denied("deliverable-not-accepted");
      if (payload.action === "setBudget" || payload.action === "submit")
        return {
          signedTransaction: stringToHex(
            JSON.stringify({ action: payload.action, jobId: payload.jobId, args: payload.args }),
          ),
        };
      // A digest action: any 32 bytes stand in for the EIP-712 digest; the signature is the key's own.
      const digest = keccak256(stringToHex(JSON.stringify(payload))) as Hash32;
      const account = ACCOUNTS[request.keyId as "K21a" | "K21b"];
      return { signature: await account.sign({ hash: digest }), digest };
    },
  };
}

/** A fake escrow: JobCreated events, descriptions, funding (the client funds any budget ≤ the cap), chain time. */
function fakeChain(options: { fundUpTo: bigint }) {
  const state = {
    now: START,
    block: 100n,
    jobs: [] as JobCreated[],
    descriptions: new Map<bigint, string>(),
    funded: new Set<bigint>(),
    sent: [] as (Sent & { at: number })[],
    status: "success" as "success" | "reverted",
  };
  const chain: ProviderChain = {
    latestBlock: async () => state.block,
    jobsCreated: async (provider, from, to) =>
      state.jobs.filter(
        (job) =>
          job.provider.toLowerCase() === provider.toLowerCase() &&
          job.blockNumber >= from &&
          job.blockNumber <= to,
      ),
    description: async (job) => state.descriptions.get(job.jobId) ?? "",
    funded: async (job) => state.funded.has(job.jobId),
    now: async () => state.now,
    async send(signed: Hex) {
      const call = JSON.parse(hexToString(signed)) as Sent;
      state.sent.push({ ...call, at: state.now });
      if (call.action === "setBudget" && BigInt(call.args["amount"] ?? "0") <= options.fundUpTo)
        state.funded.add(BigInt(call.jobId));
      return { txHash: keccak256(signed) as Hash32, status: state.status };
    },
  };
  return { chain, state };
}

function setup(
  options: {
    behaviour?: BehaviourMode;
    instance?: "czar-provider-a" | "czar-provider-b";
    workModes?: readonly WorkMode[];
    work?: string;
    brief?: Partial<Parameters<typeof makeBrief>[0]>;
    providerAddress?: Address;
  } = {},
) {
  const server = serverDouble({ chainId: CHAIN_ID, verify: false, nowSeconds: () => START });
  const signer = fakeSigner(server.accepted);
  const { chain, state } = fakeChain({ fundUpTo: BUDGET_CAP });
  const instance = options.instance ?? "czar-provider-a";
  const provider = instance === "czar-provider-a" ? K21A : K21B;
  const providerInstance = createProviderInstance({
    instance,
    modes: [options.work ?? "placeholder", options.behaviour ?? "honest"],
    minWorkSeconds: 60,
    pollMs: POLL_MS,
    chainId: CHAIN_ID,
    evaluator: K7,
    signer,
    chain,
    server: createHttpJobServer({ baseUrl: "http://127.0.0.1:3000", fetch: server.fetch }),
    ...(options.workModes === undefined ? {} : { workModes: options.workModes }),
    ...(options.providerAddress === undefined ? {} : { providerAddress: options.providerAddress }),
    nowMs: () => START * 1000,
    sleep: async () => {
      state.now += SLEEP_ADVANCE_SECONDS;
    },
  });
  let nextJobId = 1n;
  const addJob = (
    overrides: { evaluator?: Address; description?: string; brief?: Partial<JobBrief> } = {},
  ) => {
    const jobId = nextJobId;
    nextJobId += 1n;
    const evaluator = overrides.evaluator ?? K7;
    const { brief, description } = makeBrief({
      escrow: ESCROW,
      jobId,
      chainId: CHAIN_ID,
      evaluator,
      expiredAt: EXPIRED_AT,
      submitBy: SUBMIT_BY,
      budgetCap: BUDGET_CAP,
      targetBudget: TARGET,
      ...options.brief,
    });
    const job: JobCreated = {
      escrow: ESCROW,
      abi: "czar",
      jobId,
      client: CLIENT,
      provider,
      evaluator,
      expiredAt: BigInt(EXPIRED_AT),
      blockNumber: state.block + 1n,
    };
    state.block += 1n;
    state.jobs.push(job);
    state.descriptions.set(jobId, overrides.description ?? description);
    server.briefs.set(jobKey(ESCROW, jobId), {
      brief: { ...brief, ...overrides.brief },
      provider,
    });
    return { job, brief: { ...brief, ...overrides.brief } as JobBrief };
  };
  return { provider: providerInstance, signer, chain, state, server, addJob };
}

const decode = (bytes: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>;

describe("provider modes and config", () => {
  it("parses one work mode and one behaviour mode, and refuses anything else", () => {
    expect(parseModes(["placeholder", "honest"], ["placeholder"])).toEqual({
      work: "placeholder",
      behaviour: "honest",
    });
    for (const bad of [
      ["placeholder"],
      ["honest"],
      ["placeholder", "honest", "junk"],
      ["placeholder", "honest", "fix-it"],
      ["placeholder", "placeholder", "honest"],
      [],
    ])
      expect(() => parseModes(bad, ["placeholder"])).toThrow(ProviderModeError);
  });

  it("names exactly CZ-20 §5.11's seven behaviour modes", () => {
    expect([...BEHAVIOUR_MODES]).toEqual([
      "honest",
      "junk",
      "silent",
      "early-submit",
      "over-budget",
      "late",
      "no-upload",
    ]);
  });

  it("has the merchants.provider.* defaults: placeholder + honest for both, 60 s, 2 s poll", () => {
    const config = loadConfig();
    expect(config.get("merchants.provider.enabled")).toBe(true);
    for (const instance of ["czar-provider-a", "czar-provider-b"] as const) {
      expect(config.get(`merchants.provider.${instance}.modes`)).toEqual(["placeholder", "honest"]);
      expect(config.get(`merchants.provider.${instance}.minWorkSeconds`)).toBe(60);
    }
    expect(config.get("merchants.provider.pollMs")).toBe(2000);
  });

  it("composes both instances on a test chain, each with its own key; none on a mainnet or when disabled", async () => {
    const server = serverDouble({ chainId: CHAIN_ID, verify: false, nowSeconds: () => START });
    const signer = fakeSigner(server.accepted);
    const { chain } = fakeChain({ fundUpTo: BUDGET_CAP });
    const base = {
      evaluator: K7,
      signer,
      chain,
      server: createHttpJobServer({ baseUrl: "http://127.0.0.1:3000", fetch: server.fetch }),
    };
    const on = composeProviders({ ...base, config: loadConfig(), chainId: CHAIN_ID });
    expect(on.instances.map((i) => [i.instance, i.workMode, i.behaviour])).toEqual([
      ["czar-provider-a", "placeholder", "honest"],
      ["czar-provider-b", "placeholder", "honest"],
    ]);
    expect(await Promise.all(on.instances.map((i) => i.start()))).toEqual([K21A, K21B]);
    expect(
      composeProviders({ ...base, config: loadConfig(), chainId: 31337 }).instances,
    ).toHaveLength(2);
    for (const mainnet of [1, 8453, 5042001])
      expect(
        composeProviders({ ...base, config: loadConfig(), chainId: mainnet }).instances,
      ).toEqual([]);
    const off = loadConfig({ envFile: { "merchants.provider.enabled": false } });
    expect(composeProviders({ ...base, config: off, chainId: CHAIN_ID }).instances).toEqual([]);
    const modes = loadConfig({
      envFile: { "merchants.provider.czar-provider-b.modes": ["placeholder", "silent"] },
    });
    expect(
      composeProviders({ ...base, config: modes, chainId: CHAIN_ID }).instances.map(
        (i) => i.behaviour,
      ),
    ).toEqual(["honest", "silent"]);
  });

  it("labels each instance's index entry as a Czar test provider", () => {
    const entry = providerIndexEntry({
      instance: "czar-provider-b",
      network: "eip155:5042002",
      providerAddress: K21B,
      escrow: ESCROW,
      workModes: DEFAULT_WORK_MODES,
    });
    expect(entry.serviceName).toBe("czar-provider-b");
    expect(entry.description).toContain("Czar test provider");
    expect(entry.metadata.provider.name).toBe("Czar test provider");
    expect(entry.extensions.czar).toMatchObject({
      source: "czar-test-merchant",
      testMerchant: true,
    });
    expect(entry.extensions.czar.serviceId).toMatch(/^svc_[0-9a-f]{32}$/);
  });
});

describe("provider loop refusals (CZ-20 §5.11 steps 2–3)", () => {
  it("an injected provider address must be the signing key's: otherwise nothing is sent", async () => {
    const t = setup({ providerAddress: K21A });
    expect(await t.provider.start()).toBe(K21A);
    const wrong = setup({ instance: "czar-provider-b", providerAddress: K21A });
    await wrong.provider.start();
    const { job } = wrong.addJob();
    // The job names the injected address as provider; the signature recovers to K21b, so the instance stops.
    expect(await wrong.provider.handle({ ...job, provider: K21A })).toMatchObject({
      outcome: "failed",
      rule: "provider-address-mismatch",
    });
    expect(wrong.signer.actions()).toEqual(["brief-request"]);
    expect(wrong.server.requests).toEqual([]);
    expect(wrong.state.sent).toEqual([]);
  });

  it("refuses a job whose evaluator is not K7, before any signature", async () => {
    const t = setup();
    await t.provider.start();
    const { job } = t.addJob({ evaluator: OTHER });
    const outcome = await t.provider.handle(job);
    expect(outcome).toMatchObject({ outcome: "refused", rule: "evaluator-not-k7" });
    expect(t.signer.calls).toEqual([]);
    expect(t.state.sent).toEqual([]);
  });

  it("refuses a brief whose descriptionHash does not match the chain", async () => {
    const t = setup();
    await t.provider.start();
    const { job } = t.addJob({ description: `czar:0x${"ab".repeat(32)}` });
    expect(await t.provider.handle(job)).toMatchObject({
      outcome: "refused",
      rule: "description-hash-mismatch",
    });
    expect(t.signer.actions()).toEqual(["brief-request"]);
    expect(t.state.sent).toEqual([]);
  });

  it("refuses a brief whose inputCommit does not recompute", async () => {
    const t = setup();
    await t.provider.start();
    const { job } = t.addJob({ brief: { inputCommit: `0x${"cd".repeat(32)}` } });
    expect(await t.provider.handle(job)).toMatchObject({
      outcome: "refused",
      rule: "input-commit-mismatch",
    });
    expect(t.state.sent).toEqual([]);
  });

  it("refuses a brief for another job, chain or evaluator, and a brief that is not a JobBrief", async () => {
    for (const brief of [
      { jobId: "999" },
      { network: "eip155:1" },
      { evaluator: OTHER },
      { expiredAt: EXPIRED_AT + 1 },
    ] as Partial<JobBrief>[]) {
      const t = setup();
      await t.provider.start();
      const { job } = t.addJob({ brief });
      expect(await t.provider.handle(job)).toMatchObject({
        outcome: "refused",
        rule: "brief-mismatch",
      });
      expect(t.state.sent).toEqual([]);
    }
    const t = setup();
    await t.provider.start();
    const { job } = t.addJob({ brief: { schemaVersion: "9.9" } as unknown as Partial<JobBrief> });
    expect(await t.provider.handle(job)).toMatchObject({
      outcome: "refused",
      rule: "brief-invalid",
    });
  });

  it("refuses a submitBy closer than minWorkSeconds", async () => {
    const t = setup({ brief: { submitBy: START + 59 } });
    await t.provider.start();
    const { job } = t.addJob();
    expect(await t.provider.handle(job)).toMatchObject({
      outcome: "refused",
      rule: "submit-by-too-close",
    });
    expect(t.signer.actions()).toEqual(["brief-request"]);
  });

  it("refuses a job its work mode cannot deliver (the placeholder needs JSON without a schema)", async () => {
    const t = setup({ brief: { mimeType: "text/csv" } });
    await t.provider.start();
    const { job } = t.addJob();
    expect(await t.provider.handle(job)).toMatchObject({
      outcome: "refused",
      rule: "work-mode-cannot-deliver",
    });
    expect(t.state.sent).toEqual([]);
  });
});

describe("behaviour modes: the calls each one makes", () => {
  it("honest: brief → setBudget(targetBudget) → funded → upload → submit(keccak256(bytes)) before submitBy", async () => {
    const t = setup();
    await t.provider.start();
    const { job, brief } = t.addJob();
    const outcome = await t.provider.handle(job);
    expect(t.signer.actions()).toEqual([
      "brief-request",
      "setBudget",
      "deliverable-upload",
      "submit",
    ]);
    expect(t.state.sent.map((s) => s.action)).toEqual(["setBudget", "submit"]);
    expect(t.state.sent[0]?.args).toEqual({ amount: TARGET.toString() });
    const upload = t.server.uploads[0];
    expect(upload).toBeDefined();
    expect(t.state.sent[1]?.args).toEqual({ contentHash: keccak256(upload?.bytes as Uint8Array) });
    expect(t.state.sent[1]?.at).toBeLessThan(SUBMIT_BY);
    const body = decode(upload?.bytes as Uint8Array);
    for (const key of brief.deliverable.expectedKeys ?? []) expect(body[key]).toMatch(/\S/);
    expect(outcome).toMatchObject({
      outcome: "submitted",
      budget: TARGET,
      contentHash: upload?.contentHash,
    });
    // Signer args carry only what the provider chooses (PM-058): no token, optParams or jobKey.
    expect(t.signer.calls.map((c) => Object.keys(c.args).toSorted())).toEqual([
      ["issuedAt"],
      ["amount"],
      ["contentHash", "issuedAt"],
      ["contentHash"],
    ]);
  });

  it("the placeholder deliverable is deterministic", async () => {
    const { brief } = makeBrief({
      escrow: ESCROW,
      jobId: 7n,
      chainId: CHAIN_ID,
      evaluator: K7,
      expiredAt: EXPIRED_AT,
      submitBy: SUBMIT_BY,
      budgetCap: BUDGET_CAP,
      targetBudget: TARGET,
    });
    const a = await placeholderWorkMode.produce(brief);
    const b = await placeholderWorkMode.produce(brief);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it("junk: the same calls, with well-formed JSON whose expected keys are empty (fails the requirement check)", async () => {
    const t = setup({ behaviour: "junk" });
    await t.provider.start();
    const { job, brief } = t.addJob();
    const outcome = await t.provider.handle(job);
    expect(t.signer.actions()).toEqual([
      "brief-request",
      "setBudget",
      "deliverable-upload",
      "submit",
    ]);
    const body = decode(t.server.uploads[0]?.bytes as Uint8Array);
    expect(Object.keys(body)).toEqual(brief.deliverable.expectedKeys);
    for (const value of Object.values(body)) expect(value).toBe("");
    expect(outcome).toMatchObject({ outcome: "submitted" });
  });

  it("junk refuses a brief without expected keys (nothing would fail)", async () => {
    const t = setup({ behaviour: "junk", brief: { expectedKeys: [] } });
    await t.provider.start();
    const { job } = t.addJob();
    expect(await t.provider.handle(job)).toMatchObject({
      outcome: "refused",
      rule: "junk-needs-expected-keys",
    });
    expect(t.server.uploads).toEqual([]);
  });

  it("silent: fetches the brief and never sets a budget", async () => {
    const t = setup({ behaviour: "silent" });
    await t.provider.start();
    const { job } = t.addJob();
    expect(await t.provider.handle(job)).toMatchObject({
      outcome: "stopped",
      rule: "silent-no-budget",
    });
    expect(t.signer.actions()).toEqual(["brief-request"]);
    expect(t.state.sent).toEqual([]);
  });

  it("early-submit: uploads and submits with no setBudget and no funding (zero-budget submit)", async () => {
    const t = setup({ behaviour: "early-submit" });
    await t.provider.start();
    const { job } = t.addJob();
    const outcome = await t.provider.handle(job);
    expect(t.signer.actions()).toEqual(["brief-request", "deliverable-upload", "submit"]);
    expect(t.state.sent.map((s) => s.action)).toEqual(["submit"]);
    expect(t.state.funded.size).toBe(0);
    expect(outcome).toMatchObject({ outcome: "submitted" });
    expect(outcome.budget).toBeUndefined();
  });

  it("over-budget: sets budgetCap + 1, is never funded, and gives up at submitBy", async () => {
    const t = setup({ behaviour: "over-budget" });
    await t.provider.start();
    const { job } = t.addJob();
    const outcome = await t.provider.handle(job);
    expect(t.signer.actions()).toEqual(["brief-request", "setBudget"]);
    expect(t.state.sent).toEqual([
      expect.objectContaining({
        action: "setBudget",
        args: { amount: (BUDGET_CAP + 1n).toString() },
      }),
    ]);
    expect(t.state.funded.size).toBe(0);
    expect(outcome).toMatchObject({
      outcome: "abandoned",
      rule: "not-funded",
      budget: BUDGET_CAP + 1n,
    });
    expect(t.state.now).toBeGreaterThanOrEqual(SUBMIT_BY);
  });

  it("late: the honest calls, with submit sent after submitBy (and before expiredAt)", async () => {
    const t = setup({ behaviour: "late" });
    await t.provider.start();
    const { job } = t.addJob();
    const outcome = await t.provider.handle(job);
    expect(t.signer.actions()).toEqual([
      "brief-request",
      "setBudget",
      "deliverable-upload",
      "submit",
    ]);
    const submit = t.state.sent.find((s) => s.action === "submit");
    expect(submit?.at).toBeGreaterThan(SUBMIT_BY);
    expect(submit?.at).toBeLessThan(EXPIRED_AT);
    expect(outcome).toMatchObject({ outcome: "submitted" });
  });

  it("no-upload: asks to submit a hash it never uploaded; the signer refuses with deliverable-not-accepted", async () => {
    const t = setup({ behaviour: "no-upload" });
    await t.provider.start();
    const { job } = t.addJob();
    const outcome = await t.provider.handle(job);
    expect(t.signer.actions()).toEqual(["brief-request", "setBudget", "submit"]);
    expect(t.server.uploads).toEqual([]);
    expect(t.state.sent.map((s) => s.action)).toEqual(["setBudget"]);
    expect(outcome).toMatchObject({ outcome: "refused", rule: "deliverable-not-accepted" });
    expect(outcome.contentHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("a reverted setBudget fails the job and nothing more is sent", async () => {
    const t = setup();
    await t.provider.start();
    t.state.status = "reverted";
    const { job } = t.addJob();
    expect(await t.provider.handle(job)).toMatchObject({
      outcome: "failed",
      rule: "setbudget-reverted",
    });
    expect(t.state.sent.map((s) => s.action)).toEqual(["setBudget"]);
  });
});

describe("watching and one job at a time", () => {
  it("tick picks up only its own JobCreated, once, and runs queued jobs one after another", async () => {
    const t = setup();
    await t.provider.start();
    t.addJob();
    t.addJob();
    // Another provider's job in between is never picked up.
    t.state.jobs.push({
      escrow: ESCROW,
      abi: "czar",
      jobId: 99n,
      client: CLIENT,
      provider: OTHER,
      evaluator: K7,
      expiredAt: BigInt(EXPIRED_AT),
      blockNumber: t.state.block,
    });
    const outcomes = await t.provider.tick();
    expect(outcomes.map((o) => [o.jobId, o.outcome])).toEqual([
      [1n, "submitted"],
      [2n, "submitted"],
    ]);
    // Sequential: job 2's brief request comes after job 1's submit.
    const actions = t.signer.calls.map((c) => c.action);
    expect(actions).toEqual([
      "brief-request",
      "setBudget",
      "deliverable-upload",
      "submit",
      "brief-request",
      "setBudget",
      "deliverable-upload",
      "submit",
    ]);
    expect(await t.provider.tick()).toEqual([]);
  });

  it("instance b signs as czar-provider-b with K21b", async () => {
    const t = setup({ instance: "czar-provider-b" });
    expect(await t.provider.start()).toBe(K21B);
    const { job } = t.addJob();
    await t.provider.handle(job);
    expect(new Set(t.signer.calls.map((c) => c.caller))).toEqual(new Set(["czar-provider-b"]));
  });
});

describe("work modes are added inside provider/ only (T-108)", () => {
  it("a dummy work mode given to createProviderInstance runs the loop with no other change", async () => {
    const dummy: WorkMode = {
      id: "dummy-echo",
      capabilities: ["dummy-capability"],
      accepts: (brief) => brief.deliverable.mimeType === "application/json",
      produce: async (brief) =>
        new TextEncoder().encode(
          JSON.stringify(
            Object.fromEntries((brief.deliverable.expectedKeys ?? []).map((k) => [k, "dummy"])),
          ),
        ),
    };
    const t = setup({ workModes: [...DEFAULT_WORK_MODES, dummy], work: "dummy-echo" });
    expect(t.provider.workMode).toBe("dummy-echo");
    await t.provider.start();
    const { job } = t.addJob();
    expect(await t.provider.handle(job)).toMatchObject({ outcome: "submitted" });
    expect(decode(t.server.uploads[0]?.bytes as Uint8Array)).toEqual({ price: "dummy" });
    expect(
      providerIndexEntry({
        instance: "czar-provider-a",
        network: "eip155:5042002",
        providerAddress: K21A,
        escrow: ESCROW,
        workModes: [dummy],
      }).tags,
    ).toEqual(["dummy-capability"]);
    // Without the mode in the list the name is refused, not guessed.
    expect(() => setup({ work: "dummy-echo" })).toThrow(ProviderModeError);
  });
});
