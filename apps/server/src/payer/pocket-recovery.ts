import type { Config } from "@czar/config";
import type { Logger } from "@czar/logging";
import type { Plan } from "@czar/schemas";
import type { Signer } from "@czar/signer";
import type { SafeFetch } from "@czar/x402";
import type { Pool } from "pg";
import type { Address, PublicClient, WalletClient } from "viem";
import { executePullback, executeSlowPullbackFallback } from "#src/payer/pullback";
import type { PocketHaltDependencies, PocketCloseDependencies } from "#src/payer/pocket";
import { createIndexerPocketReader } from "#src/payer/indexer-pocket";
import { createPullbackChainAdapter } from "#src/payer/pullback-chain-adapter";
import { createPullbackExecutionChain } from "#src/payer/pullback-execution-chain";

export interface PocketRecoveryInput {
  readonly pool: Pool;
  readonly config: Config;
  readonly logger: Logger;
  readonly signer: Pick<Signer, "sign">;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly safeFetch: SafeFetch;
  readonly indexerUrl: string;
  readonly gatewayMinter: Address;
  readonly gatewayDomain: number;
  readonly gatewayTransferUrl?: string;
  readonly now: () => Date;
}

export interface PocketRecoveryOperations {
  readonly halt: PocketHaltDependencies;
  readonly runClosedPocketRecovery: () => Promise<number>;
  readonly recoverLateGatewayBalance: PocketCloseDependencies["recoverLateGatewayBalance"];
}

interface PocketPlanContext {
  readonly planId: string;
  readonly envelopeRef: string;
  readonly vault: Address;
  readonly plan: Plan;
}

export function createPocketRecoveryOperations(
  input: PocketRecoveryInput,
): PocketRecoveryOperations {
  const reader = createIndexerPocketReader(
    input.indexerUrl,
    Number(input.config.get("fetch.timeoutMs")),
  );
  return {
    halt: {
      listFundedPockets: async (vault) =>
        (await reader.fundedPocketsForVault(vault))
          .filter((entry) => entry.state === "Funded" || entry.state === "Draining")
          .map((entry) => entry.pocket),
      pullback: async (pocket) => {
        const context = await readPocketPlanContext(input.pool, pocket);
        const projection = (await reader.fundedPocketsForVault(context.vault)).find(
          (entry) => entry.pocket.toLowerCase() === pocket.toLowerCase(),
        );
        if (!projection) throw new Error("Funded pocket is missing from the indexer projection.");
        const result = await executeFromBalance(input, reader, context, pocket, {
          outstanding: projection.outstanding,
          pending: projection.pendingPullback,
          closedPocket: false,
        });
        if (result.state === "waiting")
          throw new Error(`Pocket pullback is waiting: ${result.reason}.`);
      },
    },
    async runClosedPocketRecovery() {
      const pockets = await reader.closedPocketsWithBalance();
      for (const pocket of pockets) {
        try {
          await recoverClosedPocket(input, reader, pocket.pocket, pocket.vault, false);
        } catch {
          input.logger.error("closed_pocket_recovery_failed", {
            rule: "closed-pocket-recovery",
            state: "error",
          });
        }
      }
      return pockets.length;
    },
    async recoverLateGatewayBalance({ vault, pocket }) {
      const result = await recoverClosedPocket(input, reader, pocket, vault, true);
      if (result === "waiting")
        throw new Error("Late Gateway balance recovery is waiting for a fresh observation.");
    },
  };
}

async function recoverClosedPocket(
  input: PocketRecoveryInput,
  reader: ReturnType<typeof createIndexerPocketReader>,
  pocket: Address,
  vault: Address,
  closeMustComplete: boolean,
): Promise<"done" | "waiting"> {
  const context = await readPocketPlanContext(input.pool, pocket);
  if (context.vault.toLowerCase() !== vault.toLowerCase())
    throw new Error("Closed pocket projection does not match its linked vault.");
  const balance = await reader.pocketBalance(pocket);
  if (balance.gatewayWithdrawingAtomic > 0n) {
    const slow = await runClosedSlowReturn(input, context, pocket, balance.gatewayAvailableAtomic);
    return slow === "waiting" && closeMustComplete ? "waiting" : slow;
  }
  const result = await executeFromBalance(
    input,
    reader,
    context,
    pocket,
    {
      outstanding: 0n,
      pending: 0n,
      closedPocket: true,
    },
    balance,
  );
  if (result.state === "waiting" && result.reason === "closed-pocket-dust")
    return runClosedSlowReturn(input, context, pocket, balance.gatewayAvailableAtomic);
  if (result.state === "waiting" && closeMustComplete) return "waiting";
  return "done";
}

