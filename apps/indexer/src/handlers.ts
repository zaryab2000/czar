import { ponder } from "ponder:registry";
import { and, eq, lt, sum } from "drizzle-orm";
import {
  envelopes,
  authorizations,
  indexedEvents,
  jobs,
  manualReturns,
  pockets,
  pullbacks as pullbackRows,
  reservations,
  reserveRateBuckets,
  stepUsage,
  vaults,
} from "ponder:schema";
import { czarVaultAbi } from "@czar/vault-client";
import { derivedNonce } from "@czar/hashing";
import { envVarName, loadConfig, PARAMETERS } from "@czar/config";
import { createLogger } from "@czar/logging";
import type { Address, Hex } from "viem";
import "#src/register-external-events";
import {
  envelopeMirror,
  jobMirror,
  jobState,
  mirrorKey,
  manualReturnMirror,
  pocketMirror,
  reservationMirror,
  safeNumber,
  type PullbackMirror,
} from "@czar/indexer/mirrors";
import { createLagMonitor, isLiveBucket, lagAlert, reserveRateAlert } from "#src/alerts/rules";
import { createAlertReporter } from "#src/alerts/reporter";

type Context = Parameters<Parameters<typeof ponder.on>[1]>[0]["context"];
type Meta = {
  vault: Address;
  block: bigint;
  timestamp: bigint;
  tx: Hex;
  logIndex: number;
};

