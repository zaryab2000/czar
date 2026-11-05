// PM-017: the signer's cloud entry point. A cloud-shaped parameter file points at loopback fakes, so
// nothing here reaches a real RPC, a real Cloud KMS or the metadata server, and no transaction is sent.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "@czar/logging";
import {
  CLOUD_CONFIG_POINTER,
  CLOUD_MERCHANT_SERVICES,
  DATABASE_URL_POINTER,
  RPC_URL_POINTER,
  logAlertPort,
  startCloudSigner,
  type CloudChainClient,
  type CloudSignerDatabase,
} from "../src/cloud-main.ts";
import { createSignerClient } from "../src/socket.ts";
import { fileSignerIdentity } from "../src/file-identity.ts";
import { startFakeKms, startFakeMetadata, type FakeKms } from "./kms-fake.ts";

const ARC_TESTNET = 5042002;
const ARC_RPC_URL = "https://rpc.testnet.arc.io";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const address = (byte: string) => `0x${byte.repeat(40)}`;

/** A stub Arc client: no request leaves the process. */
function stubChain(chainId = ARC_TESTNET) {
  return {
    getChainId: async () => chainId,
    getBalance: async () => 10n ** 21n,
    estimateGas: async () => 200_000n,
    prepareTransactionRequest: async () => {
      throw new Error("unexpected transaction preparation");
    },
    sendRawTransaction: async () => {
      throw new Error("unexpected transaction broadcast");
    },
    waitForTransactionReceipt: async () => {
      throw new Error("unexpected receipt wait");
    },
    getBlock: async () => ({ timestamp: 0n }),
    getBlockNumber: async () => 0n,
    getTransactionReceipt: async () => {
      throw new Error("unexpected receipt read");
    },
    readContract: async () => 0n,
  } as unknown as CloudChainClient;
}

const database: CloudSignerDatabase = {
  async query() {
    return { rows: [] };
  },
};

interface CloudFixture {
  readonly dir: string;
  readonly kms: FakeKms;
  readonly socketPath: string;
  readonly env: Record<string, string>;
  readonly tokens: Record<string, string>;
  readonly keyVersions: Record<string, string>;
}

