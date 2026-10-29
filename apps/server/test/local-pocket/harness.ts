// Shared harness for SCR-146 §3.3 runs 4 and 5 (SCR-150 §5): the CZ-15 pocket executor driven directly
// (Gateway routing stays off) against a CLEAN pinned arc-anvil with the Czar contracts and the SCR-150
// Gateway doubles, the real CZ-27 signer, the D92 `/v1/transfer` stand-in (in-process) and a chain-backed
// stand-in for the CZ-19 pocket routes. `recovery()` builds the CZ-15 recovery operations as
// `apps/server/src/main.ts` does (`createDefaultPocketRecovery`), fresh on every call, so a test restarts the
// payer after an injected kill by calling it again over the same database and chain.
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
import type { PlanLeaf, Signer, SignRequest } from "@czar/signer";
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
import { createIndexerPocketReader } from "#src/payer/indexer-pocket";
import {
  cancelExpiredPullback,
  writeOffOverdueManualReturn,
  type CancelPullbackInput,
} from "#src/payer/pullback";
import { createPullbackChainAdapter } from "#src/payer/pullback-chain-adapter";
import { createPullbackExecutionChain } from "#src/payer/pullback-execution-chain";
import {
  runManualReturnRecovery,
  runPendingPullbackFallbacks,
  type ManualReturnReceiptPosition,
  type ManualReturnRow,
  type ManualReturnWriteOffCandidate,
} from "#src/payer/pullback-scheduler";
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
  InjectedCrash,
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