const alertConfig = loadConfig({
  env: Object.fromEntries(
    PARAMETERS.flatMap((parameter) => {
      const name = envVarName(parameter.key);
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  ),
});
const reportAlert = createAlertReporter(createLogger({ service: "indexer", component: "CZ-19" }));
const minuteBuckets = 60n;
const MS_PER_SECOND = 1000;
const lagMonitor = createLagMonitor(alertConfig.get("indexer.pollingIntervalMs") as number);

async function recordReserveRate(context: Context, event: Meta): Promise<void> {
  const bucket = event.timestamp / minuteBuckets;
  const vault = event.vault.toLowerCase();
  const id = `${bucket}:${vault}`;
  await context.db
    .insert(reserveRateBuckets)
    .values({ id, bucket, vault, count: 1 })
    .onConflictDoUpdate((row) => ({ count: row.count + 1 }));
  const [vaultBucket] = await context.db.sql
    .select({ count: reserveRateBuckets.count })
    .from(reserveRateBuckets)
    .where(eq(reserveRateBuckets.id, id));
  const limits = alertConfig.get("indexer.reserveRateAlertPerMin") as {
    perVault: number;
    global: number;
  };
  const live = isLiveBucket(
    BigInt(Math.floor(Date.now() / MS_PER_SECOND)),
    event.timestamp,
    minuteBuckets,
  );
  const vaultCount = vaultBucket?.count ?? 0;
  if (live && vaultCount === limits.perVault + 1 && reserveRateAlert(vaultCount, limits.perVault)) {
    reportAlert("reserve-rate", {
      rule: "reserve-rate",
      count: vaultCount,
      vault,
      blockNumber: Number(event.block),
      mode: "per-vault",
    });
  }
  const [globalBucket] = await context.db.sql
    .select({ count: sum(reserveRateBuckets.count) })
    .from(reserveRateBuckets)
    .where(eq(reserveRateBuckets.bucket, bucket));
  const globalCount = Number(globalBucket?.count ?? 0);
  if (live && globalCount === limits.global + 1 && reserveRateAlert(globalCount, limits.global)) {
    reportAlert("reserve-rate", {
      rule: "reserve-rate",
      count: globalCount,
      blockNumber: Number(event.block),
      mode: "global",
    });
  }
  await context.db.sql
    .delete(reserveRateBuckets)
    .where(lt(reserveRateBuckets.bucket, bucket - minuteBuckets));
}

function meta(event: {
  log: { address: Address; logIndex: number };
  block: { number: bigint; timestamp: bigint };
  transaction: { hash: Hex };
}): Meta {
  return {
    vault: event.log.address,
    block: event.block.number,
    timestamp: event.block.timestamp,
    tx: event.transaction.hash,
    logIndex: event.log.logIndex,
  };
}

async function record(context: Context, event: Meta, name: string): Promise<void> {
  await context.db
    .insert(indexedEvents)
    .values({
      id: `${event.tx}:${event.logIndex}`,
      emitter: event.vault.toLowerCase(),
      name,
      block: event.block,
    })
    .onConflictDoNothing();
}

async function refreshEnvelope(
  context: Context,
  event: Meta,
  envelopeId: bigint,
  approvalTx?: Hex,
  closeStarted = false,
): Promise<void> {
  const id = mirrorKey(event.vault, envelopeId);
  const previous = await context.db.find(envelopes, { id });
  const old = previous?.mirror as ReturnType<typeof envelopeMirror> | undefined;
  const tx = approvalTx ?? (old?.approvalTx as Hex | undefined);
  if (!tx) throw new Error(`Envelope ${id} has no EnvelopeOpened transaction`);
  const view = await context.client.readContract({
    address: event.vault,
    abi: czarVaultAbi,
    functionName: "getEnvelope",
    args: [envelopeId],
    blockNumber: event.block,
  });
  const mirror = envelopeMirror({
    vault: event.vault,
    envelopeId,
    view,
    approvalTx: tx,
    block: event.block,
    timestamp: event.timestamp,
    closeStarted: closeStarted || old?.state === "Closing",
  });
  await context.db
    .insert(envelopes)
    .values({
      id,
      vault: event.vault.toLowerCase(),
      envelopeId,
      envelopeRef: mirror.envelopeRef,
      mirror,
    })
    .onConflictDoUpdate({ envelopeRef: mirror.envelopeRef, mirror });
}

async function refreshReservation(
  context: Context,
  event: Meta,
  reservationId: bigint,
): Promise<void> {
  const view = await context.client.readContract({
    address: event.vault,
    abi: czarVaultAbi,
    functionName: "getReservation",
    args: [reservationId],
    blockNumber: event.block,
  });
  const id = mirrorKey(event.vault, reservationId);
  const mirror = reservationMirror(event.vault, reservationId, view);
  await context.db
    .insert(reservations)
    .values({
      id,
      vault: event.vault.toLowerCase(),
      reservationId,
      envelopeId: BigInt(mirror.envelopeId),
      stepIndex: mirror.stepIndex,
      state: mirror.state,
      validBefore: BigInt(mirror.validBefore),
      mirror,
    })
    .onConflictDoUpdate({
      envelopeId: BigInt(mirror.envelopeId),
      stepIndex: mirror.stepIndex,
      state: mirror.state,
      validBefore: BigInt(mirror.validBefore),
      mirror,
    });
  await refreshEnvelope(context, event, view.envelopeId);
}

async function refreshPocket(context: Context, event: Meta, pocket: Address): Promise<void> {
  const id = mirrorKey(event.vault, pocket);
  const previous = await context.db.find(pockets, { id });
  const old = previous?.mirror as ReturnType<typeof pocketMirror> | undefined;
  const view = await context.client.readContract({
    address: event.vault,
    abi: czarVaultAbi,
    functionName: "getPocket",
    args: [pocket],
    blockNumber: event.block,
  });
  const mirror = pocketMirror({
    vault: event.vault,
    pocket,
    view,
    pullbacks: (old?.pullbacks ?? []) as PullbackMirror[],
    // T-032 owns the GatewayWallet.DelegateAdded event source for this state.
    delegateReady: old?.state === "DelegateReady",
  });
  await context.db
    .insert(pockets)
    .values({
      id,
      vault: event.vault.toLowerCase(),
      envelopeId: view.envelopeId,
      pocket: pocket.toLowerCase(),
      mirror,
    })
    .onConflictDoUpdate({ mirror });
  await refreshEnvelope(context, event, view.envelopeId);
}

async function refreshPullback(
  context: Context,
  event: Meta,
  pullbackId: bigint,
  creditedToEnvelope?: boolean,
  requested = false,
): Promise<void> {
  const view = await context.client.readContract({
    address: event.vault,
    abi: czarVaultAbi,
    functionName: "getPullback",
    args: [pullbackId],
    blockNumber: event.block,
  });
  const id = mirrorKey(event.vault, view.pocket);
  const previous = await context.db.find(pockets, { id });
  const old = previous?.mirror as ReturnType<typeof pocketMirror> | undefined;
  if (!old) throw new Error(`Pullback ${pullbackId} references unindexed pocket ${id}`);
  const pullbacks = [...old.pullbacks] as PullbackMirror[];
  const prior = pullbacks.find((item) => item.pullbackId === safeNumber(pullbackId));
  const state = ["None", "Pending", "Confirmed", "Cancelled"][view.state];
  if (state !== "Pending" && state !== "Confirmed" && state !== "Cancelled") {
    throw new Error(`Invalid pullback state ${view.state}`);
  }
  const item: PullbackMirror = {
    pullbackId: safeNumber(pullbackId),
    value: view.value.toString(),
    salt: view.salt.toLowerCase() as Hex,
    maxFee: view.maxFee.toString(),
    maxBlockHeight: safeNumber(view.maxBlockHeight),
    transferSpecHash: view.transferSpecHash.toLowerCase() as Hex,
    requestedAtBlock: safeNumber(view.requestedAtBlock),
    state,
    recovery: view.recovery,
    ...(prior?.creditedToEnvelope === undefined
      ? {}
      : {
          creditedToEnvelope: prior.creditedToEnvelope,
        }),
    ...(creditedToEnvelope === undefined ? {} : { creditedToEnvelope }),
  };
  if (prior) pullbacks[pullbacks.indexOf(prior)] = item;
  else pullbacks.push(item);
  const pocketView = await context.client.readContract({
    address: event.vault,
    abi: czarVaultAbi,
    functionName: "getPocket",
    args: [view.pocket],
    blockNumber: event.block,
  });
  const mirror = pocketMirror({
    vault: event.vault,
    pocket: view.pocket,
    view: pocketView,
    pullbacks,
    // T-032 owns the GatewayWallet.DelegateAdded event source for this state.
    delegateReady: old.state === "DelegateReady",
  });
  await context.db.update(pockets, { id }).set({ mirror });
  const projectionId = `${event.vault.toLowerCase()}:${pullbackId}`;
  const oldProjection = await context.db.find(pullbackRows, { id: projectionId });
  await context.db
    .insert(pullbackRows)
    .values({
      id: projectionId,
      vault: event.vault.toLowerCase(),
      pullbackId: BigInt(pullbackId),
      pocket: view.pocket.toLowerCase(),
      state,
      transferSpecHash: view.transferSpecHash.toLowerCase(),
      maxBlockHeight: view.maxBlockHeight,
      attested: oldProjection?.["attested"] ?? false,
    })
    .onConflictDoUpdate({
      state,
      transferSpecHash: view.transferSpecHash.toLowerCase(),
      maxBlockHeight: view.maxBlockHeight,
    });
  await refreshEnvelope(context, event, pocketView.envelopeId, undefined, requested);
}

async function refreshJob(
  context: Context,
  event: Meta,
  jobKey: Hex,
  opened?: { jobEscrow: Address; evaluator: Address; descriptionHash: Hex },
  stateOverride?: string,
): Promise<void> {
  const id = mirrorKey(event.vault, jobKey);
  const previous = await context.db.find(jobs, { id });
  const old = previous?.mirror as ReturnType<typeof jobMirror> | undefined;
  const details = opened ?? old;
  if (!details) throw new Error(`Job ${id} has no JobOpened metadata`);
  const view = await context.client.readContract({
    address: event.vault,
    abi: czarVaultAbi,
    functionName: "getJob",
    args: [jobKey],
    blockNumber: event.block,
  });
  const fromView = jobMirror({
    vault: event.vault,
    jobKey,
    view,
    jobEscrow: details.jobEscrow,
    evaluator: details.evaluator,
    descriptionHash: details.descriptionHash as Hex,
  });
  const mirror = stateOverride ? { ...fromView, state: stateOverride } : fromView;
  await context.db
    .insert(jobs)
    .values({
      id,
      vault: event.vault.toLowerCase(),
      envelopeId: view.envelopeId,
      jobEscrow: fromView.jobEscrow.toLowerCase(),
      jobId: fromView.jobId,
      stepIndex: fromView.stepIndex,
      state: String(mirror.state),
      createdAt: new Date(Number(event.timestamp) * 1000).toISOString(),
      mirror,
    })
    .onConflictDoUpdate({
      jobEscrow: fromView.jobEscrow.toLowerCase(),
      jobId: fromView.jobId,
      state: String(mirror.state),
      mirror,
    });
  await refreshEnvelope(context, event, view.envelopeId);
}

ponder.on("CzarVaultFactory:VaultCreated", async ({ event, context }) => {
  await record(context, meta(event), "VaultCreated");
  await context.db
    .insert(vaults)
    .values({
      id: event.args.vault.toLowerCase(),
      owner: event.args.ownerAccount.toLowerCase(),
      version: event.args.version,
      agentSigner: event.args.agentSigner.toLowerCase(),
      autonomySigner: event.args.autonomySigner.toLowerCase(),
      evaluator: event.args.evaluator.toLowerCase(),
      createdBlock: event.block.number,
    })
    .onConflictDoNothing();
});

ponder.on("CzarVault:EnvelopeOpened", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "EnvelopeOpened");
  await refreshEnvelope(context, info, event.args.envelopeId, info.tx);
});

