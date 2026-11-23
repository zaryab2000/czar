import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

if (process.env["CZAR_SOCIAL_DEMO"] !== "1") {
  throw new Error("Set CZAR_SOCIAL_DEMO=1 for the authorized local demo.");
}
const serverRequire = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { Pool } = serverRequire("pg");
const { chromium } = webRequire("@playwright/test");
const { loadConfigFile, validateLocalOnlyConfig } = await import("@czar/config");
const { createPlanner } = await import("../../apps/server/src/planner/index.ts");
const { openIncidentsFor, overlayIncidents } =
  await import("../../apps/server/src/social/incidents.ts");
const { lessonsFor } = await import("../../apps/server/src/social/lessons.ts");
const { randomId } = await import("../../apps/server/src/http/ids.ts");

const network = "eip155:5042002";
const incidentService = "svc_223349701b9428c8a6dc42d8a7c99c4a";
const preferredService = `svc_${"a".repeat(32)}`;
const cleanService = `svc_${"b".repeat(32)}`;
const configPath = fileURLToPath(new URL("../../env/local.toml", import.meta.url));
const config = await loadConfigFile(configPath);
await validateLocalOnlyConfig({
  config,
  overlayPath: configPath,
  arcRpcUrl: "http://127.0.0.1:8545",
});
const pool = new Pool({ connectionString: "postgres://postgres@127.0.0.1:15433/postgres" });
const random = { bytes: randomBytes };
const id = (prefix) => randomId(prefix, random);
const hex = (value) => `0x${createHash("sha256").update(value).digest("hex")}`;
const taskSpec = {
  schemaVersion: "1.1",
  kind: "table-fill",
  topic: "Controlled search fixture",
  subjects: [{ label: "Synthetic example" }],
  fields: ["Result"],
  sourceTrust: "user-prompt",
  output: { format: "markdown-table", formatSource: "default" },
};

function decisionRows(mode, version) {
  const services =
    mode === "incident"
      ? [
          { serviceId: preferredService, score: 0.9 },
          { serviceId: incidentService, score: 0.95 },
        ]
      : [
          { serviceId: cleanService, score: 0.9 },
          { serviceId: preferredService, score: 0.89 },
        ];
  return services.map(({ serviceId, score }, index) => ({
    rank: index + 1,
    service_id: serviceId,
    version_id: version.get(serviceId),
    score,
    features: {},
    evidence_refs: [],
    evidence_age_days: 0,
    missing: [],
    badges: [],
    explanation: "Controlled deterministic ranking input",
  }));
}

function offerFor(serviceId) {
  const digit = serviceId === incidentService ? "1" : serviceId === preferredService ? "2" : "3";
  return {
    scheme: "exact",
    network,
    amount: "100000",
    asset: "0x3600000000000000000000000000000000000000",
    payTo: `0x${digit.repeat(40)}`,
    maxTimeoutSeconds: 60,
    extra: {},
  };
}

