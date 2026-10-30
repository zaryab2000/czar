// SCR-150 §5 run 6: the real Czar server (createApp), the real indexer API router and a real
// Postgres database, seeded with manual-return rows for three users, so the manual-return UI is
// exercised through the real `GET /v1/pockets/manual-returns` route with AppSession auth.
// Chain reads go to a pinned clean `arc-anvil` (USDC is predeployed there). The Czar contracts are
// deployed on it with contracts/script/deploy.sh, and owners A and B get real vaults from the
// deployed CzarVaultFactory, so `/v1/me` reads real factory and vault state. Every seeded vault
// address is the factory's `predictVault(msca)` for that owner.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createWalletClient, http, keccak256 } from "viem";
import { czarVaultFactoryAbi, withFeeFloor } from "@czar/vault-client";
import { createApp } from "../../server/src/app.ts";
import { migrate } from "../../server/src/db/migrate.ts";
import { digest } from "../../server/src/http/auth.ts";
import { createIndexerApi } from "../../indexer/src/api/router.ts";
import { loadConfig } from "../../server/node_modules/@czar/config/src/index.ts";
import { RUN6 } from "./run6-data.ts";

const CONTRACTS_DIR = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const KEYS_PATH = fileURLToPath(new URL("../../../deployments/.run6-keys.json", import.meta.url));
// arc-anvil's first unlocked development account deploys and creates the vaults.
const ANVIL_SENDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// Public addresses only: no Czar role signs anything in run 6.
const ROLE_ADDRESSES = {
  K3: "0x0000000000000000000000000000000000006003",
  K5: "0x0000000000000000000000000000000000006005",
  K6: "0x0000000000000000000000000000000000006006",
  K7: "0x0000000000000000000000000000000000006007",
  K20: "0x0000000000000000000000000000000000006020",
};

const serverRequire = createRequire(new URL("../../server/package.json", import.meta.url));
const { Pool } = serverRequire("pg");

const databaseRoot =
  process.env["CZAR_TEST_DATABASE_URL"] ?? "postgres://postgres@127.0.0.1:15432/postgres";
const rpcUrl = RUN6.rpcUrl;
const arcForge = process.env["ARC_FORGE"] ?? "arc-forge";
const sessionTokens = {
  ownerA: process.env["CZAR_RUN6_TOKEN_A"],
  ownerB: process.env["CZAR_RUN6_TOKEN_B"],
};
for (const name of Object.keys(process.env)) {
  if (name.startsWith("CZAR_")) delete process.env[name];
}
if (!sessionTokens.ownerA || !sessionTokens.ownerB) {
  throw new Error("CZAR_RUN6_TOKEN_A and CZAR_RUN6_TOKEN_B must be set by the Playwright config.");
}

async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

// Refuse anything but a fresh local arc-anvil node: deploy.sh never runs against existing state.
await rpc("anvil_nodeInfo", []);
if ((await rpc("eth_blockNumber", [])) !== "0x0") {
  throw new Error("Refusing to deploy the Czar contracts on an arc-anvil that already has blocks.");
}
const deployment = await deployContracts();
const vaults = await RUN6.deployedVaults(deployment.factory);
await createVaults(deployment.factory, [RUN6.ownerA, RUN6.ownerB]);

const databaseName = `czar_run6_${randomBytes(8).toString("hex")}`;
const admin = new Pool({ connectionString: databaseRoot });
await admin.query(`CREATE DATABASE "${databaseName}"`);
const databaseUrl = new URL(databaseRoot);
databaseUrl.pathname = `/${databaseName}`;
const pool = new Pool({ connectionString: databaseUrl.toString() });
await migrate(pool);
await seed(pool);

const indexerStore = {
  async vaultByOwner(owner) {
    const user = [RUN6.ownerA, RUN6.ownerB].find(
      (candidate) => candidate.msca === owner.toLowerCase(),
    );
    if (!user) return null;
    return {
      id: vaultOf(user.msca),
      vault: vaultOf(user.msca),
      owner: user.msca,
      version: 1,
      agentSigner: RUN6.zero,
      autonomySigner: RUN6.zero,
      evaluator: RUN6.zero,
      createdBlock: 1n,
    };
  },
  async envelopeByRef(envelopeRef) {
    const vaultB = vaultOf(RUN6.ownerB.msca);
    return envelopeRef === RUN6.envelopeRef(vaultB, 1) ? RUN6.envelopeDetail(vaultB) : null;
  },
  async envelopesForVault() {
    return [];
  },
  async receiptsForLedger() {
    return [];
  },
};
const indexer = createIndexerApi(
  new Proxy(indexerStore, {
    get(target, property) {
      if (property in target) return target[property];
      return async () => [];
    },
  }),
);
indexer.get("/health", (context) => context.json({ ready: true }));

const app = createApp({
  pool,
  config: loadConfig({
    env: {
      CZAR_APP_CIRCLE_CLIENT_URL: "http://127.0.0.1:4337",
      CZAR_APP_CIRCLE_CLIENT_KEY: "run6-public-client-key",
      CZAR_APP_ARC_RPC_URL: rpcUrl,
      CZAR_APP_ORIGIN: RUN6.webOrigin,
    },
  }),
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  clock: { now: () => new Date() },
  random: { bytes: randomBytes },
  vaultFactory: deployment.factory,
  appReadOptions: {
    rpcUrl,
    factoryAddress: deployment.factory,
    indexerUrl: `http://127.0.0.1:${RUN6.indexerPort}`,
  },
});

