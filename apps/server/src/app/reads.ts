import type { Config } from "@czar/config";
import { validateRecordedExchange } from "@czar/api-contract";
import { categoryHash, derivedNonce, paymentRefHash } from "@czar/hashing";
import type {
  AppPage,
  Envelope,
  EnvelopeDetail,
  JobRecord,
  LedgerReceipt,
  Me,
  PaymentRef,
  Plan,
} from "@czar/schemas";
import { getVaultFactory, readPinnedVaultState } from "@czar/vault-client";
import { createPublicClient, defineChain, http, type Address } from "viem";
import type { Context } from "hono";
import type { Pool } from "pg";
import { USDC_ADDRESS } from "@czar/x402";
import { problem } from "#src/http/problem";
import { RequestValidationError } from "#src/http/validate";

export interface AppReadOptions {
  readonly rpcUrl: string;
  readonly factoryAddress: Address;
  readonly indexerUrl: string;
}

export interface AppReadDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly options?: AppReadOptions;
}

type ServerContext = Context<any, any, any>;

export async function getMeRoute(
  context: ServerContext,
  dependencies: AppReadDependencies,
): Promise<Response> {
  const userId = context.get("appUserId") as string | undefined;
  if (!userId) return problemResponse(context, 401, "validation");
  const user = await dependencies.pool.query<{
    msca: string | null;
    network: string;
    mode: "shadow" | "live";
    shadow_ends_at: Date | null;
  }>("SELECT msca,network,mode,shadow_ends_at FROM users WHERE user_id=$1", [userId]);
  const row = user.rows[0];
  if (!row?.msca) return problemResponse(context, 404, "validation");
  const options = readOptions(dependencies.options);
  const categories = knownCategories(dependencies.config);
  const chainId = parseChainId(row.network);
  const chain = defineChain({
    id: chainId,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: [options.rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(options.rpcUrl) });
  const blockNumber = await client.getBlockNumber();
  const [block, indexedVault, mscaBalance] = await Promise.all([
    client.getBlock({ blockNumber }),
    indexedVaultForOwner(options.indexerUrl, row.msca),
    client.readContract({
      address: USDC_ADDRESS,
      abi: [
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "balance", type: "uint256" }],
        },
      ],
      functionName: "balanceOf",
      args: [row.msca as Address],
      blockNumber,
    }),
  ]);
  const factory = getVaultFactory(options.factoryAddress, client);
  const predicted = await factory.read.predictVault([row.msca as Address], { blockNumber });
  const vault = (indexedVault?.vault ?? predicted) as Address;
  const vaultCreated = indexedVault !== null;
  const categoryIds = categories.map((category) => categoryHash(category));
  const chainState = vaultCreated
    ? await readPinnedVaultState({
        client,
        factory: options.factoryAddress,
        usdc: USDC_ADDRESS as Address,
        msca: row.msca as Address,
        vault,
        categoryIds,
        blockNumber,
      })
    : undefined;
  const periodLengthSeconds = dependencies.config.get(
    "signer.projection.periodLengthSeconds",
  ) as number;
  const periodId = Number(block.timestamp / BigInt(periodLengthSeconds));
  const pockets = vaultCreated ? await sumOpenEnvelopePockets(options.indexerUrl, vault) : 0n;
  const response: Me = {
    userId,
    msca: row.msca,
    vault,
    vaultCreated,
    network: row.network,
    balances: {
      vaultBalance: (chainState?.vaultBalance ?? 0n).toString(),
      free: (chainState?.free ?? 0n).toString(),
      committed: (chainState?.committed ?? 0n).toString(),
      mscaBalance: mscaBalance.toString(),
      pocketOutstanding: pockets.toString(),
      asOfBlock: Number(blockNumber),
    },
    limits: (chainState?.limits ?? []).flatMap((limit) => {
      const category = categories[categoryIds.indexOf(limit.categoryId)];
      if (category === undefined) return [];
      return [
        {
          category,
          userMax: limit.userMax.toString(),
          autoLimit: limit.autoLimit.toString(),
          usedThisPeriod: limit.periodId === BigInt(periodId) ? limit.usedInPeriod.toString() : "0",
          periodId,
          periodEndsAt: new Date((periodId + 1) * periodLengthSeconds * 1000).toISOString(),
        },
      ];
    }),
    mode: row.mode,
    ...(row.shadow_ends_at ? { shadowEndsAt: row.shadow_ends_at.toISOString() } : {}),
    frozen: chainState?.frozen ?? false,
    paused: chainState?.paused ?? false,
    displayCurrency: "USD",
  };
  if (vaultCreated && row.msca) {
    await dependencies.pool.query(
      "UPDATE users SET vault=$2 WHERE user_id=$1 AND vault IS DISTINCT FROM $2",
      [userId, vault],
    );
  }
  assertExchange("getMe", response);
  const bundlerOrder = dependencies.config.get("app.bundlerOrder") as readonly string[];
  context.header("X-Czar-Bundler-Order", bundlerOrder.join(","));
  context.header(
    "X-Czar-Bundler-Endpoints",
    JSON.stringify(dependencies.config.get("app.bundlerEndpoints")),
  );
  return context.json(response);
}

