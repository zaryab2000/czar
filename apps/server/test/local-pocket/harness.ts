// Shared harness for SCR-146 §3.3 runs 4 and 5 (SCR-150 §5): the CZ-15 pocket executor driven directly
// (Gateway routing stays off) against a CLEAN pinned arc-anvil with the Czar contracts and the SCR-150
// Gateway doubles, the real CZ-27 signer, the D92 `/v1/transfer` stand-in (in-process) and a chain-backed
// stand-in for the CZ-19 pocket routes. `recovery()` builds the CZ-15 recovery operations as
// `apps/server/src/main.ts` does (`createDefaultPocketRecovery`), fresh on every call.
import { randomBytes } from "node:crypto";
import { loadConfig, type Config } from "@czar/config";
import {
  buildTree,
  PAYEE_KIND,
  payeeLeaf,
  POCKET_STEP_INDEX,
  pocketLeaf,
  type Hash32,
} from "@czar/hashing";
import { createLogger, type Logger } from "@czar/logging";
import type { PlanLeaf } from "@czar/signer";
import { czarVaultAbi, czarVaultFactoryAbi, withFeeFloor } from "@czar/vault-client";
import type { SafeFetch } from "@czar/x402";
import type { Pool } from "pg";
import {
  decodeEventLog,
  keccak256,
  parseAbi,
  parseEther,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { handleStandinRequest } from "../../../../ops/local/circle-standins/server.ts";
import { executePocketPreparation, type PocketPreparationInput } from "#src/payer/pocket";
import { createPocketPreparationChain } from "#src/payer/pocket-chain";
import {
  createPocketRecoveryOperations,
  type PocketRecoveryOperations,
} from "#src/payer/pocket-recovery";
import {
  ARC_CHAIN_ID,
  ARC_USDC,
  GATEWAY_DOMAIN,
  GATEWAY_MINTER,
  GATEWAY_WALLET,
  startArcChain,
  walletFor,
  type ArcChain,
} from "#test/local-pocket/arc-chain";
import { startIndexerStandin, type IndexerStandin } from "#test/local-pocket/indexer-standin";
import {
  createSignerHarness,
  createSignerKeys,
  type SignerHarness,
} from "#test/local-pocket/signer-harness";

export const localChainEnabled = process.env["CZAR_LOCAL_CHAIN"] === "1";

const ENVELOPE_LIFETIME_SECONDS = 30n * 86_400n;
const NATIVE_FUNDING = parseEther("100");
const POCKET_CAP_BPS = 2500;
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_LENGTH = 26;
const SELLER: Address = "0x000000000000000000000000000000000000bEEF";
const usdcAbi = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);
const gatewayWalletAbi = parseAbi([
  "function depositFor(address token, address depositor, uint256 value)",
  "function availableBalance(address token, address depositor) view returns (uint256)",
]);
const gatewayMinterAbi = parseAbi([
  "event AttestationUsed(address indexed token, address indexed recipient, bytes32 indexed transferSpecHash, uint32 sourceDomain, bytes32 sourceDepositor, bytes32 sourceSigner, uint256 value)",
]);

export interface VaultFixture {
  readonly owner: PrivateKeyAccount;
  readonly vault: Address;
  readonly userId: string;
  readonly deviceId: string;
}

export interface PocketPlan {
  readonly vault: VaultFixture;
  readonly pocket: Address;
  readonly planId: string;
  readonly envelopeId: bigint;
  readonly envelopeRef: string;
  readonly stepIndex: number;
  readonly plan: PlanJson;
}

export interface PlanJson {
  readonly [field: string]: unknown;
  readonly payeeRoot: Hash32;
  readonly payeeLeaves: readonly {
    readonly payee: string;
    readonly kind: number;
    readonly stepIndex: number;
    readonly stepCap: string;
  }[];
  readonly pocketCapBps: number;
  readonly cap: string;
  readonly steps: readonly {
    readonly [field: string]: unknown;
    readonly kind: "gateway-nano";
    readonly stepIndex: number;
    readonly stepCap: string;
  }[];
}

