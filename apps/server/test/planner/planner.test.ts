import { createServer } from "node:http";
import { loadConfig } from "@czar/config";
import { buildTree, payeeLeaf, verifyProof } from "@czar/hashing";
import { encodeBase64Json, USDC_ADDRESS, type PaymentRequirements } from "@czar/x402";
import { describe, expect, it } from "vitest";
import {
  computeObjectiveGatewayVolume,
  createPlanner,
  recomputePlanHash,
} from "#src/planner/index";
import { createSafeProber } from "#src/planner/probe";
import { createRegisteredSelection } from "#src/selection/registered/index";
import { createPlannerProfileSource } from "#src/main";
import { localTemplateProfile } from "#src/acceptance/profile";
import { route, routingParamsFromConfig, cVd, pocketWorthIt } from "#src/router/index";
import type { PlannerPorts } from "#src/planner/ports";
import type { PlannerService } from "#src/planner/ports";
import type { RankingQuery } from "#src/planner/ports";

const taskSpec = {
  schemaVersion: "1.1" as const,
  kind: "table-fill" as const,
  topic: "Pricing",
  subjects: [{ label: "Acme" }],
  fields: ["Price"],
  sourceTrust: "user-prompt" as const,
};
const serviceId = `svc_${"a".repeat(32)}`;
const offer: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:5042002",
  amount: "1000000",
  asset: USDC_ADDRESS,
  payTo: `0x${"1".repeat(40)}`,
  maxTimeoutSeconds: 60,
  extra: {},
};

function fakeService(id = serviceId, accepted = offer): PlannerService {
  return {
    serviceId: id,
    resource: { url: `https://merchant.example/${id}`, method: "GET" },
    accepts: [accepted],
    extensions: {
      czar: {
        claim: { status: "domain-verified" },
        evidence: { deliveryLcb: 0.9, structuralLcb: 0.9, nEff: 8, badges: [] },
        source: "circle-live",
        card: { inputFields: [{ name: "query", type: "string" }] },
      },
    },
  };
}

function makePlanner(
  options: {
    readonly capabilities?: readonly string[];
    readonly subjects?: number;
    readonly gatewayEnabled?: boolean;
    readonly jobEnabled?: boolean;
    readonly proberOffers?: readonly PaymentRequirements[];
    readonly hasAgent?: boolean;
    readonly service?: PlannerService;
    readonly candidateCount?: number;
    readonly amount?: string;
    readonly rankingQueries?: RankingQuery[];
    readonly probeInput?: PlannerService["probeInput"];
    readonly probeCalls?: Array<{
      resource: PlannerService["resource"];
      probeInput?: PlannerService["probeInput"];
    }>;
    readonly profileSource?: PlannerPorts["profiles"];
    readonly health?: PlannerPorts["health"];
    readonly remaining?: string;
    readonly unrated?: boolean;
  } = {},
) {
  const spec = {
    ...taskSpec,
    subjects: Array.from({ length: options.subjects ?? 1 }, (_, i) => ({ label: `Subject ${i}` })),
  };
  const config = loadConfig({
    envFile: {
      ...(options.gatewayEnabled ? { "routing.gatewayEnabled": true } : {}),
      ...(options.jobEnabled ? { "routing.jobEnabled": true } : {}),
      "planner.newPayeeNeedsApproval": false,
    },
  });
  const planner = createPlanner({
    config,
    ports: {
      ranking: {
        rank: async (query) => {
          options.rankingQueries?.push(query);
          return {
            schemaVersion: "1.2",
            query_id: "query-1",
            received_at: "2026-10-21T00:00:00Z",
            policy_version: "test",
            snapshot_id: "snap_1",
            snapshot_anchor_tx: `0x${"1".repeat(64)}`,
            query: { task: "search", constraints: {}, risk_quantile: 0.5, weights: {} },
            candidates_considered: options.candidateCount ?? 1,
            excluded: [],
            ranked: Array.from(
              { length: options.unrated ? 0 : (options.candidateCount ?? 1) },
              (_, index) => ({
                rank: index + 1,
                service_id: `svc_${String.fromCharCode(97 + index).repeat(32)}`,
                version_id: "svcver_1",
                score: 0.9,
                features: {},
                evidence_refs: [],
                evidence_age_days: 0,
                missing: [],
                badges: [],
                explanation: "ranked",
              }),
            ),
            unverified: options.unrated
              ? [{ service_id: fakeService().serviceId, reason: "unrated", n_eff: 0 }]
              : [],
            missing_dimensions_for_class: [],
            insufficient_evidence: options.unrated ?? false,
            ...(options.unrated
              ? {
                  exploration_slot: {
                    service_id: fakeService().serviceId,
                    reason: "no-ranked-candidate",
                  },
                }
              : {}),
          };
        },
      },
      directory: {
        get: async (id) => {
          const service =
            options.service ??
            fakeService(id, {
              ...offer,
              amount: options.amount ?? offer.amount,
              payTo: `0x${id.slice(4, 5).repeat(40)}`,
            });
          return options.probeInput ? { ...service, probeInput: options.probeInput } : service;
        },
      },
      profiles: options.profileSource ?? { profileIdFor: () => `prof_${"b".repeat(32)}` },
      pocketKeys: { createPocketKey: async () => `0x${"3".repeat(40)}` },
      agentHosts: { hasAgentHost: async () => options.hasAgent ?? true },
      allowance: { remaining: async () => options.remaining ?? "0" },
      ...(options.health ? { health: options.health } : {}),
      prober: {
        probe: async (resource, probeInput) => {
          options.probeCalls?.push({ resource, ...(probeInput ? { probeInput } : {}) });
          const id = resource.url.split("/").at(-1) ?? serviceId;
          const live = {
            ...offer,
            amount: options.amount ?? offer.amount,
            payTo: `0x${id.slice(4, 5).repeat(40)}`,
          };
          return { ok: true as const, offers: options.proberOffers ?? [live] };
        },
      },
    },
  });
  let seed = 0;
  return planner.build({
    objectiveId: `obj_01K7ZT9P4N5Q6R7S8T9V0W1X2${seed++}`,
    objectiveHash: `0x${"2".repeat(64)}`,
    userId: "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
    deviceId: "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
    goal: "Find prices",
    capabilities: options.capabilities ?? ["web-search"],
    taskSpec: spec,
    now: new Date("2026-10-21T00:00:00.000Z"),
    random: { bytes: (length) => Buffer.alloc(length, 1) },
    ethGasPriceWei: 20_000_000_000n,
  });
}