function knownCategories(config: Config): string[] {
  const mapping = config.get("planner.categoryByCapability") as Record<string, string>;
  return [...new Set(Object.values(mapping))].toSorted();
}

export async function listEnvelopesRoute(
  context: ServerContext,
  dependencies: AppReadDependencies,
): Promise<Response> {
  const userId = context.get("appUserId") as string | undefined;
  if (!userId) return problemResponse(context, 401, "validation");
  const user = await dependencies.pool.query<{ msca: string | null }>(
    "SELECT msca FROM users WHERE user_id=$1",
    [userId],
  );
  const msca = user.rows[0]?.msca;
  if (!msca) return problemResponse(context, 404, "validation");
  const options = readOptions(dependencies.options);
  const vault = await indexedVaultForOwner(options.indexerUrl, msca);
  if (!vault) return context.json({ items: [], nextCursor: null } satisfies AppPage<Envelope>);
  const params = parsePage(context, dependencies.config);
  const state = new URL(context.req.url).searchParams.get("state");
  if (state && !["Open", "Closing", "Closed"].includes(state)) throw new RequestValidationError();
  const page = await indexerPage<Envelope>(options.indexerUrl, vault.vault, params);
  const items = state ? page.items.filter((item) => item.state === state) : page.items;
  const response: AppPage<Envelope> = { items, nextCursor: page.nextCursor };
  assertExchange("listEnvelopes", response);
  return context.json(response);
}

export async function getEnvelopeRoute(
  context: ServerContext,
  dependencies: AppReadDependencies,
): Promise<Response> {
  const userId = context.get("appUserId") as string | undefined;
  if (!userId) return problemResponse(context, 401, "validation");
  const user = await dependencies.pool.query<{ msca: string | null }>(
    "SELECT msca FROM users WHERE user_id=$1",
    [userId],
  );
  const msca = user.rows[0]?.msca;
  if (!msca) return problemResponse(context, 404, "validation");
  const options = readOptions(dependencies.options);
  const vault = await indexedVaultForOwner(options.indexerUrl, msca);
  if (!vault) return problemResponse(context, 404, "validation");
  const envelopeRef = context.req.param("envelopeRef");
  if (!envelopeRef) return problemResponse(context, 404, "validation");
  const detail = await indexerJson<EnvelopeDetail>(
    options.indexerUrl,
    `/envelopes/${encodeURIComponent(envelopeRef)}`,
  );
  if (detail.envelope.vault.toLowerCase() !== vault.vault.toLowerCase()) {
    return problemResponse(context, 404, "validation");
  }
  assertExchange("getEnvelope", detail);
  return context.json(detail);
}