export interface ChainLog {
  readonly args: Readonly<Record<string, unknown>>;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly transactionHash: Hex;
}

export interface LocalPocketHarness {
  readonly chain: ArcChain;
  readonly config: Config;
  readonly guardian: PrivateKeyAccount;
  readonly logger: Logger;
  /** Payer runtime operations reported through `onError`. */
  readonly errors: string[];
  createVault(): Promise<VaultFixture>;
  openPocketPlan(vault: VaultFixture, sizes: { stepCap: bigint; cap: bigint }): Promise<PocketPlan>;
  preparePocket(plan: PocketPlan): Promise<{ pocket: Address; funded: string }>;
  /** Fresh CZ-15 recovery operations over the shared database and chain. */
  recovery(): PocketRecoveryOperations;
  depositFor(pocket: Address, value: bigint): Promise<void>;
  usdcBalance(address: Address): Promise<bigint>;
  gatewayAvailable(pocket: Address): Promise<bigint>;
  vaultEvents(vault: Address, eventName: VaultEventName, pocket?: Address): Promise<ChainLog[]>;
  attestations(recipient: Address): Promise<ChainLog[]>;
  stop(): Promise<void>;
}

export type VaultEventName = "PullbackRequested" | "PullbackConfirmed" | "PocketClosed" | "Frozen";

export async function startLocalPocketHarness(input: {
  readonly pool: Pool;
  readonly basePort: number;
}): Promise<LocalPocketHarness> {
  const config = loadConfig({ envFile: { "payer.vaultEventPollMs": 200 } });
  const keys = await createSignerKeys();
  const guardian = privateKeyToAccount(generatePrivateKey());
  const chain = await startArcChain({
    port: input.basePort,
    keyAddresses: {
      K3: keys.k3,
      K5: unusedKey(),
      K6: guardian.address,
      K7: unusedKey(),
      K20: unusedKey(),
    },
  });
  let standin: IndexerStandin | undefined;
  try {
    standin = await startIndexerStandin({
      port: input.basePort + 1,
      reader: chain.reader,
      now,
    });
    for (const address of [keys.k3, keys.relayer, guardian.address])
      await chain.testClient.setBalance({ address, value: NATIVE_FUNDING });
    const signer = createSignerHarness({
      keys,
      pool: input.pool,
      config,
      reader: chain.reader,
      factory: chain.factory,
      standin,
      mine: () => chain.mine(1),
      nowMs: () => now().getTime(),
    });
    return composeHarness({ pool: input.pool, config, chain, now, signer, standin, guardian });
  } catch (error) {
    await standin?.stop();
    chain.stop();
    throw error;
  }
}

/** K5, K7 and K20 sign nothing in these runs; deploy.sh only needs their addresses. */
function unusedKey(): Address {
  return privateKeyToAccount(generatePrivateKey()).address;
}

function now(): Date {
  return new Date();
}

interface HarnessParts {
  readonly pool: Pool;
  readonly config: Config;
  readonly chain: ArcChain;
  readonly now: () => Date;
  readonly signer: SignerHarness;
  readonly standin: IndexerStandin;
  readonly guardian: PrivateKeyAccount;
}

function composeHarness(parts: HarnessParts): LocalPocketHarness {
  const errors: string[] = [];
  const logger = createLogger({ service: "server", component: "CZ-15", sink: () => undefined });
  const safeFetch = standinTransferFetch(
    parts.chain,
    BigInt(Number(parts.config.get("routing.gatewayFeeAtomic"))),
  );
  const fixtures = createFixtures(parts);
  return {
    ...parts,
    logger,
    errors,
    ...fixtures,
    preparePocket: (plan) =>
      executePocketPreparation(
        {
          planId: plan.planId,
          envelopeRef: plan.envelopeRef,
          envelopeId: plan.envelopeId,
          vault: plan.vault.vault,
          plan: plan.plan as unknown as PocketPreparationInput["plan"],
        },
        {
          pool: parts.pool,
          config: parts.config,
          signer: parts.signer.signer,
          chain: createPocketPreparationChain({
            client: parts.chain.reader,
            vault: plan.vault.vault,
            usdc: ARC_USDC,
            gatewayWallet: GATEWAY_WALLET,
          }),
          now: parts.now,
        },
      ),
    recovery: () =>
      createPocketRecoveryOperations({
        pool: parts.pool,
        config: parts.config,
        logger,
        signer: parts.signer.signer,
        publicClient: parts.chain.reader,
        walletClient: parts.chain.wallet,
        safeFetch,
        indexerUrl: parts.standin.url,
        gatewayMinter: GATEWAY_MINTER,
        gatewayDomain: GATEWAY_DOMAIN,
        gatewayTransferUrl: STANDIN_TRANSFER_URL,
        now: parts.now,
      }),
    stop: async () => {
      await parts.standin.stop();
      parts.chain.stop();
    },
  };
}