describe("planner fallback", () => {
  it("uses the registered local-template-v1 profile for unpaid local steps", async () => {
    const profileSource = createPlannerProfileSource({
      profileIdFor(taskClass: string) {
        if (taskClass !== "data-json") throw new RangeError(`Unsupported ${taskClass}`);
        return `prof_${"a".repeat(32)}`;
      },
    } as never);

    await expect(
      makePlanner({ capabilities: ["table-build"], profileSource }),
    ).resolves.toMatchObject({
      plan: { steps: [{ acceptanceProfileId: localTemplateProfile().profile_id }] },
    });
  });

  it("keeps the paid web-search path on the seeded data-json profile", async () => {
    const profileSource = createPlannerProfileSource({
      profileIdFor: () => `prof_${"a".repeat(32)}`,
    } as never);

    await expect(makePlanner({ profileSource })).resolves.toMatchObject({
      plan: { steps: [{ acceptanceProfileId: `prof_${"a".repeat(32)}` }] },
    });
  });

  it("sums only paid Gateway volume and excludes job and unpaid steps", () => {
    expect(
      computeObjectiveGatewayVolume([
        { kind: "paid", expectedCalls: 5, gatewayUnitAmount: 8_000n },
        { kind: "paid", expectedCalls: 9 },
        { kind: "job", expectedCalls: 5, gatewayUnitAmount: 5_000_000n },
        { kind: "unpaid", expectedCalls: 5, gatewayUnitAmount: 5_000_000n },
      ]),
    ).toBe(40_000n);
  });

  it("computes V from every selected paid step's live Gateway offer", async () => {
    const gatewayOffers = [
      { ...offer, amount: "8000" },
      { ...offer, amount: "8000", extra: { name: "GatewayWalletBatched" } },
    ];
    const built = await makePlanner({
      capabilities: ["web-search", "page-extract", "web-search", "page-extract"],
      subjects: 5,
      gatewayEnabled: true,
      proberOffers: gatewayOffers,
    });

    expect(built?.plan.steps.map((step) => step.expectedCalls)).toEqual([5, 5, 5, 5]);
    expect(built?.plan.steps.map((step) => step.kind)).toEqual([
      "gateway-nano",
      "gateway-nano",
      "gateway-nano",
      "gateway-nano",
    ]);
  });

  it("plans a paid step with a payee leaf and verified root", async () => {
    const built = await makePlanner();
    expect(built).not.toBeNull();
    const plan = built!.plan;
    const step = plan.steps[0]!;
    expect(plan.payeeLeaves[0]).toMatchObject({
      payee: `0x${"a".repeat(40)}`,
      stepIndex: step.stepIndex,
      stepCap: step.stepCap,
    });
    const leaves = plan.payeeLeaves.map((leaf) =>
      payeeLeaf(leaf.payee as `0x${string}`, leaf.kind, leaf.stepIndex, BigInt(leaf.stepCap)),
    );
    const tree = buildTree(leaves);
    expect(tree.root).toBe(plan.payeeRoot);
    for (const leaf of leaves) expect(verifyProof(tree.proof(leaf), tree.root, leaf)).toBe(true);
    expect(plan.planHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(plan.planHash).toBe(recomputePlanHash(plan));
    expect(plan.pocketCapBps).toBe(0);
    expect(plan.payeeLeaves.some((leaf) => leaf.kind === 4)).toBe(false);
  });

  it("fans out one call input per subject", async () => {
    const built = await makePlanner({ subjects: 5 });
    expect(built?.plan.steps[0]?.callInputs).toHaveLength(5);
    expect(built?.plan.steps[0]?.callInputs?.map((call) => call.input["query"])).toEqual([
      "Subject 0 Pricing Price",
      "Subject 1 Pricing Price",
      "Subject 2 Pricing Price",
      "Subject 3 Pricing Price",
      "Subject 4 Pricing Price",
    ]);
  });

  it("commits only the selected payee while alternate attribution is unavailable", async () => {
    let state = 0x41c64e6d;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      const amount = String(100_000 + (state % 900_000));
      const built = await makePlanner({ candidateCount: 3, amount });
      expect(built).not.toBeNull();
      const plan = built!.plan;
      const step = plan.steps[0]!;
      expect(step.alternates).toEqual([]);
      expect(plan.payeeLeaves).toHaveLength(1);
      const leaves = plan.payeeLeaves.map((leaf) => {
        expect(leaf.stepIndex).toBe(step.stepIndex);
        expect(leaf.stepCap).toBe(step.stepCap);
        return payeeLeaf(
          leaf.payee as `0x${string}`,
          leaf.kind,
          leaf.stepIndex,
          BigInt(leaf.stepCap),
        );
      });
      const tree = buildTree(leaves);
      expect(tree.root).toBe(plan.payeeRoot);
      for (const leaf of leaves) expect(verifyProof(tree.proof(leaf), tree.root, leaf)).toBe(true);
    }
  });

  it("drops an agent-assist step when the device has no agent host", async () => {
    const built = await makePlanner({ capabilities: ["summarize"], hasAgent: false });
    expect(built?.plan.droppedSteps).toEqual([{ capability: "summarize", reason: "no-agent" }]);
    expect(built?.plan.steps).toEqual([]);
  });

  it("does not create a step when the live 402 lacks the selected network", async () => {
    const built = await makePlanner({ proberOffers: [{ ...offer, network: "eip155:1" }] });
    expect(built).toBeNull();
  });

  it("adds a kind-4 pocket leaf and enables pocket cap for gateway steps", async () => {
    const gateway = { ...offer, extra: { name: "GatewayWalletBatched" } };
    const built = await makePlanner({ proberOffers: [gateway], gatewayEnabled: true });
    expect(built?.plan.steps[0]?.kind).toBe("gateway-nano");
    expect(built?.plan.pocketCapBps).toBe(2500);
    expect(
      built?.plan.payeeLeaves.some((leaf) => leaf.kind === 4 && leaf.stepIndex === 4294967295),
    ).toBe(true);
  });

  it("does not plan a Gateway-only offer while routing.gatewayEnabled is false", async () => {
    const gateway = { ...offer, extra: { name: "GatewayWalletBatched" } };
    await expect(makePlanner({ proberOffers: [gateway] })).resolves.toBeNull();
  });

  it("marks exploration-slot suppliers as approval-required", async () => {
    const service = fakeService();
    const explored: PlannerService = {
      ...service,
      extensions: { czar: { ...service.extensions.czar, source: "exploration_slot" } },
    };
    const built = await makePlanner({ service: explored });
    expect(built?.approvalNeeded).toBe(true);
  });

  it("requires owner approval for an unrated paid supplier despite earned allowance", async () => {
    const built = await makePlanner({ remaining: "999999999", unrated: true });
    expect(built?.plan.approvalReasons).toContain("unrated");
    expect(built?.approvalNeeded).toBe(true);
  });

  it("uses real ranked evidence without adding an unrated approval reason", async () => {
    const built = await makePlanner({ remaining: "999999999" });
    expect(built?.plan.approvalReasons).toBeUndefined();
    expect(built?.approvalNeeded).toBe(false);
  });

  it("adds a health reason for the owner and excludes H4-blocked suppliers", async () => {
    const health = {
      openOwnerFacts: async () => ["settled-not-delivered" as const],
      isInjectionBlocked: async () => false,
    };
    const built = await makePlanner({ remaining: "999999999", health, unrated: true });
    expect(built?.plan.approvalReasons).toEqual(["unrated", "health-fact", "exploration-slot"]);
    expect(built?.approvalNeeded).toBe(true);
    expect(
      await makePlanner({
        health: { ...health, isInjectionBlocked: async () => true },
        unrated: true,
      }),
    ).toBeNull();
  });

  it("drops live price drift above the configured unit budget", async () => {
    const built = await makePlanner({ proberOffers: [{ ...offer, amount: "1000001" }] });
    expect(built).toBeNull();
  });

  it("rejects a directory entry whose service id does not match the ranked id", async () => {
    const invalid = { ...fakeService(), serviceId: "malformed-service-id" };
    expect(await makePlanner({ service: invalid })).toBeNull();
  });

  it("drops fallback capabilities without a default template", async () => {
    const built = await makePlanner({ capabilities: ["data-lookup"] });
    expect(built?.plan.droppedSteps).toEqual([
      { capability: "data-lookup", reason: "no-template" },
    ]);
  });

  it("plans claimed job providers with listed price, duration and task-only notice", async () => {
    const service = fakeService();
    const jobService: PlannerService = {
      ...service,
      providerAddress: `0x${"4".repeat(40)}`,
      listedPrice: "1000000",
      jobDurationSeconds: 5 * 24 * 60 * 60,
      extensions: {
        czar: {
          ...service.extensions.czar,
          claim: { status: "wallet-verified" },
          card: { rail: "erc8183-job", inputFields: [{ name: "query", type: "string" }] },
        },
      },
    };
    await expect(
      makePlanner({ service: jobService, capabilities: ["price-lookup"] }),
    ).resolves.toBeNull();
    const built = await makePlanner({
      service: jobService,
      capabilities: ["price-lookup"],
      jobEnabled: true,
    });
    expect(built?.plan.steps[0]).toMatchObject({
      kind: "erc8183-job",
      contextNotice: "task-description-only",
      unitAmount: "1000000",
    });
    expect(Date.parse(built!.plan.expiresAt)).toBeGreaterThan(
      Date.parse("2026-10-23T00:00:00.000Z"),
    );
    expect(built?.plan.payeeLeaves[0]).toMatchObject({
      payee: jobService.providerAddress,
      kind: 2,
    });
  });

  it("never plans a job for a provider address the provider has not proven (SCR-121)", async () => {
    const service = fakeService();
    const unproven: PlannerService = {
      ...service,
      providerAddress: `0x${"4".repeat(40)}`,
      listedPrice: "1000000",
      jobDurationSeconds: 3600,
      extensions: {
        czar: {
          ...service.extensions.czar,
          claim: { status: "domain-verified" },
          source: "circle-live",
          card: { rail: "erc8183-job", inputFields: [{ name: "query", type: "string" }] },
        },
      },
    };
    const built = await makePlanner({ service: unproven, capabilities: ["price-lookup"] });
    expect(
      (built?.plan.payeeLeaves ?? []).some((leaf) => leaf.payee === unproven.providerAddress),
    ).toBe(false);
  });

  it("sends registered GET and POST probeInput through safeFetch", async () => {
    const received: Array<{ url: string; method: string; body: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          url: request.url ?? "",
          method: request.method ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.statusCode = 402;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            x402Version: 1,
            accepts: [{ ...offer, maxAmountRequired: "1000000", resource: "http://127.0.0.1" }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const config = loadConfig({ envFile: { "fetch.localMerchantOrigins": [origin] } });
      const prober = createSafeProber(config);
      await expect(
        prober.probe({ url: `${origin}/search`, method: "GET" }, { query: { q: "fixed" } }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        prober.probe({ url: `${origin}/search`, method: "POST" }, { body: { q: "fixed" } }),
      ).resolves.toMatchObject({ ok: true });
      expect(received).toEqual([
        { url: "/search?q=fixed", method: "GET", body: "" },
        { url: "/search", method: "POST", body: '{"q":"fixed"}' },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("plans a web-search step for a registered service that declares a Bazaar q input", async () => {
    const resourceUrl = "https://merchant.example/v1/search";
    const challenge = {
      x402Version: 2,
      resource: { url: resourceUrl },
      accepts: [offer],
      extensions: {
        bazaar: {
          info: { input: { type: "http", method: "GET", queryParams: { q: "czar probe" } } },
          schema: {
            type: "object",
            properties: {
              input: {
                type: "object",
                properties: {
                  type: { type: "string", const: "http" },
                  method: { type: "string", enum: ["GET", "HEAD", "DELETE"] },
                  queryParams: {
                    type: "object",
                    properties: { q: { type: "string" } },
                    required: ["q"],
                  },
                },
                required: ["type", "method"],
                additionalProperties: false,
              },
            },
            required: ["input"],
          },
        },
      },
    };
    const selection = createRegisteredSelection({
      config: loadConfig({
        envFile: {
          "selection.czarRegisteredServices": {
            [serviceId]: {
              serviceName: "czar-search",
              resource: { url: resourceUrl, method: "GET" },
              probeInput: { query: { q: "czar probe" } },
              capabilities: ["web-search"],
            },
          },
        },
      }),
      safeFetch: async () => ({
        status: 402,
        url: resourceUrl,
        headers: { "payment-required": encodeBase64Json(challenge) },
        body: Buffer.from(""),
      }),
      pool: {} as never,
    });
    const service = await selection.directory.get(serviceId);
    if (!service) throw new Error("registered service probe failed");

    const built = await makePlanner({ service, subjects: 2, proberOffers: [offer] });

    expect(built?.plan.steps.map((step) => step.capability)).toEqual(["web-search"]);
    expect(built?.plan.steps[0]?.callInputs?.map((call) => call.input)).toEqual([
      { q: "Subject 0 Pricing Price" },
      { q: "Subject 1 Pricing Price" },
    ]);
  });

  it("planner_p03Input_noSellerText keeps seller text out of structured planner inputs", async () => {
    const rankingQueries: RankingQuery[] = [];
    await makePlanner({ rankingQueries });
    expect(rankingQueries).toHaveLength(1);
    expect(rankingQueries[0]?.userId).toBe("usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Y");
    expect(JSON.stringify(rankingQueries[0])).not.toContain("merchant.example");
    expect(rankingQueries[0]).not.toHaveProperty("goal");
    expect(rankingQueries[0]).not.toHaveProperty("description");
  });

  it("passes registered probeInput only to the unpaid probe", async () => {
    const probeCalls: Array<{
      resource: PlannerService["resource"];
      probeInput?: PlannerService["probeInput"];
    }> = [];
    const built = await makePlanner({
      probeInput: { query: { q: "fixed registration query" } },
      probeCalls,
    });

    expect(probeCalls[0]?.probeInput).toEqual({ query: { q: "fixed registration query" } });
    expect(JSON.stringify(built?.plan)).not.toContain("probeInput");
    expect(JSON.stringify(built?.plan.steps[0]?.callInputs)).not.toContain(
      "fixed registration query",
    );
  });

  it("preserves the router D37 hard rule over seeded random amounts", () => {
    const config = loadConfig({ envFile: { "routing.gatewayEnabled": true } });
    const params = routingParamsFromConfig(config);
    let state = 0x6d2b79f5;
    for (let index = 0; index < 10_000; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const amount = BigInt((state % 5_000_000) + 1);
      const volume = BigInt((Math.imul(state, 2_246_822_519) >>> 0) % 20_000_000);
      const gatewayOnly = index % 2 === 0;
      const offers = gatewayOnly
        ? [{ ...offer, extra: { name: "GatewayWalletBatched" } }]
        : [offer];
      const step = {
        stepIndex: 0,
        stepId: "stp_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
        capability: "web-search",
        kind: "x402-exact" as const,
        unitAmount: amount.toString(),
        expectedCalls: 1,
        stepCap: amount.toString(),
        routingReason: "test",
        acceptanceProfileId: `prof_${"b".repeat(32)}`,
      };
      const decision = route({
        step,
        offers,
        planNetwork: offer.network,
        unitAmount: amount,
        expectedCalls: 1,
        V: volume,
        supplierIsAgent: false,
        needsAcceptanceBeforePayment: false,
        eth_gasPrice: 20_000_000_000n,
        params,
      });
      const hasCostCoverage = !gatewayOnly && cVd(1, 20_000_000_000n, params) <= amount;
      const pocketIsWorthIt = pocketWorthIt(volume, 20_000_000_000n, params);
      if ("kind" in decision && decision.kind === "x402-exact") {
        expect(cVd(decision.calls, 20_000_000_000n, params)).toBeLessThanOrEqual(amount);
      } else if ("kind" in decision && decision.kind === "gateway-nano") {
        expect(pocketIsWorthIt).toBe(true);
      } else {
        expect(hasCostCoverage || (gatewayOnly && pocketIsWorthIt)).toBe(false);
      }
    }
  });
});