const MS_PER_SECOND = 1000;
const ENVELOPE_LIFETIME_SECONDS = 30n * 86_400n;
const NATIVE_FUNDING = parseEther("100");
const POCKET_CAP_BPS = 2500;
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_LENGTH = 26;
const SELLER: Address = "0x000000000000000000000000000000000000bEEF";
const usdcAbi = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const gatewayWalletAbi = parseAbi([
  "function depositFor(address token, address depositor, uint256 value)",
  "function availableBalance(address token, address depositor) view returns (uint256)",
  "event WithdrawalInitiated(address indexed token, address indexed depositor, uint256 value, uint256 totalWithdrawing, uint256 availableAtBlock)",
  "event WithdrawalCompleted(address indexed token, address indexed depositor, uint256 value)",
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
    readonly kind: "gateway-nano" | "x402-exact";
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

export interface HarnessClock {
  now(): Date;
  /** The signer's clock: the payer clock minus the lag set with `setSignerLag`. */
  signerNowMs(): number;
  /** Advances the payer clock, the signer clock and chain time together. */
  advance(ms: number): Promise<void>;
  /** The signer's clock trails the payer clock by `ms` (0 restores it). */
  setSignerLag(ms: number): void;
}

export interface SignCrash {
  /** The next matching signing request dies before the signer is called (nothing is signed). */
  arm(point: { name: string; match: (request: SignRequest) => boolean }): void;
  /** Runs before every payer signing request reaches the signer, to observe the chain at that moment. */
  observe(listener: (request: SignRequest) => Promise<void>): void;
  readonly fired: readonly string[];
}

export interface GatewayFailureRow {
  readonly state: string;
  readonly closed_pocket: boolean;
  readonly initiate_tx: string | null;
  readonly withdraw_tx: string | null;
  readonly return_tx: string | null;
  readonly return_block: string | null;
  readonly return_log_index: number | null;
  readonly returned_amount: string | null;
  readonly recorded_credit: string | null;
  readonly recorded_tx: string | null;
  readonly manual_return_required_at: Date | null;
}

export interface TransferCrash {
  /** The next `/v1/transfer` reaches the stand-in (so the burn happens); then the payer dies. */
  armAfterResponse(): void;
  fired(): number;
}

export interface LocalPocketHarness {
  readonly chain: ArcChain;
  readonly config: Config;
  readonly clock: HarnessClock;
  readonly pool: Pool;
  readonly signer: SignerHarness;
  readonly standin: IndexerStandin;
  readonly transferCrash: TransferCrash;
  readonly signCrash: SignCrash;
  readonly guardian: PrivateKeyAccount;
  readonly logger: Logger;
  /** Payer operations reported through `onError`, `onRowError` and `onWriteOffError`. */
  readonly errors: string[];
  createVault(): Promise<VaultFixture>;
  openPocketPlan(vault: VaultFixture, sizes: { stepCap: bigint; cap: bigint }): Promise<PocketPlan>;
  preparePocket(plan: PocketPlan): Promise<{ pocket: Address; funded: string }>;
  /** Fresh CZ-15 recovery operations over the shared database and chain. */
  recovery(): PocketRecoveryOperations;
  /** One `runPendingPullbackFallbacks` pass, composed as `main.ts` composes it. */
  runFallbacks(): Promise<number>;
  /** One `runManualReturnRecovery` pass, composed as `main.ts` composes it. */
  runManualReturnRecovery(): Promise<number>;
  depositFor(pocket: Address, value: bigint): Promise<void>;
  usdcBalance(address: Address): Promise<bigint>;
  gatewayAvailable(pocket: Address): Promise<bigint>;
  vaultEvents(vault: Address, eventName: VaultEventName, pocket?: Address): Promise<ChainLog[]>;
  attestations(recipient: Address): Promise<ChainLog[]>;
  usdcTransfers(from: Address, to: Address): Promise<ChainLog[]>;
  gatewayEvents(
    eventName: "WithdrawalInitiated" | "WithdrawalCompleted",
    depositor: Address,
  ): Promise<ChainLog[]>;
  row(plan: PocketPlan): Promise<GatewayFailureRow | undefined>;
  stop(): Promise<void>;
}

export type VaultEventName =
  | "PullbackRequested"
  | "PullbackConfirmed"
  | "PocketClosed"
  | "ManualReturnRecorded"
  | "Frozen";

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
  const clock = createClock(chain);
  let standin: IndexerStandin | undefined;
  try {
    standin = await startIndexerStandin({
      port: input.basePort + 1,
      reader: chain.reader,
      now: clock.now,
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
      nowMs: () => clock.signerNowMs(),
    });
    return composeHarness({ pool: input.pool, config, chain, clock, signer, standin, guardian });
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

/** Wall time plus an offset the tests advance; chain time is advanced by the same amount. */
function createClock(chain: ArcChain): HarnessClock {
  let offsetMs = 0;
  let signerLagMs = 0;
  return {
    now: () => new Date(Date.now() + offsetMs),
    signerNowMs: () => Date.now() + offsetMs - signerLagMs,
    async advance(ms) {
      offsetMs += ms;
      await chain.increaseTime(Math.ceil(ms / MS_PER_SECOND));
    },
    setSignerLag(ms) {
      signerLagMs = ms;
    },
  };
}

interface PayerParts extends HarnessParts {
  readonly logger: Logger;
  readonly errors: string[];
  /** The real signer behind the `signCrash` switch. */
  readonly payerSigner: Pick<Signer, "sign">;
  readonly transfer: ReturnType<typeof standinTransferFetch>;
}

export interface HarnessParts {
  readonly pool: Pool;
  readonly config: Config;
  readonly chain: ArcChain;
  readonly clock: HarnessClock;
  readonly signer: SignerHarness;
  readonly standin: IndexerStandin;
  readonly guardian: PrivateKeyAccount;
}

function createSignCrash(signer: Signer): { signer: Pick<Signer, "sign">; crash: SignCrash } {
  let armed: { name: string; match: (request: SignRequest) => boolean } | null = null;
  const fired: string[] = [];
  const listeners: ((request: SignRequest) => Promise<void>)[] = [];
  return {
    signer: {
      async sign(caller, request) {
        for (const listener of listeners) await listener(request);
        if (armed?.match(request)) {
          const name = armed.name;
          armed = null;
          fired.push(name);
          throw new InjectedCrash(name);
        }
        return signer.sign(caller, request);
      },
    },
    crash: {
      fired,
      arm(point) {
        armed = point;
      },
      observe(listener) {
        listeners.push(listener);
      },
    },
  };
}

function composeHarness(parts: HarnessParts): LocalPocketHarness {
  const errors: string[] = [];
  const logger = createLogger({ service: "server", component: "CZ-15", sink: () => undefined });
  const transfer = standinTransferFetch(
    parts.chain,
    BigInt(Number(parts.config.get("routing.gatewayFeeAtomic"))),
  );
  const fixtures = createFixtures(parts);
  const signCrash = createSignCrash(parts.signer.signer);
  const payer: PayerParts = { ...parts, logger, errors, payerSigner: signCrash.signer, transfer };
  const reader = createIndexerPocketReader(
    parts.standin.url,
    Number(parts.config.get("fetch.timeoutMs")),
  );
  return {
    ...parts,
    logger,
    errors,
    transferCrash: transfer.crash,
    signCrash: signCrash.crash,
    ...fixtures,
    runFallbacks: () =>
      runPendingPullbackFallbacks({
        pool: parts.pool,
        config: parts.config,
        signer: payer.payerSigner,
        cancelPendingPullback: (cancel) => cancelFallbackPullback(payer, cancel),
        chain: createPullbackChainAdapter(
          parts.chain.payerClient,
          parts.chain.payerWallet,
          GATEWAY_WALLET,
          { config: parts.config, logger },
        ),
        readGatewayBalance: (pocket) => reader.pocketBalance(pocket),
        now: parts.clock.now,
      }),
    runManualReturnRecovery: () => manualReturnRecovery(payer, reader),
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
            client: parts.chain.payerClient,
            vault: plan.vault.vault,
            usdc: ARC_USDC,
            gatewayWallet: GATEWAY_WALLET,
          }),
          now: parts.clock.now,
        },
      ),
    recovery: () =>
      createPocketRecoveryOperations({
        pool: parts.pool,
        config: parts.config,
        logger,
        signer: payer.payerSigner,
        publicClient: parts.chain.payerClient,
        walletClient: parts.chain.payerWallet,
        safeFetch: transfer.safeFetch,
        indexerUrl: parts.standin.url,
        gatewayMinter: GATEWAY_MINTER,
        gatewayDomain: GATEWAY_DOMAIN,
        gatewayTransferUrl: STANDIN_TRANSFER_URL,
        now: parts.clock.now,
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
function standinTransferFetch(
  chain: ArcChain,
  gatewayFeeAtomic: bigint,
): { readonly safeFetch: SafeFetch; readonly crash: TransferCrash } {
  let armed = false;
  let fired = 0;
  const safeFetch: SafeFetch = async (url, options) => {
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
    const body = new Uint8Array(await response.arrayBuffer());
    if (armed) {
      armed = false;
      fired += 1;
      throw new InjectedCrash("after /v1/transfer");
    }
    return {
      status: response.status,
      url,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  };
  return {
    safeFetch,
    crash: {
      armAfterResponse() {
        armed = true;
      },
      fired: () => fired,
    },
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
    usdcTransfers: async (from: Address, to: Address) =>
      toChainLogs(
        await parts.chain.reader.getContractEvents({
          address: ARC_USDC,
          abi: usdcAbi,
          eventName: "Transfer",
          args: { from, to },
          fromBlock: 0n,
        }),
      ),
    gatewayEvents: async (
      eventName: "WithdrawalInitiated" | "WithdrawalCompleted",
      depositor: Address,
    ) =>
      toChainLogs(
        await parts.chain.reader.getContractEvents({
          address: GATEWAY_WALLET,
          abi: gatewayWalletAbi,
          eventName,
          args: { depositor },
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
    async row(plan: PocketPlan) {
      const result = await parts.pool.query<GatewayFailureRow>(
        `SELECT state,closed_pocket,initiate_tx,withdraw_tx,return_tx,return_block::text AS return_block,
                return_log_index,returned_amount::text AS returned_amount,
                recorded_credit::text AS recorded_credit,recorded_tx,manual_return_required_at
         FROM payer_pullback_gateway_failures WHERE plan_id=$1 AND step_index=$2`,
        [plan.planId, plan.stepIndex],
      );
      return result.rows[0];
    },
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

async function fees(parts: Pick<HarnessParts, "chain">) {
  return withFeeFloor({ maxFeePerGas: (await parts.chain.reader.getGasPrice()) * 2n });
}

async function send(parts: Pick<HarnessParts, "chain">, pending: Promise<Hex>): Promise<Hex> {
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
    pocketCapBps: POCKET_CAP_BPS,
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

/** The owner opens the envelope for a stored plan; returns its id from `EnvelopeOpened`. */
export async function openEnvelope(
  parts: Pick<HarnessParts, "chain">,
  vault: VaultFixture,
  input: {
    stepCap: bigint;
    cap: bigint;
    pocketCapBps: number;
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
          pocketCapBps: input.pocketCapBps,
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

/** The objective, plan and step rows CZ-15 reads for a plan (one step, index 0). */
export async function seedPlanRows(
  parts: Pick<HarnessParts, "pool">,
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

// ICzarVault.PocketState: None, Registered, Funded, Draining, Closed.
const POCKET_STATE_CLOSED = 4;

/** Mirrors the `runManualReturnRecovery` composition in `startProductionPayerRuntime` (`main.ts`). */
function manualReturnRecovery(
  parts: PayerParts,
  reader: ReturnType<typeof createIndexerPocketReader>,
): Promise<number> {
  return runManualReturnRecovery({
    pool: parts.pool,
    config: parts.config,
    manualReturnsForVault: (vault) => reader.manualReturnsForVault(vault),
    manualReturnsAfterClosure: (vault, pocket, fromBlock) =>
      manualReturnsAfterClosure(parts, vault, pocket, fromBlock),
    recoverReturnPosition: (row) => recoverManualReturnPosition(parts, row),
    isPocketClosed: async (vault, pocket) => {
      const record = await parts.chain.reader.readContract({
        address: vault,
        abi: czarVaultAbi,
        functionName: "getPocket",
        args: [pocket],
      });
      return Number(record.state) === POCKET_STATE_CLOSED;
    },
    onRowError: () => parts.errors.push("manual-return-reconciliation"),
    onWriteOffError: () => parts.errors.push("manual-return-writeoff"),
    now: parts.clock.now,
    writeOffManualReturn: (row) => writeOffManualReturn(parts, row),
  });
}

/** Mirrors `cancelFallbackPullback` in `apps/server/src/main.ts`. */
async function cancelFallbackPullback(parts: PayerParts, input: CancelPullbackInput) {
  const chain = createPullbackExecutionChain({
    client: parts.chain.payerClient,
    pool: parts.pool,
    vault: input.vault,
    gatewayMinter: input.gatewayMinter,
  });
  const record = await chain.readPullback(input.pullbackId);
  if (!record || record.state === "Confirmed")
    throw new Error("Gateway pullback is not cancellable before slow withdrawal.");
  if (record.state === "Cancelled") return;
  return cancelExpiredPullback(input, {
    pool: parts.pool,
    config: parts.config,
    signer: parts.payerSigner,
    chain,
    safeFetch: parts.transfer.safeFetch,
    gatewayTransferUrl: STANDIN_TRANSFER_URL,
    now: parts.clock.now,
  });
}

/** Mirrors `writeOffManualReturn` in `apps/server/src/main.ts`. */
function writeOffManualReturn(parts: PayerParts, row: ManualReturnWriteOffCandidate) {
  if (!row.vault_address) throw new Error("Manual-return write-off row has no vault address.");
  return writeOffOverdueManualReturn(
    {
      planId: row.plan_id,
      stepIndex: row.step_index,
      attempt: row.attempt ?? 0,
      envelopeRef: row.envelope_ref,
      vault: row.vault_address,
      pocket: row.pocket,
    },
    {
      pool: parts.pool,
      config: parts.config,
      signer: parts.payerSigner,
      chain: createPullbackExecutionChain({
        client: parts.chain.payerClient,
        pool: parts.pool,
        vault: row.vault_address,
        gatewayMinter: row.gateway_minter ?? GATEWAY_MINTER,
      }),
      now: parts.clock.now,
    },
  );
}

/** Mirrors the `manualReturnsAfterClosure` closure in `apps/server/src/main.ts`. */
async function manualReturnsAfterClosure(
  parts: HarnessParts,
  vault: Address,
  pocket: Address,
  fromBlock: bigint,
) {
  const events = await parts.chain.payerClient.getContractEvents({
    address: vault,
    abi: czarVaultAbi,
    eventName: "ManualReturnRecorded",
    args: { pocket },
    fromBlock,
  });
  return events.flatMap((event) => {
    if (
      event.args.amount === undefined ||
      event.blockNumber === null ||
      event.logIndex === null ||
      event.transactionHash === null
    )
      return [];
    return [
      {
        pocket,
        credit: event.args.amount.toString(),
        block: event.blockNumber.toString(),
        logIndex: event.logIndex,
        txHash: event.transactionHash,
      },
    ];
  });
}

/** Mirrors `recoverManualReturnPosition` in `apps/server/src/main.ts` for rows whose `return_tx` is set. */
async function recoverManualReturnPosition(
  parts: HarnessParts,
  row: ManualReturnRow,
): Promise<ManualReturnReceiptPosition | null> {
  const vault = row.vault_address;
  if (vault === null || !row.return_tx || !/^0x[\da-fA-F]{64}$/.test(row.return_tx)) return null;
  const receipt = await parts.chain.payerClient.getTransactionReceipt({
    hash: row.return_tx as Hex,
  });
  if (receipt.status !== "success") return null;
  const matching = receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== ARC_USDC.toLowerCase()) return [];
    try {
      const decoded = decodeEventLog({
        abi: usdcAbi,
        eventName: "Transfer",
        data: log.data,
        topics: log.topics,
      });
      return decoded.args.from.toLowerCase() === row.pocket.toLowerCase() &&
        decoded.args.to.toLowerCase() === vault.toLowerCase() &&
        decoded.args.value > 0n
        ? [{ amount: decoded.args.value, logIndex: log.logIndex }]
        : [];
    } catch {
      return [];
    }
  });
  const transfer = matching.length === 1 ? matching[0] : undefined;
  if (!transfer) return null;
  return {
    txHash: receipt.transactionHash,
    amount: transfer.amount.toString(),
    block: receipt.blockNumber.toString(),
    logIndex: transfer.logIndex,
  };
}