/** The stand-in's default address (`CZAR_STANDIN_PORT`); requests are routed in-process, not over HTTP. */
const STANDIN_TRANSFER_URL = "http://127.0.0.1:4999/v1/transfer";

/** The D92 stand-in's `/v1/transfer` handler, called in-process with the fee `createStandinServer` uses. */
function standinTransferFetch(chain: ArcChain, gatewayFeeAtomic: bigint): SafeFetch {
  return async (url, options) => {
    if (new URL(url).pathname !== "/v1/transfer")
      throw new Error("The local pocket harness only routes the Gateway /v1/transfer stand-in.");
    const response = await handleStandinRequest(
      new Request(url, {
        method: options?.method ?? "GET",
        headers: options?.headers ?? {},
        ...(options?.body ? { body: options.body } : {}),
      }),
      chain.rpc,
      ARC_USDC,
      { gatewayFeeAtomic },
    );
    return {
      status: response.status,
      url,
      headers: Object.fromEntries(response.headers.entries()),
      body: new Uint8Array(await response.arrayBuffer()),
    };
  };
}

function createFixtures(parts: HarnessParts) {
  return {
    createVault: () => createVault(parts),
    openPocketPlan: (vault: VaultFixture, sizes: { stepCap: bigint; cap: bigint }) =>
      openPocketPlan(parts, vault, sizes),
    async depositFor(pocket: Address, value: bigint) {
      const funder = privateKeyToAccount(generatePrivateKey());
      await parts.chain.testClient.setBalance({ address: funder.address, value: NATIVE_FUNDING });
      const wallet = walletFor(parts.chain, funder);
      await send(
        parts,
        wallet.writeContract({
          address: ARC_USDC,
          abi: usdcAbi,
          functionName: "approve",
          args: [GATEWAY_WALLET, value],
          ...(await fees(parts)),
        }),
      );
      await send(
        parts,
        wallet.writeContract({
          address: GATEWAY_WALLET,
          abi: gatewayWalletAbi,
          functionName: "depositFor",
          args: [ARC_USDC, pocket, value],
          ...(await fees(parts)),
        }),
      );
    },
    usdcBalance: (address: Address) =>
      parts.chain.reader.readContract({
        address: ARC_USDC,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [address],
      }),
    gatewayAvailable: (pocket: Address) =>
      parts.chain.reader.readContract({
        address: GATEWAY_WALLET,
        abi: gatewayWalletAbi,
        functionName: "availableBalance",
        args: [ARC_USDC, pocket],
      }),
    vaultEvents: async (vault: Address, eventName: VaultEventName, pocket?: Address) =>
      toChainLogs(
        await parts.chain.reader.getContractEvents({
          address: vault,
          abi: czarVaultAbi,
          eventName,
          ...(pocket && eventName !== "Frozen" ? { args: { pocket } } : {}),
          fromBlock: 0n,
        }),
      ),
    attestations: async (recipient: Address) =>
      toChainLogs(
        await parts.chain.reader.getContractEvents({
          address: GATEWAY_MINTER,
          abi: gatewayMinterAbi,
          eventName: "AttestationUsed",
          args: { recipient },
          fromBlock: 0n,
        }),
      ),
  };
}