ponder.on("CzarVault:EnvelopeClosed", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "EnvelopeClosed");
  await refreshEnvelope(context, info, event.args.envelopeId);
});

ponder.on("CzarVault:EnvelopeForceClosed", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "EnvelopeForceClosed");
  await refreshEnvelope(context, info, event.args.envelopeId);
});

ponder.on("CzarVault:Reserved", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "Reserved");
  await recordReserveRate(context, info);
  await refreshReservation(context, info, event.args.reservationId);
  const reservation = await context.client.readContract({
    address: info.vault,
    abi: czarVaultAbi,
    functionName: "getReservation",
    args: [event.args.reservationId],
    blockNumber: info.block,
  });
  const createdAt = new Date(Number(info.timestamp) * 1000).toISOString();
  const rows = Array.from({ length: reservation.count }, (_, index) => ({
    id: `${info.vault.toLowerCase()}:${event.args.reservationId}:${index}`,
    vault: info.vault.toLowerCase(),
    reservationId: event.args.reservationId,
    index,
    nonce: derivedNonce(info.vault, event.args.reservationId, index),
    amount: reservation.unitAmount.toString(),
    used: false,
    settled: false,
    released: false,
    settlementTx: null,
    createdAt,
  }));
  if (rows.length > 0) await context.db.insert(authorizations).values(rows).onConflictDoNothing();
});