async function runClosedSlowReturn(
  input: PocketRecoveryInput,
  context: PocketPlanContext,
  pocket: Address,
  observedBalance: bigint,
): Promise<"done" | "waiting"> {
  const chain = createPullbackChainAdapter(
    input.publicClient,
    input.walletClient,
    input.config.get("chain.gatewayWalletAddress") as Address,
    { config: input.config, logger: input.logger },
  );
  const result = await executeSlowPullbackFallback(
    {
      planId: context.planId,
      stepIndex: firstGatewayStepIndex(context.plan),
      envelopeRef: context.envelopeRef,
      pocket,
      apiUnavailableSince: input.now(),
      value: observedBalance,
      trigger: "closed-dust",
      closedPocketRecovery: true,
    },
    { pool: input.pool, config: input.config, signer: input.signer, chain, now: input.now },
  );
  return result.state === "returned-to-vault" ? "done" : "waiting";
}

async function executeFromBalance(
  input: PocketRecoveryInput,
  reader: ReturnType<typeof createIndexerPocketReader>,
  context: PocketPlanContext,
  pocket: Address,
  accounting: {
    readonly outstanding: bigint;
    readonly pending: bigint;
    readonly closedPocket: boolean;
  },
  knownBalance?: Awaited<ReturnType<typeof reader.pocketBalance>>,
) {
  const balance = knownBalance ?? (await reader.pocketBalance(pocket));
  const stepIndex = firstGatewayStepIndex(context.plan);
  return executePullback(
    {
      planId: context.planId,
      stepIndex,
      envelopeRef: context.envelopeRef,
      vault: context.vault,
      pocket,
      gatewayWallet: input.config.get("chain.gatewayWalletAddress") as Address,
      gatewayMinter: input.gatewayMinter,
      usdc: input.config.get("chain.usdcAddress") as Address,
      gatewayDomain: input.gatewayDomain,
      outstanding: accounting.outstanding,
      pending: accounting.pending,
      availableBalance: balance.gatewayAvailableAtomic,
      availableBalanceObservedAt: balance.apiObservedAt,
      apiConsecutiveFailures: balance.apiConsecutiveFailures,
      closedPocket: accounting.closedPocket,
      head: await input.publicClient.getBlockNumber(),
    },
    {
      pool: input.pool,
      config: input.config,
      signer: input.signer,
      chain: createPullbackExecutionChain({
        client: input.publicClient,
        pool: input.pool,
        vault: context.vault,
        gatewayMinter: input.gatewayMinter,
      }),
      safeFetch: input.safeFetch,
      gatewayTransferUrl:
        input.gatewayTransferUrl ?? `${input.config.get("chain.gatewayApiBaseUrl")}/v1/transfer`,
      now: input.now,
    },
  );
}

async function readPocketPlanContext(pool: Pool, pocket: Address): Promise<PocketPlanContext> {
  const result = await pool.query<{
    readonly plan_id: string;
    readonly envelope_ref: string | null;
    readonly vault: string;
    readonly plan: Plan;
  }>(
    `SELECT p.plan_id,o.envelope_ref,u.vault,p.plan FROM plan_pocket_keys k
     JOIN plans p ON p.plan_id=k.plan_id
     JOIN objectives o ON o.objective_id=p.objective_id
     JOIN users u ON u.user_id=o.user_id
     WHERE lower(k.pocket_address)=lower($1) LIMIT 1`,
    [pocket],
  );
  const row = result.rows[0];
  if (!row?.envelope_ref || !row.vault)
    throw new Error("Pocket key is missing its plan, envelope, or vault link.");
  return {
    planId: row.plan_id,
    envelopeRef: row.envelope_ref,
    vault: row.vault as Address,
    plan: row.plan,
  };
}

function firstGatewayStepIndex(plan: Plan): number {
  const step = plan.steps.find((candidate) => candidate.kind === "gateway-nano");
  if (!step) throw new Error("Pocket plan has no Gateway step for pullback recovery.");
  return step.stepIndex;
}