export async function listReceiptsRoute(
  context: ServerContext,
  dependencies: AppReadDependencies,
): Promise<Response> {
  const userId = context.get("appUserId") as string | undefined;
  if (!userId) return problemResponse(context, 401, "validation");
  const user = await dependencies.pool.query<{ msca: string | null; network: string }>(
    "SELECT msca,network FROM users WHERE user_id=$1",
    [userId],
  );
  const row = user.rows[0];
  if (!row?.msca) return problemResponse(context, 404, "validation");
  const options = readOptions(dependencies.options);
  const vault = await indexedVaultForOwner(options.indexerUrl, row.msca);
  if (!vault) return context.json({ items: [], nextCursor: null } satisfies AppPage<LedgerReceipt>);
  const page = parsePage(context, dependencies.config);
  const params = new URLSearchParams({ vault: vault.vault, limit: String(page.limit) });
  if (page.cursor) params.set("cursor", page.cursor);
  const facts = await indexerJson<AppPage<ReceiptFact>>(
    options.indexerUrl,
    `/receipts?${params.toString()}`,
  );
  const details = await loadReceiptDetails(options.indexerUrl, facts.items);
  const plans = await plansForReceipts(dependencies.pool, userId, facts.items);
  const configuredMerchants = dependencies.config.get(
    "indexer.merchantPayoutAddresses",
  ) as readonly string[];
  const merchantAddresses = new Set<string>(
    configuredMerchants.map((address) => address.toLowerCase()),
  );
  const items = facts.items.map((fact) => {
    const detail = details.get(fact.envelopeRef);
    const objective = plans.get(fact.envelopeRef);
    if (!detail || !objective?.plan)
      throw new Error("Receipt is missing its indexed envelope or plan.");
    return toLedgerReceipt(
      fact,
      detail,
      objective.objectiveId,
      objective.plan,
      row.network,
      merchantAddresses,
    );
  });
  const response: AppPage<LedgerReceipt> = { items, nextCursor: facts.nextCursor };
  assertExchange("listReceipts", response);
  return context.json(response);
}