ponder.on("IndexerLag:block", async ({ event, context }) => {
  if (!lagMonitor.shouldCheck(Date.now())) return;
  const head = BigInt(await context.client.request({ method: "eth_blockNumber" }));
  const indexed = event.block.number;
  const lag = lagAlert(head, indexed, alertConfig.get("indexer.maxLagBlocks") as number);
  if (!lagMonitor.observe(lag) || lag === null) return;
  reportAlert("indexer-lag", {
    rule: "indexer-lag",
    count: Number(lag),
    blockNumber: Number(indexed),
  });
});

ponder.on("CzarVault:Settled", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "Settled");
  await context.db.sql
    .update(authorizations)
    .set({ settled: true, released: false, settlementTx: info.tx.toLowerCase() })
    .where(
      and(
        eq(authorizations.vault, info.vault.toLowerCase()),
        eq(authorizations.reservationId, event.args.reservationId),
        eq(authorizations.index, event.args.index),
      ),
    );
  await refreshReservation(context, info, event.args.reservationId);
});

ponder.on("CzarVault:Released", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "Released");
  await context.db.sql
    .update(authorizations)
    .set({ released: true, settled: false })
    .where(
      and(
        eq(authorizations.vault, info.vault.toLowerCase()),
        eq(authorizations.reservationId, event.args.reservationId),
        eq(authorizations.index, event.args.index),
      ),
    );
  await refreshReservation(context, info, event.args.reservationId);
});