function listen(handler, port) {
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.method === "GET" && incoming.url === "/health") {
      outgoing.writeHead(200, { "Content-Type": "application/json" });
      outgoing.end('{"ready":true}');
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
      const request = new Request(`http://127.0.0.1:${port}${incoming.url ?? "/"}`, {
        method: incoming.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body, duplex: "half" }),
      });
      const response = await handler.fetch(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500, { "Content-Type": "application/problem+json" });
      outgoing.end('{"title":"Internal Server Error","status":500}');
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}

const servers = [listen(indexer, RUN6.indexerPort), listen(app, RUN6.serverPort)];
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
    rmSync(RUN6.deploymentPath, { force: true });
    process.exit(0);
  });
}

/** Runs contracts/script/deploy.sh on the run 6 arc-anvil and checks the factory's runtime code. */
async function deployContracts() {
  rmSync(RUN6.deploymentPath, { force: true });
  writeFileSync(KEYS_PATH, `${JSON.stringify(roleKeys())}\n`, { mode: 0o600 });
  try {
    execFileSync(
      "bash",
      [
        "script/deploy.sh",
        rpcUrl,
        KEYS_PATH,
        RUN6.deploymentPath,
        "--offline",
        "--broadcast",
        "--unlocked",
        "--sender",
        ANVIL_SENDER,
      ],
      {
        cwd: CONTRACTS_DIR,
        stdio: ["ignore", "ignore", "inherit"],
        env: { ...process.env, ARC_FORGE: arcForge },
      },
    );
  } finally {
    rmSync(KEYS_PATH, { force: true });
  }
  const deployed = RUN6.readDeployment();
  const runtime = await RUN6.chainClient.getCode({ address: deployed.factory });
  if (runtime === undefined || keccak256(runtime) !== deployed.factoryRuntimeHash) {
    throw new Error("The deployed CzarVaultFactory runtime code does not match deploy.sh output.");
  }
  return deployed;
}

function roleKeys() {
  return Object.fromEntries(
    Object.entries(ROLE_ADDRESSES).map(([role, address]) => [
      role,
      { address, ref: `run6-${role}` },
    ]),
  );
}

async function createVaults(factory, owners) {
  const wallet = createWalletClient({
    chain: RUN6.chainClient.chain,
    transport: http(rpcUrl),
    account: ANVIL_SENDER,
  });
  for (const owner of owners) {
    const hash = await wallet.writeContract({
      address: factory,
      abi: czarVaultFactoryAbi,
      functionName: "createVault",
      args: [owner.msca],
      ...withFeeFloor({ maxFeePerGas: await RUN6.chainClient.getGasPrice() }),
    });
    await RUN6.chainClient.waitForTransactionReceipt({ hash });
    const created = await RUN6.chainClient.readContract({
      address: factory,
      abi: czarVaultFactoryAbi,
      functionName: "vaultOf",
      args: [owner.msca],
    });
    if (created.toLowerCase() !== vaultOf(owner.msca)) {
      throw new Error(`createVault for ${owner.msca} did not land at predictVault.`);
    }
  }
}

function vaultOf(msca) {
  const vault = vaults[msca];
  if (vault === undefined) throw new Error(`No predicted vault for seeded owner ${msca}.`);
  return vault;
}

async function seed(db) {
  for (const user of [RUN6.ownerA, RUN6.ownerB, RUN6.otherUser]) {
    await db.query("INSERT INTO users (user_id,msca,network,mode) VALUES ($1,$2,$3,'live')", [
      user.userId,
      user.msca,
      RUN6.network,
    ]);
    await db.query(
      "INSERT INTO devices (device_id,user_id,device_name,platform,token_hash) VALUES ($1,$2,$3,'macos',$4)",
      [user.deviceId, user.userId, "run6 seed", randomBytes(32)],
    );
    await db.query(
      `INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state,plan_id)
       VALUES ($1,$2,$3,'{}'::jsonb,$4,'executing',$5)`,
      [user.objectiveId, user.userId, user.deviceId, RUN6.hash("aa"), user.planId],
    );
    await db.query(
      `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state)
       VALUES ($1,$2,'{}'::jsonb,$3,$4,'approved')`,
      [user.planId, user.objectiveId, RUN6.hash("bb"), RUN6.hash("cc")],
    );
    for (const [index, row] of user.manualReturns.entries()) {
      await db.query(
        `INSERT INTO payer_pullback_gateway_failures
           (plan_id,step_index,envelope_ref,pocket,value,unavailable_since,state,vault_address,
            return_tx,return_block,return_log_index,returned_amount,manual_return_required_at,
            recorded_credit,recorded_tx,recorded_at)
         VALUES ($1,$2,$3,$4,$5,now() - interval '30 hours',$6,$7,$8,$9,$10,$5,
                 now() - ($11 * interval '1 minute'),$12,$13,
                 CASE WHEN $12::numeric IS NULL THEN NULL ELSE now() END)`,
        [
          user.planId,
          index,
          RUN6.envelopeRef(vaultOf(row.envelopeOwner ?? user.msca), 1),
          row.pocket,
          row.returnedAmount,
          row.state,
          vaultOf(user.msca),
          row.returnTx,
          100 + index,
          index,
          index,
          row.recordedCredit ?? null,
          row.recordedTx ?? null,
        ],
      );
    }
  }
  const expiresAt = new Date(Date.now() + RUN6.sessionMinutes * 60_000);
  for (const [token, user] of [
    [sessionTokens.ownerA, RUN6.ownerA],
    [sessionTokens.ownerB, RUN6.ownerB],
  ]) {
    await db.query("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)", [
      digest(token),
      user.userId,
      expiresAt,
    ]);
  }
}
