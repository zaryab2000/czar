// Seed data shared by the run 6 fixture and spec (SCR-150 §5). Amounts are Amount6 strings.
// Vault addresses are not seed data: they are the deployed CzarVaultFactory's `predictVault`
// for each owner, read from the run 6 arc-anvil (see `deployedVaults`).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, defineChain, http, type Address, type Hex } from "viem";
import { czarVaultFactoryAbi } from "@czar/vault-client";

const ID_BODY = "01JRV6000000000000000000";

function id(prefix: string, suffix: string): string {
  return `${prefix}_${ID_BODY}${suffix}`;
}

function address(fill: string): string {
  return `0x${fill.repeat(40 / fill.length)}`;
}

function envelopeRef(vault: string, envelopeId: number): string {
  return `eip155:5042002:${vault}:${envelopeId}`;
}

function hash(byte: string): string {
  return `0x${byte.repeat(32)}`;
}

const ownerA = {
  userId: id("usr", "0A"),
  deviceId: id("dev", "0A"),
  objectiveId: id("obj", "0A"),
  planId: id("pln", "0A"),
  msca: address("a1"),
  manualReturns: [
    {
      pocket: address("a3"),
      returnedAmount: "1500000",
      returnTx: hash("a4"),
      state: "manual-return-required",
    },
    {
      pocket: address("a5"),
      returnedAmount: "2500000",
      returnTx: hash("a6"),
      state: "manual-return-required",
    },
    {
      pocket: address("a7"),
      returnedAmount: "700000",
      returnTx: hash("a8"),
      state: "recorded",
      recordedCredit: "700000",
      recordedTx: hash("a9"),
    },
  ],
};

const ownerB = {
  userId: id("usr", "0B"),
  deviceId: id("dev", "0B"),
  objectiveId: id("obj", "0B"),
  planId: id("pln", "0B"),
  msca: address("b1"),
  manualReturns: [
    {
      pocket: address("b3"),
      returnedAmount: "1234000",
      returnTx: hash("b4"),
      state: "manual-return-required",
    },
    {
      pocket: address("b5"),
      returnedAmount: "2000000",
      returnTx: hash("b6"),
      state: "recorded",
      recordedCredit: "1800000",
      recordedTx: hash("b7"),
    },
    {
      pocket: address("b8"),
      returnedAmount: "500000",
      returnTx: hash("b9"),
      state: "expired",
    },
  ],
};

// Another user's rows, including one on owner B's envelope reference, must never be shown.
const otherUser = {
  userId: id("usr", "0C"),
  deviceId: id("dev", "0C"),
  objectiveId: id("obj", "0C"),
  planId: id("pln", "0C"),
  msca: address("c1"),
  manualReturns: [
    {
      envelopeOwner: ownerB.msca,
      pocket: address("c3"),
      returnedAmount: "9876000",
      returnTx: hash("c4"),
      state: "manual-return-required",
    },
    {
      pocket: address("c5"),
      returnedAmount: "3300000",
      returnTx: hash("c6"),
      state: "manual-return-required",
    },
  ],
};

const CHAIN_ID = 5_042_002;
const RPC_URL = "http://127.0.0.1:18549";
const DEPLOYMENT_PATH = fileURLToPath(
  new URL("../../../deployments/.run6-deployment.json", import.meta.url),
);

export interface Run6Deployment {
  readonly factory: Address;
  readonly factoryRuntimeHash: Hex;
}

/** Reads the deploy.sh output the fixture wrote for this run's arc-anvil. */
function readDeployment(): Run6Deployment {
  const output = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as Record<string, unknown>;
  const factory = output["CzarVaultFactory"];
  const factoryRuntimeHash = output["factoryRuntimeHash"];
  if (typeof factory !== "string" || typeof factoryRuntimeHash !== "string") {
    throw new Error("Run 6 deployment output has no CzarVaultFactory or factoryRuntimeHash.");
  }
  return { factory: factory as Address, factoryRuntimeHash: factoryRuntimeHash as Hex };
}

const chainClient = createPublicClient({
  chain: defineChain({
    id: CHAIN_ID,
    name: "arc-anvil (run 6)",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  }),
  transport: http(RPC_URL),
});

/** Each seeded owner's vault: the deployed factory's `predictVault(msca)`, lower-cased. */
async function deployedVaults(factory: Address): Promise<Record<string, string>> {
  const vaults: Record<string, string> = {};
  for (const user of [ownerA, ownerB, otherUser]) {
    const predicted = await chainClient.readContract({
      address: factory,
      abi: czarVaultFactoryAbi,
      functionName: "predictVault",
      args: [user.msca as Address],
    });
    vaults[user.msca] = predicted.toLowerCase();
  }
  return vaults;
}

function envelopeDetail(vault: string) {
  return {
    envelope: {
      schemaVersion: "1.1",
      envelopeRef: envelopeRef(vault, 1),
      vault,
      envelopeId: 1,
      objectiveHash: hash("55"),
      planHash: hash("66"),
      payeeRoot: hash("77"),
      categoryId: hash("88"),
      cap: "4000000",
      maxStepAmount: "1000000",
      pocketCapBps: 5000,
      expiresAt: 1790000000,
      approver: "owner",
      approvalTx: hash("99"),
      spent: "0",
      reserved: "0",
      pocketOutstanding: "0",
      jobEscrowed: "0",
      state: "Open",
      lastEventBlock: 1,
    },
    reservations: [],
    pockets: [],
    jobs: [],
  };
}

export const RUN6 = {
  network: "eip155:5042002",
  chainId: CHAIN_ID,
  rpcUrl: RPC_URL,
  anvilPort: 18549,
  serverPort: 4320,
  indexerPort: 42080,
  webPort: 3200,
  webOrigin: "http://localhost:3200",
  deploymentPath: DEPLOYMENT_PATH,
  sessionMinutes: 60,
  zero: "0x0000000000000000000000000000000000000000",
  hash,
  envelopeRef,
  envelopeDetail,
  readDeployment,
  deployedVaults,
  chainClient,
  ownerA,
  ownerB,
  otherUser,
};
