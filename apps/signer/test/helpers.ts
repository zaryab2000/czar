// Test harness: an in-memory keystore filesystem, a mutable fake projection and throwaway keys that are
// generated per run and never touch the disk or the log.
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { keccak256, toBytes, type Hex, type TransactionSerializableEIP1559 } from "viem";
import { loadConfig } from "@czar/config";
import type { Logger } from "@czar/logging";
import { paymentRefHash } from "@czar/hashing";
import type { Address, Hash32 } from "@czar/hashing";
import {
  createSigner,
  memoryAudit,
  openLocalKeystore,
  type KeystoreFs,
  type PlanLeaf,
  type Projection,
  type OverdueManualReturnFacts,
  type SignerBackend,
  type SignerNetwork,
  type StoredPlan,
  type TransactionPreparer,
  type AuditSink,
} from "../src/index.ts";

export const VAULT: Address = "0x00000000000000000000000000000000000c2a21";
export const PAYEE: Address = "0x000000000000000000000000000000000000beef";
export const OTHER: Address = "0x000000000000000000000000000000000000dead";
export const ESCROW: Address = "0x000000000000000000000000000000000000e5c0";
export const OEL: Address = "0x00000000000000000000000000000000000000e1";
export const NOW = 1_760_800_000;
export const h = (byte: string): Hash32 => `0x${byte.repeat(64)}` as Hash32;

export const NETWORK: SignerNetwork = {
  chainId: 5042002,
  usdc: "0x3600000000000000000000000000000000000000",
  gatewayWallet: "0x0077777d7eba4688bdef3e311b846f25870a19b9",
  gatewayMinter: "0x0022222abe238cc2c7bb1f21003f0a260052475b",
  gatewayDomain: 26,
  jobEscrow: ESCROW,
  openEvidenceLog: OEL,
  nanoDomain: {
    name: "GatewayWalletBatched",
    version: "1",
    chainId: 5042002,
    verifyingContract: "0x0077777d7eba4688bdef3e311b846f25870a19b9",
  },
  merchantServices: ["czar-search"],
};