function toChainLogs(
  logs: readonly {
    args: unknown;
    blockNumber: bigint | null;
    logIndex: number | null;
    transactionHash: Hex | null;
  }[],
): ChainLog[] {
  return logs.map((log) => {
    if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null)
      throw new Error("A pending log reached a mined-log assertion.");
    return {
      args: log.args as Record<string, unknown>,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
    };
  });
}

async function fees(parts: HarnessParts) {
  return withFeeFloor({ maxFeePerGas: (await parts.chain.reader.getGasPrice()) * 2n });
}

async function send(parts: HarnessParts, pending: Promise<Hex>): Promise<Hex> {
  const hash = await pending;
  const receipt = await parts.chain.reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("A harness setup transaction reverted.");
  return hash;
}

function ulid(prefix: string): string {
  const bytes = randomBytes(ULID_LENGTH);
  let body = "";
  for (const byte of bytes) body += ULID_ALPHABET[byte % ULID_ALPHABET.length];
  return `${prefix}_${body}`;
}

async function createVault(parts: HarnessParts): Promise<VaultFixture> {
  const owner = privateKeyToAccount(generatePrivateKey());
  await parts.chain.testClient.setBalance({ address: owner.address, value: NATIVE_FUNDING });
  const deployer = walletFor(parts.chain, owner);
  await send(
    parts,
    deployer.writeContract({
      address: parts.chain.factory,
      abi: czarVaultFactoryAbi,
      functionName: "createVault",
      args: [owner.address],
      ...(await fees(parts)),
    }),
  );
  const vault = await parts.chain.reader.readContract({
    address: parts.chain.factory,
    abi: czarVaultFactoryAbi,
    functionName: "vaultOf",
    args: [owner.address],
  });
  await parts.chain.testClient.setBalance({ address: vault, value: NATIVE_FUNDING });
  const userId = ulid("usr");
  const deviceId = ulid("dev");
  await parts.pool.query("INSERT INTO users (user_id,vault) VALUES ($1,$2)", [userId, vault]);
  await parts.pool.query(
    `INSERT INTO devices (device_id,user_id,device_name,platform,token_hash)
     VALUES ($1,$2,'Local pocket run','macos',$3)`,
    [deviceId, userId, randomBytes(32)],
  );
  return { owner, vault, userId, deviceId };
}

async function openPocketPlan(
  parts: HarnessParts,
  vault: VaultFixture,
  sizes: { stepCap: bigint; cap: bigint },
): Promise<PocketPlan> {
  const pocket = (await parts.signer.signer.createPocketKey("cz-15")) as Address;
  const leaves = [
    {
      payee: SELLER,
      kind: PAYEE_KIND.X402_PAY_TO,
      stepIndex: 0,
      stepCap: sizes.stepCap.toString(),
    },
    { payee: pocket, kind: PAYEE_KIND.POCKET, stepIndex: POCKET_STEP_INDEX, stepCap: "0" },
  ];
  const payeeRoot = buildTree([
    payeeLeaf(SELLER, PAYEE_KIND.X402_PAY_TO, 0, sizes.stepCap),
    pocketLeaf(pocket),
  ]).root;
  const planHash = keccak256(randomBytes(32)) as Hash32;
  const objectiveHash = keccak256(randomBytes(32)) as Hash32;
  const envelopeId = await openEnvelope(parts, vault, {
    ...sizes,
    planHash,
    objectiveHash,
    payeeRoot,
  });
  const envelopeRef = `eip155:${ARC_CHAIN_ID}:${vault.vault.toLowerCase()}:${envelopeId}`;
  const plan = planJson({ pocket, payeeRoot, leaves, planHash, objectiveHash, sizes });
  const planId = await seedPlanRows(parts, vault, { plan, envelopeRef, objectiveHash, planHash });
  parts.signer.leaves.set(
    `${vault.vault.toLowerCase()}:${envelopeId}`,
    signerLeaves(pocket, sizes),
  );
  parts.standin.register({ pocket, vault: vault.vault, envelopeRef });
  return { vault, pocket, planId, envelopeId, envelopeRef, stepIndex: 0, plan };
}