ponder.on("CzarVault:ReservationFinal", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "ReservationFinal");
  await refreshReservation(context, info, event.args.reservationId);
});

ponder.on("CzarVault:StepUsed", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "StepUsed");
  const { envelopeId, stepIndex, used } = event.args;
  const id = `${mirrorKey(info.vault, envelopeId)}:${stepIndex}`;
  await context.db
    .insert(stepUsage)
    .values({
      id,
      vault: info.vault.toLowerCase(),
      envelopeId,
      stepIndex,
      used: used.toString(),
      lastEventBlock: info.block,
    })
    .onConflictDoUpdate({ used: used.toString(), lastEventBlock: info.block });
});

ponder.on("CzarVault:PocketRegistered", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "PocketRegistered");
  await refreshPocket(context, info, event.args.pocket);
});

ponder.on("CzarVault:PocketGasGranted", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "PocketGasGranted");
  await refreshPocket(context, info, event.args.pocket);
});

ponder.on("CzarVault:PocketFunded", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "PocketFunded");
  await refreshPocket(context, info, event.args.pocket);
});

ponder.on("CzarVault:PullbackRequested", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "PullbackRequested");
  await refreshPullback(context, info, event.args.pullbackId, undefined, true);
});

ponder.on("CzarVault:PullbackConfirmed", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "PullbackConfirmed");
  await refreshPullback(context, info, event.args.pullbackId, event.args.creditedToEnvelope);
});

ponder.on("CzarVault:PullbackCancelled", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "PullbackCancelled");
  await refreshPullback(context, info, event.args.pullbackId);
});

ponder.on("CzarVault:PocketClosed", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "PocketClosed");
  await refreshPocket(context, info, event.args.pocket);
});

ponder.on("CzarVault:ManualReturnRecorded", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "ManualReturnRecorded");
  await context.db
    .insert(manualReturns)
    .values(
      manualReturnMirror({
        vault: info.vault,
        pocket: event.args.pocket,
        credit: event.args.amount,
        txHash: info.tx,
        logIndex: info.logIndex,
        block: info.block,
      }),
    )
    .onConflictDoNothing();
  await refreshPocket(context, info, event.args.pocket);
});

ponder.on("CzarVault:ShortfallRecorded", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "ShortfallRecorded");
  await refreshEnvelope(context, info, event.args.envelopeId);
});

ponder.on("CzarVault:JobOpened", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "JobOpened");
  await refreshJob(context, info, event.args.jobKey, event.args);
});

ponder.on("CzarVault:JobFunded", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "JobFunded");
  await refreshJob(context, info, event.args.jobKey);
});

ponder.on("CzarVault:JobSynced", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "JobSynced");
  await refreshJob(context, info, event.args.jobKey, undefined, jobState(event.args.state));
});

ponder.on("CzarVault:JobRefunded", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "JobRefunded");
  await refreshJob(context, info, event.args.jobKey);
});

ponder.on("CzarVault:JobCancelled", async ({ event, context }) => {
  const info = meta(event);
  await record(context, info, "JobCancelled");
  await refreshJob(context, info, event.args.jobKey);
});

const factoryAuditEvents = [
  "GuardianPaused",
  "GuardianUnpaused",
  "GuardianQueued",
  "GuardianChanged",
  "DefaultsQueued",
  "DefaultsSet",
  "ChangeCancelled",
] as const;
for (const name of factoryAuditEvents) {
  ponder.on(`CzarVaultFactory:${name}`, async ({ event, context }) => {
    await record(context, meta(event), name);
  });
}

const vaultAuditEvents = [
  "MaxPullbackFeeSet",
  "LimitsSet",
  "AutoLimitRaised",
  "AutoLimitLowered",
  "Frozen",
  "Unfrozen",
  "SignersRotated",
  "PasskeySet",
  "OwnerActionExecuted",
  "Withdrawn",
  "BalanceSynced",
  "NativeReceived",
] as const;
for (const name of vaultAuditEvents) {
  ponder.on(`CzarVault:${name}`, async ({ event, context }) => {
    await record(context, meta(event), name);
  });
}