export function memoryFs(): KeystoreFs & { files: Map<string, { data: string; mode: number }> } {
  const files = new Map<string, { data: string; mode: number }>();
  const dirs = new Map<string, number>();
  return {
    files,
    async stat(path) {
      if (dirs.has(path)) return { mode: dirs.get(path) as number, isDirectory: true };
      const file = files.get(path);
      return file === undefined ? undefined : { mode: file.mode, isDirectory: false };
    },
    async mkdir(path, mode) {
      dirs.set(path, mode);
    },
    async list(path) {
      return [...files.keys()]
        .filter((name) => dirname(name) === path)
        .map((name) => name.slice(path.length + 1));
    },
    async read(path) {
      const file = files.get(path);
      if (file === undefined) throw new Error("ENOENT");
      return file.data;
    },
    async create(path, data, mode) {
      if (files.has(path)) throw new Error("EEXIST");
      files.set(path, { data, mode });
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

/** A fresh random passphrase per run, handed over in memory (the prompt source in production). */
export const testPassphrase = () => {
  const value = randomBytes(24).toString("hex");
  return { kind: "prompt" as const, read: async () => value };
};

export const FAST_KDF = { N: 1024, r: 8, p: 1 };

export interface State {
  frozen: boolean;
  guardianPaused: boolean;
  observedAt: number;
  reservation:
    | {
        envelopeId: bigint;
        stepIndex: number;
        payee: Address;
        unitAmount: bigint;
        count: number;
        validBefore: bigint;
        state: "Active" | "Finalizing" | "Final";
      }
    | undefined;
  pullback:
    | {
        pocket: Address;
        value: bigint;
        maxFee: bigint;
        maxBlockHeight: bigint;
        salt: Hash32;
        state: "Pending" | "Confirmed" | "Cancelled";
      }
    | undefined;
  block: bigint;
  plan: StoredPlan | undefined;
  envelopeState: "Open" | "Closed";
  leaves: PlanLeaf[];
  pocket: Awaited<ReturnType<Projection["pocket"]>>;
  balances: Awaited<ReturnType<Projection["pocketBalances"]>>;
  nanoSpent: { step: bigint; pocket: bigint };
  settled: Set<string>;
  autonomy: Awaited<ReturnType<Projection["autonomy"]>>;
  job: Awaited<ReturnType<Projection["job"]>>;
  reports: Set<string>;
  checksCommits: Set<string>;
  latestRoot: Hash32;
  batches: Set<string>;
  native: Map<string, bigint>;
  slowWithdrawTrigger: "api-down" | "closed-dust" | null;
  pocketSpendAfterObservation: boolean;
  overdueManualReturnFacts: OverdueManualReturnFacts;
}

export function defaultState(pocket: Address): State {
  return {
    frozen: false,
    guardianPaused: false,
    observedAt: NOW - 5,
    reservation: {
      envelopeId: 1n,
      stepIndex: 0,
      payee: PAYEE,
      unitAmount: 100000n,
      count: 3,
      validBefore: 1760800600n,
      state: "Active",
    },
    pullback: {
      pocket,
      value: 199600n,
      maxFee: 10000n,
      maxBlockHeight: 68000000n,
      salt: h("2"),
      state: "Pending",
    },
    block: 67_000_000n,
    plan: {
      planHash: h("a"),
      payeeRoot: h("b"),
      objectiveHash: h("c"),
      categoryId: h("d"),
      cap: 1_000_000n,
      maxStepAmount: 500_000n,
      pocketCapBps: 2500,
      expiresAt: 1_760_900_000n,
      approval: "auto-approvable",
      hasNanoStep: true,
    },
    envelopeState: "Open",
    leaves: [
      {
        stepIndex: 0,
        payee: PAYEE,
        kind: 1,
        stepCap: 500_000n,
        stepKind: "x402-exact",
        expectedCalls: 2,
        usedCalls: 0,
      },
      {
        stepIndex: 1,
        payee: OTHER,
        kind: 2,
        stepCap: 300_000n,
        stepKind: "erc8183-job",
        expectedCalls: 1,
        usedCalls: 0,
      },
      {
        stepIndex: 2,
        payee: PAYEE,
        kind: 1,
        stepCap: 2_000n,
        stepKind: "gateway-nano",
        expectedCalls: 100,
        usedCalls: 0,
      },
      {
        stepIndex: 4294967295,
        payee: pocket,
        kind: 4,
        stepCap: 0n,
        stepKind: "pocket",
        expectedCalls: 1,
        usedCalls: 0,
      },
    ],
    pocket: {
      vault: VAULT,
      envelopeId: 1n,
      state: "Funded",
      funded: 5_000n,
      pendingPullback: 0n,
      slowWithdrawalOpen: false,
    },
    balances: {
      gatewayApi: 0n,
      gatewayAvailable: 0n,
      gatewayApiObservedAt: NOW * 1000,
      gatewayWithdrawing: 0n,
      withdrawalBlock: 0n,
      currentBlock: 67_000_000n,
      usdc: 0n,
      native: 0n,
      pendingPullback: false,
      gatewayApiFresh: true,
    },
    nanoSpent: { step: 0n, pocket: 0n },
    settled: new Set([h("3")]),
    autonomy: {
      autoLimit: 2_000_000n,
      userMax: 10_000_000n,
      maxStepTo: 5_000_000n,
      lastRaiseAt: NOW - 700_000,
      periodLength: 604_800,
      nonce: 7n,
    },
    job: { evaluator: "0x0000000000000000000000000000000000000000", clientVault: VAULT },
    reports: new Set([h("9")]),
    checksCommits: new Set([h("8")]),
    latestRoot: h("0"),
    batches: new Set([h("7")]),
    native: new Map(),
    slowWithdrawTrigger: null,
    pocketSpendAfterObservation: false,
    overdueManualReturnFacts: {
      pocketStateValid: false,
      envelopeOpen: false,
      pendingPullbackZero: false,
      gatewayWithdrawingZero: false,
      slowWithdrawAudited: false,
      pocketReturnAudited: false,
      manualReturnRowValid: false,
      returnReceiptValid: false,
      returnOverdue: false,
      manualReturnRecordedAfter: true,
    },
  };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function fakeProjection(state: State): Projection {
  return {
    freezeState: async () => ({
      frozen: state.frozen,
      guardianPaused: state.guardianPaused,
      observedAt: state.observedAt,
    }),
    isVault: async (vault) => same(vault, VAULT),
    reservation: async (vault) => (same(vault, VAULT) ? state.reservation : undefined),
    pullback: async (vault) => (same(vault, VAULT) ? state.pullback : undefined),
    blockNumber: async () => state.block,
    storedPlan: async (_vault, planHash) =>
      state.plan !== undefined && same(state.plan.planHash, planHash) ? state.plan : undefined,
    envelope: async () => ({ state: state.envelopeState, leaves: state.leaves }),
    pocket: async (pocket) =>
      state.pocket !== undefined &&
      state.pullback !== undefined &&
      same(pocket, state.pullback.pocket)
        ? state.pocket
        : undefined,
    pocketBalances: async () => state.balances,
    nanoSpent: async () => state.nanoSpent,
    settledPayment: async (_vault, paymentRef) => state.settled.has(paymentRefHash(paymentRef)),
    autonomy: async () => state.autonomy,
    job: async () => state.job,
    reportExists: async (hash) => state.reports.has(hash),
    checksCommitExists: async (hash) => state.checksCommits.has(hash),
    latestEvidenceRoot: async () => state.latestRoot,
    evidenceBatchExists: async (root) => state.batches.has(root),
    nativeBalance: async (address) => state.native.get(address.toLowerCase()) ?? 0n,
    slowWithdrawTrigger: async () => state.slowWithdrawTrigger,
    pocketSpendAfterObservation: async () => state.pocketSpendAfterObservation,
    overdueManualReturnFacts: async () => state.overdueManualReturnFacts,
  };
}

export const CALLERS = {
  "cz-15": ["K3", "K4"],
  "cz-24": ["K5"],
  "cz-16": ["K7"],
  "cz-17": ["K8"],
  "cz-20": ["K10"],
  relayer: ["relayer"],
  ops: ["K6", "K20"],
} as const;

/** Wraps a backend so a test can see whether it was ever asked to sign. */
export function spyBackend(inner: SignerBackend) {
  const calls: string[] = [];
  const backend: SignerBackend = {
    ...inner,
    keyRefs: () => inner.keyRefs(),
    address: (ref) => inner.address(ref),
    signDigest: (ref, digest) => {
      calls.push(`digest:${ref}`);
      return inner.signDigest(ref, digest);
    },
    signTransaction: (ref, tx) => {
      calls.push(`tx:${ref}`);
      return inner.signTransaction(ref, tx);
    },
    createKey: (id, service) => inner.createKey(id, service),
    destroyKey: (ref) => inner.destroyKey(ref),
  };
  return { backend, calls };
}

export async function harness(
  options: {
    config?: Record<string, unknown>;
    network?: SignerNetwork;
    projection?: Partial<Projection>;
    prepareTransaction?: TransactionPreparer;
    auditSink?: AuditSink;
    alert?: (message: string) => Promise<void>;
    logger?: Pick<Logger, "error">;
    withoutAlert?: boolean;
    /** Milliseconds; replaces the fixed test clock (and `advance`), e.g. with chain time. */
    nowMs?: () => number;
  } = {},
) {
  const fs = memoryFs();
  const inner = await openLocalKeystore({
    path: "/keystore",
    passphrase: testPassphrase(),
    fs,
    git: async () => undefined,
    kdf: FAST_KDF,
  });
  for (const id of ["K3", "K5", "K6", "K7", "K8", "K20", "relayer"] as const)
    await inner.createKey(id);
  await inner.createKey("K10", "czar-search");
  const { address: pocket } = await inner.createKey("K4");
  const { backend, calls } = spyBackend(inner);
  const state = defaultState(pocket);
  state.job = { evaluator: inner.address("K7") as Address, clientVault: VAULT };
  const audit = memoryAudit();
  const alerts: string[] = [];
  let nowMs = NOW * 1000;
  const prepared: TransactionSerializableEIP1559[] = [];
  const network = options.network ?? NETWORK;
  const projection = Object.assign(fakeProjection(state), options.projection ?? {});
  const signer = createSigner({
    backend,
    projection,
    network,
    config: loadConfig({ envFile: options.config ?? {} }),
    audit: options.auditSink ?? audit,
    ...(options.withoutAlert === true
      ? {}
      : {
          alert:
            options.alert ??
            (async (message: string) => {
              alerts.push(message);
            }),
        }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    callers: CALLERS,
    nowMs: options.nowMs ?? (() => nowMs),
    prepareTransaction:
      options.prepareTransaction ??
      (async (_from, call) => {
        const tx: TransactionSerializableEIP1559 = {
          type: "eip1559",
          chainId: network.chainId,
          nonce: 0,
          gas: 200_000n,
          maxFeePerGas: 20_000_000_000n,
          maxPriorityFeePerGas: 1n,
          to: call.to,
          data: call.data,
          value: call.value,
        };
        prepared.push(tx);
        return tx;
      }),
  });
  return {
    signer,
    backend: inner,
    calls,
    state,
    audit,
    alerts,
    fs,
    pocket,
    prepared,
    advance: (ms: number) => {
      nowMs += ms;
    },
    address: (ref: string) => inner.address(ref) as Address,
  };
}

export const archiveUri = (root: Hash32) => `czar-archive:${root}`;
export const uriHash = (uri: string): Hash32 => keccak256(toBytes(uri));
export type Sig = Hex;