export async function sumOpenEnvelopePockets(indexerUrl: string, vault: Address): Promise<bigint> {
  let cursor: string | null = null;
  let total = 0n;
  do {
    const page: AppPage<Envelope> = await indexerPage<Envelope>(indexerUrl, vault, {
      cursor,
      limit: 200,
    });
    for (const envelope of page.items) {
      if (envelope.state !== "Open") continue;
      const detail = await indexerJson<EnvelopeDetail>(
        indexerUrl,
        `/envelopes/${encodeURIComponent(envelope.envelopeRef)}`,
      );
      for (const pocket of detail.pockets) total += BigInt(pocket.outstanding);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return total;
}

async function indexedVaultForOwner(
  baseUrl: string,
  owner: string,
): Promise<{ readonly vault: Address } | null> {
  const response = await fetch(new URL(`/vaults?owner=${encodeURIComponent(owner)}`, baseUrl));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Indexer owner-vault lookup failed (${response.status}).`);
  const body = (await response.json()) as { vault?: unknown };
  if (typeof body.vault !== "string" || !/^0x[\da-fA-F]{40}$/.test(body.vault)) {
    throw new Error("Indexer returned an invalid vault address.");
  }
  return { vault: body.vault as Address };
}

async function indexerPage<T>(
  baseUrl: string,
  vault: Address,
  page: { readonly cursor: string | null; readonly limit: number },
): Promise<AppPage<T>> {
  const params = new URLSearchParams({ vault, limit: String(page.limit) });
  if (page.cursor) params.set("cursor", page.cursor);
  return indexerJson<AppPage<T>>(baseUrl, `/envelopes?${params.toString()}`);
}

interface ReceiptFact {
  readonly id: string;
  readonly envelopeRef: string;
  readonly stepIndex: number | null;
  readonly reservationId: string | null;
  readonly index: number | null;
  readonly transferId: string | null;
  readonly jobKey: string | null;
  readonly payer: string | null;
  readonly payee: string | null;
  readonly nonce: string | null;
  readonly validBefore: number | null;
  readonly transferTx: string | null;
  readonly amount: string;
  readonly rail: LedgerReceipt["rail"];
  readonly status: LedgerReceipt["status"];
  readonly settlementTx: string | null;
  readonly createdAt: string;
}

interface ReceiptPlanRow {
  readonly objective_id: string;
  readonly envelope_ref: string;
  readonly plan: Plan | null;
}

async function loadReceiptDetails(
  indexerUrl: string,
  facts: readonly ReceiptFact[],
): Promise<Map<string, EnvelopeDetail>> {
  const refs = [...new Set(facts.map((fact) => fact.envelopeRef))];
  const entries = await Promise.all(
    refs.map(
      async (ref) =>
        [
          ref,
          await indexerJson<EnvelopeDetail>(indexerUrl, `/envelopes/${encodeURIComponent(ref)}`),
        ] as const,
    ),
  );
  return new Map(entries);
}

async function plansForReceipts(
  pool: Pool,
  userId: string,
  facts: readonly ReceiptFact[],
): Promise<Map<string, { readonly objectiveId: string; readonly plan: Plan | null }>> {
  const refs = [...new Set(facts.map((fact) => fact.envelopeRef))];
  if (refs.length === 0) return new Map();
  const result = await pool.query<ReceiptPlanRow>(
    `SELECT o.objective_id,o.envelope_ref,p.plan
     FROM objectives o LEFT JOIN plans p ON p.plan_id=o.plan_id
     WHERE o.user_id=$1 AND o.envelope_ref=ANY($2::text[])`,
    [userId, refs],
  );
  return new Map(
    result.rows.map((row) => [row.envelope_ref, { objectiveId: row.objective_id, plan: row.plan }]),
  );
}

function toLedgerReceipt(
  fact: ReceiptFact,
  detail: EnvelopeDetail,
  objectiveId: string,
  plan: Plan,
  network: string,
  czarMerchants: ReadonlySet<string>,
): LedgerReceipt {
  const stepIndex =
    fact.stepIndex ?? plan.steps.find((step) => step.kind === "gateway-nano")?.stepIndex;
  if (stepIndex === undefined) throw new Error("Receipt does not map to a step in its plan.");
  const step = plan.steps.find((item) => item.stepIndex === stepIndex);
  const job =
    fact.rail === "erc8183-job"
      ? detail.jobs.find((item) => item.jobKey === fact.jobKey)
      : undefined;
  const payment = paymentReference(fact, detail.envelope.vault, network, job);
  const payee = paymentPayee(payment);
  const settlementTx =
    fact.settlementTx ?? (fact.rail === "gateway-batched" ? fact.transferTx : null);
  return {
    objectiveId,
    envelopeRef: fact.envelopeRef,
    stepIndex,
    amount: fact.amount,
    amountDisplay: formatUsd(fact.amount),
    rail: fact.rail,
    status: fact.status,
    merchantIsCzar: czarMerchants.has(payee.toLowerCase()),
    merchantLabel: step?.resource?.url ? new URL(step.resource.url).host : payee,
    paymentRefHash: paymentRefHash(payment),
    ...(settlementTx ? { settlementTx: settlementTx as `0x${string}` } : {}),
    createdAt: fact.createdAt,
  };
}

function paymentReference(
  fact: ReceiptFact,
  vault: string,
  network: string,
  job: JobRecord | undefined,
): PaymentRef {
  if (fact.rail === "x402-exact") {
    if (
      fact.reservationId === null ||
      fact.index === null ||
      fact.nonce === null ||
      fact.payee === null ||
      fact.validBefore === null
    )
      throw new Error("x402 receipt is missing payment facts.");
    const expectedNonce = derivedNonce(vault as Address, BigInt(fact.reservationId), fact.index);
    if (expectedNonce.toLowerCase() !== fact.nonce.toLowerCase())
      throw new Error("Indexer returned a mismatched authorization nonce.");
    return {
      schemaVersion: "1.0",
      rail: "x402-exact",
      network,
      asset: USDC_ADDRESS,
      payer: vault,
      payTo: fact.payee,
      amount: fact.amount,
      nonce: fact.nonce,
      validBefore: fact.validBefore,
      reservationId: Number(fact.reservationId),
      index: fact.index,
    };
  }
  if (fact.rail === "gateway-batched") {
    if (
      fact.payer === null ||
      fact.payee === null ||
      fact.nonce === null ||
      fact.transferId === null
    ) {
      throw new Error("Gateway receipt is missing payment facts.");
    }
    return {
      schemaVersion: "1.0",
      rail: "gateway-batched",
      network,
      payer: fact.payer,
      payTo: fact.payee,
      amount: fact.amount,
      nonce: fact.nonce,
      transferId: fact.transferId,
    };
  }
  if (!job || job.jobKey !== fact.jobKey) throw new Error("Job receipt is missing its job record.");
  return {
    schemaVersion: "1.0",
    rail: "erc8183-job",
    network,
    contract: job.jobEscrow,
    jobId: job.jobId,
    client: vault,
    provider: job.provider,
    evaluator: job.evaluator,
    budget: job.budget ?? job.reservedCap,
  };
}

function paymentPayee(payment: PaymentRef): string {
  if (payment.rail === "erc8183-job") return payment.provider;
  return payment.payTo;
}

function formatUsd(amount: string): string {
  const value = BigInt(amount);
  const whole = (value / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let fraction = (value % 1_000_000n).toString().padStart(6, "0");
  while (fraction.length > 2 && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `$${whole}.${fraction}`;
}

async function indexerJson<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(new URL(path, baseUrl));
  if (!response.ok) throw new Error(`Indexer request failed (${response.status}).`);
  return (await response.json()) as T;
}

function parsePage(
  context: ServerContext,
  config: Config,
): { readonly cursor: string | null; readonly limit: number } {
  const query = new URL(context.req.url).searchParams;
  const limit = Number(query.get("limit") ?? config.get("api.pageDefaultLimit"));
  if (
    !Number.isSafeInteger(limit) ||
    limit < Number(config.get("api.pageMinLimit")) ||
    limit > Number(config.get("api.pageMaxLimit"))
  )
    throw new RequestValidationError();
  return { cursor: query.get("cursor"), limit };
}

function readOptions(input: AppReadOptions | undefined): AppReadOptions {
  const options = input ?? {
    rpcUrl: process.env["CZAR_ARC_RPC_URL"] ?? "",
    factoryAddress: (process.env["CZAR_VAULT_FACTORY_ADDRESS"] ?? "") as Address,
    indexerUrl: process.env["CZAR_INDEXER_URL"] ?? "",
  };
  if (!options.rpcUrl || !options.indexerUrl || !/^0x[\da-fA-F]{40}$/.test(options.factoryAddress))
    throw new Error("App reads need ARC RPC, vault factory and indexer endpoints configured.");
  return options;
}

function parseChainId(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  const value = Number(match?.[1]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("User network is invalid.");
  return value;
}

function assertExchange(operationId: string, body: unknown): void {
  if (!validateRecordedExchange(operationId, { responseStatus: 200, responseBody: body }).valid) {
    throw new Error(`Server response failed ${operationId} contract validation.`);
  }
}

function problemResponse(context: ServerContext, status: 401 | 404, code: "validation"): Response {
  return context.json(problem(status, code), status, {
    "Content-Type": "application/problem+json",
  });
}