function serviceFor(serviceId) {
  return {
    serviceId,
    resource: { url: `https://controlled.example/${serviceId}`, method: "GET" },
    accepts: [offerFor(serviceId)],
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

function plannerFor(mode, version, capture) {
  return createPlanner({
    config,
    social: {
      openIncidentsFor: (scope, serviceIds, task) =>
        openIncidentsFor(pool, scope, serviceIds, task),
      lessonsFor: (userId, scope, task) => lessonsFor(pool, userId, scope, task),
    },
    ports: {
      ranking: {
        rank: async (query) => {
          const rows = decisionRows(mode, version);
          const incidents = await openIncidentsFor(
            pool,
            network,
            rows.map((row) => row.service_id),
            query.taskClass,
          );
          const ranked = overlayIncidents(rows, incidents);
          const decision = {
            schemaVersion: "1.3",
            query_id: randomUUID(),
            received_at: new Date().toISOString(),
            policy_version: "controlled-demo",
            snapshot_id: "controlled-demo-snapshot",
            snapshot_anchor_tx: hex("controlled:local-anchor"),
            query: { task: "search", constraints: {}, risk_quantile: 0.5, weights: {} },
            candidates_considered: ranked.length,
            excluded: [],
            ranked,
            unverified: [],
            missing_dimensions_for_class: [],
            insufficient_evidence: false,
          };
          capture.decision = decision;
          return decision;
        },
      },
      directory: { get: async (serviceId) => serviceFor(serviceId) },
      profiles: { profileIdFor: () => `prof_${"b".repeat(32)}` },
      pocketKeys: { createPocketKey: async () => `0x${"3".repeat(40)}` },
      agentHosts: { hasAgentHost: async () => true },
      allowance: { remaining: async () => "999999999" },
      health: {
        openOwnerFacts: async () => [],
        isInjectionBlocked: async () => false,
      },
      prober: {
        probe: async (resource) => {
          const serviceId = new URL(resource.url).pathname.slice(1);
          if (mode === "incident" && serviceId === preferredService) {
            return { ok: false, reason: "unavailable" };
          }
          return { ok: true, offers: [offerFor(serviceId)] };
        },
      },
    },
  });
}

async function ownerFor(mode) {
  if (mode === "lesson") {
    const found = await pool.query(
      `SELECT user_id FROM social_lessons WHERE service_id=$1 AND proposition='prefer'
       AND state='active' AND expires_at>now() ORDER BY created_at DESC LIMIT 1`,
      [preferredService],
    );
    if (!found.rows[0]) throw new Error("No active live prefer lesson for plan owner.");
    return found.rows[0].user_id;
  }
  return id("usr_");
}

async function persistPlan(mode, userId, deviceId, token, built) {
  const plan = built.plan;
  const submission = {
    schemaVersion: "1.0",
    objectiveId: plan.objectiveId,
    deviceId,
    soulVersionHash: hex("controlled:demo:soul"),
    observationHashes: [hex("controlled:demo:observation")],
    detector: "placeholder",
    goal: `Controlled ${mode} plan`,
    capabilities: ["web-search"],
    minutesSaved: 30,
    hourlyBand: "B",
    objectiveHash: plan.objectiveHash,
    redaction: { layer2: { hits: 0, entities: [] } },
    submittedAt: new Date().toISOString(),
    taskSpec,
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (mode === "incident") {
      await client.query("INSERT INTO users(user_id,network,controlled) VALUES($1,$2,true)", [
        userId,
        network,
      ]);
    }
    await client.query(
      `INSERT INTO devices(device_id,user_id,device_name,platform,token_hash)
       VALUES($1,$2,'Controlled plan browser','linux',$3)`,
      [deviceId, userId, randomBytes(32)],
    );
    await client.query(
      `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,
         state,plan_id,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,'awaiting-approval',$6,now(),now())`,
      [plan.objectiveId, userId, deviceId, submission, plan.objectiveHash, plan.planId],
    );
    await client.query(
      `INSERT INTO plans(plan_id,objective_id,plan,plan_hash,payee_root,state)
       VALUES($1,$2,$3,$4,$5,'offered')`,
      [plan.planId, plan.objectiveId, plan, plan.planHash, plan.payeeRoot],
    );
    await client.query(
      `INSERT INTO sessions(token_hash,user_id,expires_at)
       VALUES($1,$2,now()+interval '2 hours')`,
      [createHash("sha256").update(token).digest(), userId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function captureApproval(mode, planId, token) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript((value) => {
      sessionStorage.setItem("czar.appSession", value);
      sessionStorage.setItem("czar.appSessionExpiresAt", "2099-01-01T00:00:00.000Z");
    }, token);
    await page.route("**/v1/me", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          network,
          vaultCreated: true,
          frozen: false,
          paused: false,
          limits: [],
          balances: { free: "0", committed: "0", pocketOutstanding: "0", mscaBalance: "0" },
        }),
      }),
    );
    await page.goto(`http://localhost:3001/approve/${planId}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Review this plan" }).waitFor();
    const expected =
      mode === "incident"
        ? /This supplier has an open incident:/
        : /Your representative learned from .* did do this kind of task well/;
    await page.getByText(expected).waitFor({ timeout: 10000 });
    const name = mode === "incident" ? "04-incident-live-plan" : "07-prefer-live-plan";
    await page.screenshot({
      path: fileURLToPath(new URL(`./czar-social-demo-${name}.png`, import.meta.url)),
      fullPage: true,
    });
    if (mode === "lesson") {
      await page.goto("http://localhost:3001/social/me", { waitUntil: "networkidle" });
      await page.getByText(`prefer ${preferredService}`).first().waitFor();
      await page.getByRole("button", { name: "Dismiss" }).first().click();
      await page.getByText("(dismissed)").first().waitFor();
      await page.screenshot({
        path: fileURLToPath(new URL("./czar-social-demo-07-live-dismissed.png", import.meta.url)),
        fullPage: true,
      });
    }
  } finally {
    await browser.close();
  }
}

async function run(mode) {
  const versions = await pool.query(
    `SELECT service_id,version_id FROM service_versions
     WHERE network=$1 AND service_id=ANY($2::text[])`,
    [network, [incidentService, preferredService, cleanService]],
  );
  const version = new Map(versions.rows.map((row) => [row.service_id, row.version_id]));
  for (const serviceId of [incidentService, preferredService, cleanService]) {
    if (!version.has(serviceId)) throw new Error(`Missing controlled version for ${serviceId}.`);
  }
  const userId = await ownerFor(mode);
  const deviceId = id("dev_");
  const objectiveId = id("obj_");
  const token = randomBytes(32).toString("base64url");
  const capture = {};
  const built = await plannerFor(mode, version, capture).build({
    objectiveId,
    objectiveHash: hex(objectiveId),
    userId,
    deviceId,
    goal: "Find controlled search result",
    capabilities: ["web-search"],
    taskSpec,
    now: new Date(),
    random,
    ethGasPriceWei: 20_000_000_000n,
  });
  if (!built || !capture.decision) throw new Error(`Planner did not build ${mode} plan.`);
  const selected = built.plan.steps[0];
  if (mode === "incident") {
    if (!built.plan.approvalReasons?.includes("incident-open")) {
      throw new Error("Live incident did not require approval.");
    }
    if (selected?.serviceId !== incidentService) {
      throw new Error("Incident supplier was not chosen after clean candidate probe failed.");
    }
    if (capture.decision.ranked.at(-1)?.service_id !== incidentService) {
      throw new Error("Live incident supplier was not sorted below incident-free candidates.");
    }
  } else if (
    selected?.serviceId !== preferredService ||
    !selected.why?.lessons?.some((lesson) => lesson.serviceId === preferredService)
  ) {
    throw new Error("Live prefer lesson did not choose the near-tie supplier.");
  }
  await persistPlan(mode, userId, deviceId, token, built);
  const response = await fetch(`http://127.0.0.1:3000/v1/approvals/${built.plan.planId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status !== 200) throw new Error(`Live approval API HTTP ${response.status}.`);
  const served = await response.json();
  if (served.planHash !== built.plan.planHash) throw new Error("Served plan hash differed.");
  await captureApproval(mode, built.plan.planId, token);
  await writeFile(
    fileURLToPath(new URL(`./czar-social-demo-${mode}-plan-evidence.json`, import.meta.url)),
    JSON.stringify(
      {
        mode,
        controlled: true,
        injected: ["ranking candidates and scores", "directory entries", "probe outcomes"],
        live: ["incident and lesson reads", "planner build", "persisted plan", "approval API"],
        ranked: capture.decision.ranked.map((row) => ({
          rank: row.rank,
          serviceId: row.service_id,
          score: row.score,
          badges: row.badges,
        })),
        selectedServiceId: selected.serviceId,
        approvalReasons: built.plan.approvalReasons ?? [],
        lessons: selected.why?.lessons ?? [],
        planId: built.plan.planId,
        planHash: built.plan.planHash,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`Persisted and captured live local ${mode} approval plan.\n`);
}

try {
  const modes = process.argv[2] ? [process.argv[2]] : ["incident", "lesson"];
  for (const mode of modes) {
    if (mode !== "incident" && mode !== "lesson")
      throw new Error("Mode must be incident or lesson.");
    await run(mode);
  }
} finally {
  await pool.end();
}