async function cloudFixture(
  overrides: Readonly<Record<string, string>> = {},
  options: { readonly rpcUrl?: string } = {},
): Promise<CloudFixture> {
  const dir = await mkdtemp(join(tmpdir(), "czar-signer-cloud-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const kms = await startFakeKms();
  cleanups.push(kms.close);
  const metadata = await startFakeMetadata();
  cleanups.push(metadata.close);

  const credentials = join(dir, "secrets");
  const clientTokens = join(credentials, "signer", "client-tokens");
  await mkdir(clientTokens, { recursive: true, mode: 0o700 });
  const tokens: Record<string, string> = {};
  for (const service of ["server", "merchants", "relayer-jobs"]) {
    tokens[service] = randomBytes(24).toString("hex");
    const path = join(clientTokens, service);
    await writeFile(path, tokens[service] as string, { mode: 0o400 });
    await chmod(path, 0o400);
  }

  const keyVersions: Record<string, string> = {};
  for (const keyRef of ["K3", "K5", "K7", "K8", "K10:czar-search", "relayer"])
    keyVersions[keyRef] = kms.addKey(kms.keyRing, keyRef.replace(":", "-")).versionName;

  const deploymentPath = join(dir, "arc-testnet.json");
  await writeFile(
    deploymentPath,
    JSON.stringify({
      chainId: ARC_TESTNET,
      CzarVaultFactory: address("1"),
      OpenEvidenceLog: address("2"),
      usdc: address("3"),
      gatewayWallet: address("4"),
      gatewayMinter: address("5"),
      gatewayDomain: 26,
      jobEscrow: address("6"),
    }),
  );

  const socketPath = join(dir, "run", "signer.sock");
  const versionsTable = Object.entries(keyVersions)
    .map(([keyRef, name]) => `"${keyRef}" = "${name}"`)
    .join(", ");
  const parameters: Record<string, string> = {
    "deploy.environment": '"cloud-testnet"',
    "deploy.allowedRpcHosts": '["rpc.testnet.arc.io"]',
    "deploy.credentialFilesDir": JSON.stringify(credentials),
    "deploy.deploymentFile": JSON.stringify(deploymentPath),
    "deploy.metadataTokenUrl": JSON.stringify(metadata.tokenUrl),
    "app.origin": '"https://app.example.com"',
    "merchants.publicOrigin": '"https://merchants.example.com"',
    "merchants.lab.enabled": "false",
    "selection.paymentNetwork": '"eip155:5042002"',
    "signer.backend": '"gcp-kms"',
    "signer.socketPath": JSON.stringify(socketPath),
    "signer.kms.apiBaseUrl": JSON.stringify(kms.baseUrl),
    "signer.kms.projectId": JSON.stringify(kms.projectId),
    "signer.kms.location": JSON.stringify(kms.location),
    "signer.kms.keyRing": JSON.stringify(kms.keyRing),
    "signer.kms.pocketKeyRing": JSON.stringify(kms.pocketKeyRing),
    "signer.kms.keyVersions": `{ ${versionsTable} }`,
    ...overrides,
  };
  const configPath = join(dir, "cloud.toml");
  await writeFile(
    configPath,
    Object.entries(parameters)
      .map(([key, value]) => `"${key}" = ${value}`)
      .join("\n"),
  );

  return {
    dir,
    kms,
    socketPath,
    tokens,
    keyVersions,
    env: {
      [CLOUD_CONFIG_POINTER]: configPath,
      [RPC_URL_POINTER]: options.rpcUrl ?? ARC_RPC_URL,
      [DATABASE_URL_POINTER]: "postgres://czar_signer@127.0.0.1:15432/postgres",
    },
  };
}

describe("signer cloud entry point (SCR-170 §3)", () => {
  it("refuses signer.backend = local-keystore", async () => {
    const f = await cloudFixture({ "signer.backend": '"local-keystore"' });
    await expect(
      startCloudSigner({
        env: f.env,
        argv: ["node", "cloud-main.ts"],
        chain: stubChain(),
        database,
      }),
    ).rejects.toMatchObject({ key: "signer.backend", message: /gcp-kms/ as unknown as string });
  });

  it("refuses a non-allowlisted RPC host before any RPC call", async () => {
    let chainIdReads = 0;
    const chain = {
      ...(stubChain() as object),
      getChainId: async () => {
        chainIdReads += 1;
        return ARC_TESTNET;
      },
    } as CloudChainClient;
    const f = await cloudFixture({}, { rpcUrl: "https://rpc.testnet.arc.network" });
    await expect(
      startCloudSigner({
        env: f.env,
        argv: ["node", "cloud-main.ts"],
        chain,
        database,
      }),
    ).rejects.toThrow(/deploy\.allowedRpcHosts/);
    expect(chainIdReads).toBe(0);
  });

  it("refuses a chain id the RPC reports that the deployment file does not", async () => {
    const f = await cloudFixture();
    await expect(
      startCloudSigner({
        env: f.env,
        argv: ["node", "cloud-main.ts"],
        chain: stubChain(31337),
        database,
      }),
    ).rejects.toThrow(/chain/);
  });

  it("refuses to start without the cloud config pointer", async () => {
    await expect(
      startCloudSigner({ env: {}, argv: ["node", "cloud-main.ts"], chain: stubChain(), database }),
    ).rejects.toThrow(new RegExp(CLOUD_CONFIG_POINTER));
  });

  it("refuses to start when the environment carries something that looks like a secret", async () => {
    const f = await cloudFixture();
    await expect(
      startCloudSigner({
        env: { ...f.env, CZAR_SIGNER_PASSPHRASE: "not-a-real-value" },
        argv: ["node", "cloud-main.ts"],
        chain: stubChain(),
        database,
      }),
    ).rejects.toThrow(/looks like a secret/);
  });

  it("starts with Cloud KMS keys and answers keyAddress over the socket", async () => {
    const f = await cloudFixture();
    const running = await startCloudSigner({
      env: f.env,
      argv: ["node", "cloud-main.ts"],
      chain: stubChain(),
      database,
    });
    try {
      expect(running.chainId).toBe(ARC_TESTNET);
      expect(running.keyRefs).toEqual(
        ["K10:czar-search", "K3", "K5", "K7", "K8", "relayer"].toSorted(),
      );
      const server = await createSignerClient({
        socketPath: f.socketPath,
        service: "server",
        identity: fileSignerIdentity(join(f.dir, "secrets", "signer", "client-tokens"), {
          services: ["server"],
        }),
      });
      const k3 = await server.keyAddress("cz-15", "K3");
      expect(k3).toMatch(/^0x[0-9a-f]{40}$/);
      expect(await server.keyAddress("cz-16", "K7")).toMatch(/^0x[0-9a-f]{40}$/);

      // The merchant services the cloud runs, so `K10:<service>` resolves for each of them.
      const merchants = await createSignerClient({
        socketPath: f.socketPath,
        service: "merchants",
        identity: fileSignerIdentity(join(f.dir, "secrets", "signer", "client-tokens"), {
          services: ["merchants"],
        }),
      });
      expect(await merchants.keyAddress("cz-20", "K10:czar-search")).toMatch(/^0x[0-9a-f]{40}$/);
      await expect(merchants.keyAddress("cz-20", "K10:not-a-service")).rejects.toMatchObject({
        rule: "key-not-allowed",
      });
      expect(CLOUD_MERCHANT_SERVICES).toContain("czar-spot");
      expect(CLOUD_MERCHANT_SERVICES).toContain("lab-spot-payee-swap");
      expect(CLOUD_MERCHANT_SERVICES).toHaveLength(9);

      // A wrong token is refused even with the socket reachable.
      const wrong = await createSignerClient({
        socketPath: f.socketPath,
        service: "server",
        identity: { tokenFor: async () => randomBytes(24).toString("hex") },
      });
      await expect(wrong.keyAddress("cz-15", "K3")).rejects.toMatchObject({
        rule: "service-token",
      });
    } finally {
      await running.stop();
    }
  }, 30_000);
});

describe("the cloud alert port", () => {
  it("logs signer_gas_low with the key id and never the message text", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: "signer",
      component: "CZ-27",
      sink: (line) => lines.push(line),
    });
    const alert = logAlertPort(logger);
    await alert("signer gas low for K7: below-min-after-refill");
    await alert("writeoff-manual-return-overdue vault=0x1 pocket=0x2");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      event: "signer_gas_low",
      keyId: "K7",
    });
    expect(lines[0]).not.toContain("below-min-after-refill");
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ event: "signer_alert_raised" });
    expect(lines[1]).not.toContain("writeoff");
  });
});