function signerLeaves(pocket: Address, sizes: { stepCap: bigint }): readonly PlanLeaf[] {
  return [
    {
      stepIndex: 0,
      payee: SELLER,
      kind: PAYEE_KIND.X402_PAY_TO,
      stepCap: sizes.stepCap,
      stepKind: "gateway-nano",
      expectedCalls: 1,
      usedCalls: 0,
    },
    {
      stepIndex: POCKET_STEP_INDEX,
      payee: pocket,
      kind: PAYEE_KIND.POCKET,
      stepCap: 0n,
      stepKind: "pocket",
      expectedCalls: 1,
      usedCalls: 0,
    },
  ];
}

function planJson(input: {
  pocket: Address;
  payeeRoot: Hash32;
  leaves: PlanJson["payeeLeaves"];
  planHash: Hash32;
  objectiveHash: Hash32;
  sizes: { stepCap: bigint; cap: bigint };
}): PlanJson {
  return {
    schemaVersion: "1.2",
    planHash: input.planHash,
    objectiveHash: input.objectiveHash,
    network: `eip155:${ARC_CHAIN_ID}`,
    category: "research",
    cap: input.sizes.cap.toString(),
    slackBps: 0,
    maxStepAmount: input.sizes.stepCap.toString(),
    pocketCapBps: POCKET_CAP_BPS,
    pocket: input.pocket,
    steps: [
      {
        stepIndex: 0,
        kind: "gateway-nano",
        capability: "web-search",
        payee: SELLER,
        expectedCalls: 1,
        stepCap: input.sizes.stepCap.toString(),
        routingReason: "gateway",
      },
    ],
    payeeLeaves: input.leaves,
    payeeRoot: input.payeeRoot,
    shadow: false,
  };
}

async function openEnvelope(
  parts: HarnessParts,
  vault: VaultFixture,
  input: {
    stepCap: bigint;
    cap: bigint;
    planHash: Hash32;
    objectiveHash: Hash32;
    payeeRoot: Hash32;
  },
): Promise<bigint> {
  const block = await parts.chain.reader.getBlock();
  const wallet = walletFor(parts.chain, vault.owner);
  const hash = await send(
    parts,
    wallet.writeContract({
      address: vault.vault,
      abi: czarVaultAbi,
      functionName: "openEnvelope",
      args: [
        {
          cap: input.cap,
          maxStepAmount: input.stepCap,
          pocketCapBps: POCKET_CAP_BPS,
          expiresAt: block.timestamp + ENVELOPE_LIFETIME_SECONDS,
          categoryId: keccak256(toBytes("research")),
          objectiveHash: input.objectiveHash,
          planHash: input.planHash,
          payeeRoot: input.payeeRoot,
        },
      ],
      ...(await fees(parts)),
    }),
  );
  const receipt = await parts.chain.reader.getTransactionReceipt({ hash });
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== vault.vault.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: czarVaultAbi, data: log.data, topics: log.topics });
      if (event.eventName === "EnvelopeOpened") return BigInt(event.args.envelopeId);
    } catch {
      continue;
    }
  }
  throw new Error("openEnvelope emitted no EnvelopeOpened event.");
}

async function seedPlanRows(
  parts: HarnessParts,
  vault: VaultFixture,
  input: { plan: PlanJson; envelopeRef: string; objectiveHash: Hash32; planHash: Hash32 },
): Promise<string> {
  const objectiveId = ulid("obj");
  const planId = ulid("pln");
  await parts.pool.query(
    `INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state,
                             plan_id,envelope_ref)
     VALUES ($1,$2,$3,'{}'::jsonb,$4,'executing',$5,$6)`,
    [objectiveId, vault.userId, vault.deviceId, input.objectiveHash, planId, input.envelopeRef],
  );
  await parts.pool.query(
    `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES ($1,$2,$3::jsonb,$4,$5,'approved')`,
    [
      planId,
      objectiveId,
      JSON.stringify({ ...input.plan, planId, objectiveId }),
      input.planHash,
      input.plan.payeeRoot,
    ],
  );
  await parts.pool.query(
    "INSERT INTO steps (plan_id,step_index,step,state) VALUES ($1,0,$2::jsonb,'executing')",
    [planId, JSON.stringify(input.plan.steps[0])],
  );
  return planId;
}
