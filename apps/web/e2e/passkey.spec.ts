import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import type { AppPlan, AppWalletConfig, ApprovalIntent, Me } from "@czar/schemas";
import {
  buildTree,
  categoryHash,
  PAYEE_KIND,
  payeeLeaf,
  planHash,
  taskSpecHash,
} from "@czar/hashing";
import {
  encodeFreezeAction,
  encodeOpenEnvelope,
  getVault,
  getVaultFactory,
  readPinnedVaultState,
} from "@czar/vault-client";
import { createPublicClient, defineChain, http, parseAbiItem, type Address, type Hex } from "viem";

const ARC_RPC = "http://127.0.0.1:8549";
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const CATEGORIES = ["research", "data", "creative", "general"] as const;

test("creates a passkey and later completes createSession", async ({ page, browserName }) => {
  test.setTimeout(90_000);
  test.skip(browserName !== "chromium", "Playwright CDP virtual authenticator requires Chromium.");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const authenticator = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  let challengeRequests = 0;
  let registrations = 0;
  let assertions = 0;
  let submittedNotices = 0;
  let registeredMsca: Address | undefined;
  // SCR-157 §3: the factory and RP ID come from the server's wallet-config, as the app reads them.
  let vaultFactory: Address | undefined;
  let webauthnRpId: string | undefined;
  let walletConfigRequests = 0;
  const requestPaths: string[] = [];
  const { plan, intent } = approvalFixture();
  page.on("request", (request) => {
    const url = new URL(request.url());
    requestPaths.push(url.pathname);
    if (url.pathname === "/v1/app/wallet-config") {
      walletConfigRequests += 1;
      expect(request.headers()["authorization"]).toBeUndefined();
    }
    if (url.pathname === "/v1/auth/challenge") challengeRequests += 1;
    if (url.pathname === "/v1/auth/passkey") {
      registrations += 1;
      const body = request.postDataJSON() as { credentialId?: string; msca?: string };
      expect(body.credentialId).toBeTruthy();
      expect(body.msca).toMatch(/^0x[\da-fA-F]{40}$/);
      registeredMsca = body.msca as Address;
    }
    if (url.pathname === "/v1/auth/session") assertions += 1;
  });
  await page.route("**/v1/approvals**", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: {
        "X-Czar-Pending-Poll-Seconds": "15",
        "X-Czar-Approval-Confirm-Timeout-Seconds": "120",
      },
      body: JSON.stringify({ items: [], nextCursor: null }),
    }),
  );
  await page.route("**/v1/envelopes/*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        envelope: { planHash: plan.planHash },
        reservations: [],
        pockets: [],
        jobs: [],
      }),
    }),
  );
  await page.route("**/v1/ledger/receipts**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], nextCursor: null }),
    }),
  );
  await page.route(`**/v1/approvals/${plan.planId}`, (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: { "X-Czar-Large-Cap-Warn-Bps": "5000" },
      body: JSON.stringify(plan),
    }),
  );
  await page.route(`**/v1/approvals/${plan.planId}/intent`, async (route) => {
    const request = route.request().postDataJSON() as { fillInPlace?: boolean };
    expect(request.fillInPlace).toBe(true);
    const account = await accountMe(registeredMsca!, vaultFactory!);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...intent, vault: account.vault, to: account.vault }),
    });
  });
  await page.route(`**/v1/approvals/${plan.planId}/submitted`, async (route) => {
    const request = route.request().postDataJSON() as { userOpHash?: string; bundler?: string };
    expect(request.userOpHash).toMatch(/^0x[\da-fA-F]{64}$/);
    expect(request.bundler).toBe("circle");
    submittedNotices += 1;
    await route.fulfill({ status: 202, body: "" });
  });
  await page.route("**/v1/freeze/intent", async (route) => {
    const request = route.request().postDataJSON() as { action?: "freeze" | "unfreeze" };
    expect(request.action === "freeze" || request.action === "unfreeze").toBe(true);
    const account = await accountMe(registeredMsca!, vaultFactory!);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        vault: account.vault,
        to: account.vault,
        calldata: encodeFreezeAction(request.action!),
        value: "0",
        chainId: 5042002,
      }),
    });
  });
  await page.goto("/onboarding/passkey");
  const walletConfigResponsePromise = page.waitForResponse((response) => {
    return new URL(response.url()).pathname === "/v1/app/wallet-config";
  });
  await page.getByRole("button", { name: "Create passkey" }).click();
  const walletConfigResponse = await walletConfigResponsePromise;
  await expect(
    page.getByText("Passkey created. Your Czar account is ready to set up."),
  ).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Verify passkey sign-in" }).click();
  await expect.poll(() => assertions).toBe(1);
  expect(challengeRequests).toBe(2);
  expect(walletConfigRequests).toBe(1);
  expect(requestPaths.indexOf("/v1/app/wallet-config")).toBeLessThan(
    requestPaths.indexOf("/v1/auth/challenge"),
  );
  expect(walletConfigResponse.headers()["cache-control"]).toBe("no-store");
  const walletConfig = (await walletConfigResponse.json()) as AppWalletConfig;
  expect(walletConfig).toMatchObject({
    circleClientUrl: "http://127.0.0.1:4337",
    circleClientKey: "e2e-public-client-key",
    arcRpcUrl: ARC_RPC,
  });
  vaultFactory = walletConfig.vaultFactory as Address;
  webauthnRpId = walletConfig.webauthnRpId;
  expect(registrations).toBe(1);
  expect(registeredMsca).toBeDefined();
  await rpc("anvil_setBalance", [registeredMsca, "0x3635c9adc5dea00000"]);
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole("heading", { name: "Finish setting up your vault" })).toBeVisible();
  await page.getByRole("link", { name: "Continue setup" }).click();
  const feeReserve = BigInt((await accountMe(registeredMsca!, vaultFactory!)).balances.mscaBalance);
  await expect(
    page.getByText(`Network fee reserve: ${formatAmount(feeReserve)} USDC`),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByText("Your vault is ready.")).toBeVisible({ timeout: 30_000 });
  await page.goto("/onboarding/limits");
  const maximums = page.locator('input[inputmode="decimal"]');
  await expect(maximums).toHaveCount(8);
  for (const index of [0, 2, 4, 6]) await maximums.nth(index).fill("1");
  await page.getByRole("button", { name: "Save weekly limits" }).click();
  await expect
    .poll(
      async () =>
        (await accountMe(registeredMsca!, vaultFactory!)).limits.filter(
          (limit) => limit.userMax === "1000000",
        ).length,
    )
    .toBe(4);
  await expect(page.getByText("Limits submitted. Waiting for LimitsSet to sync…")).toBeVisible();
  await expect
    .poll(async () => {
      const account = await accountMe(registeredMsca!, vaultFactory!);
      const response = await page.request.get(
        `http://127.0.0.1:42070/__e2e/events?vault=${account.vault}`,
      );
      const indexed = (await response.json()) as { limitsSet: number };
      return indexed.limitsSet;
    })
    .toBe(4);
  await page.goto("/home");
  await expect(page.getByRole("heading", { name: "Your Czar account" })).toBeVisible();
  await page.goto("/approvals");
  await expect(page.getByRole("heading", { name: "Approvals" })).toBeVisible();
  const account = await accountMe(registeredMsca!, vaultFactory!);
  await rpc("anvil_setBalance", [account.vault, "0x3635c9adc5dea00000"]);
  const client = createPublicClient({
    chain: defineChain({
      id: 5042002,
      name: "Arc Testnet",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
      rpcUrls: { default: { http: [ARC_RPC] } },
    }),
    transport: http(ARC_RPC),
  });
  const vaultPasskey = await getVault(account.vault as Address, client).read.getPasskey();
  expect(vaultPasskey.set).toBe(true);
  expect(vaultPasskey.rpIdHash).toBe(
    `0x${createHash("sha256").update(webauthnRpId!).digest("hex")}`,
  );
  const beforeApproval = await client.getBlockNumber();
  await page.goto(`/approve/${plan.planId}`);
  await page.getByRole("button", { name: "Approve $1.00" }).click();
  await expect(page.getByText("Envelope opened. Czar is working on it.")).toBeVisible();
  await expect.poll(() => submittedNotices).toBe(1);
  const opened = await client.getLogs({
    address: account.vault as Address,
    event: parseAbiItem(
      "event EnvelopeOpened(uint64 indexed envelopeId, bytes32 indexed categoryId, bytes32 indexed objectiveHash, uint256 cap, bytes32 planHash, bytes32 payeeRoot, uint256 maxStepAmount, uint16 pocketCapBps, uint64 expiresAt, bool approverIsOwner)",
    ),
    fromBlock: beforeApproval + 1n,
    toBlock: "latest",
  });
  expect(
    opened.some((event) => event.args.planHash?.toLowerCase() === plan.planHash.toLowerCase()),
  ).toBe(true);
  await page.goto("/home");
  await page.getByRole("button", { name: "Freeze" }).click();
  await page.getByRole("button", { name: "Confirm freeze" }).click();
  await expect(page.getByText(/Frozen\. No payments can start/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Unfreeze" }).click();
  await page.getByRole("button", { name: "Confirm unfreeze" }).click();
  await expect(page.getByText(/Unfreezing…/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Freeze" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Frozen\. No payments can start/)).toHaveCount(0);
  expect((await accountMe(registeredMsca!, vaultFactory!)).frozen).toBe(false);
  await cdp.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: authenticator.authenticatorId,
  });
  await cdp.detach();
});

function formatAmount(amount: bigint): string {
  return `${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, "0")}`;
}

async function accountMe(msca: Address, vaultFactory: Address): Promise<Me> {
  const chain = defineChain({
    id: 5042002,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: [ARC_RPC] } },
  });
  const client = createPublicClient({ chain, transport: http(ARC_RPC) });
  const blockNumber = await client.getBlockNumber();
  const block = await client.getBlock({ blockNumber });
  const factory = getVaultFactory(vaultFactory, client);
  const predicted = await factory.read.predictVault([msca], { blockNumber });
  const code = await client.getCode({ address: predicted, blockNumber });
  const vaultCreated = Boolean(code && code !== "0x");
  const categoryIds = CATEGORIES.map((category) => categoryHash(category));
  const state = vaultCreated
    ? await readPinnedVaultState({
        client,
        factory: vaultFactory,
        usdc: USDC,
        msca,
        vault: predicted,
        categoryIds,
        blockNumber,
      })
    : undefined;
  const periodId = Number(block.timestamp / 604_800n);
  const mscaBalance = await client.readContract({
    address: USDC,
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
    args: [msca],
    blockNumber,
  });
  return {
    userId: "usr_01J00000000000000000000000",
    msca,
    vault: predicted,
    vaultCreated,
    network: "eip155:5042002",
    balances: {
      vaultBalance: (state?.vaultBalance ?? 0n).toString(),
      free: (state?.free ?? 0n).toString(),
      committed: (state?.committed ?? 0n).toString(),
      mscaBalance: mscaBalance.toString(),
      pocketOutstanding: "0",
      asOfBlock: Number(blockNumber),
    },
    limits: (state?.limits ?? []).flatMap((limit) => {
      const category = CATEGORIES[categoryIds.indexOf(limit.categoryId)];
      if (!category) return [];
      return [
        {
          category,
          userMax: limit.userMax.toString(),
          autoLimit: limit.autoLimit.toString(),
          usedThisPeriod: limit.periodId === BigInt(periodId) ? limit.usedInPeriod.toString() : "0",
          periodId,
          periodEndsAt: new Date((periodId + 1) * 604_800_000).toISOString(),
        },
      ];
    }),
    mode: "shadow",
    frozen: state?.frozen ?? false,
    paused: state?.paused ?? false,
    displayCurrency: "USD",
  };
}

function approvalFixture(): { readonly plan: AppPlan; readonly intent: ApprovalIntent } {
  const payee = "0x0000000000000000000000000000000000000001" as Address;
  const cap = "1000000";
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const taskSpec = {
    schemaVersion: "1.1" as const,
    kind: "table-fill" as const,
    topic: "approval test",
    subjects: [{ label: "Vendor" }],
    fields: ["price"],
    sourceTrust: "user-prompt" as const,
  };
  const leaves = [payeeLeaf(payee, PAYEE_KIND.X402_PAY_TO, 0, BigInt(cap))];
  const payeeRoot = buildTree(leaves).root;
  const base = {
    schemaVersion: "1.2" as const,
    planId: "pln_01J00000000000000000000000",
    objectiveId: "obj_01J00000000000000000000000",
    objectiveHash: `0x${"1".repeat(64)}` as Hex,
    network: "eip155:5042002",
    category: "research",
    cap,
    slackBps: 0,
    maxStepAmount: cap,
    pocketCapBps: 0,
    expiresAt,
    steps: [
      {
        stepIndex: 0,
        stepId: "step-approval-test",
        kind: "x402-exact" as const,
        capability: "web-search",
        serviceId: "svc-approval-test",
        resource: { url: "https://prices.example/search", method: "GET" as const },
        payee,
        unitAmount: cap,
        expectedCalls: 1,
        stepCap: cap,
        routingReason: "vault-direct",
        acceptanceProfileId: "json",
      },
    ],
    payeeLeaves: [{ payee, kind: PAYEE_KIND.X402_PAY_TO, stepIndex: 0, stepCap: cap }],
    payeeRoot,
    shadow: false,
    createdAt: new Date().toISOString(),
    taskSpec,
  };
  const hash = planHash({
    planId: base.planId,
    objectiveHash: base.objectiveHash,
    network: base.network,
    category: base.category,
    cap,
    slackBps: 0,
    maxStepAmount: cap,
    pocketCapBps: 0,
    expiresAt,
    payeeRoot,
    taskSpecHash: taskSpecHash(taskSpec),
    steps: base.steps.map((step) => ({
      stepIndex: step.stepIndex,
      kind: step.kind,
      payee,
      unitAmount: cap,
      expectedCalls: 1,
      stepCap: cap,
      acceptanceProfileId: "json",
      serviceId: step.serviceId,
    })),
  });
  const plan: AppPlan = { ...base, planHash: hash };
  const decoded = {
    cap,
    maxStepAmount: cap,
    pocketCapBps: 0,
    expiresAt: Math.floor(Date.parse(expiresAt) / 1000),
    categoryId: categoryHash("research"),
    objectiveHash: base.objectiveHash,
    planHash: hash,
    payeeRoot,
  };
  const intent: ApprovalIntent = {
    planId: base.planId,
    planHash: hash,
    objectiveHash: base.objectiveHash,
    payeeRoot,
    vault: "0x0000000000000000000000000000000000000000",
    to: "0x0000000000000000000000000000000000000000",
    calldata: encodeOpenEnvelope({
      cap: BigInt(cap),
      maxStepAmount: BigInt(cap),
      pocketCapBps: 0,
      expiresAt: BigInt(decoded.expiresAt),
      categoryId: decoded.categoryId,
      objectiveHash: decoded.objectiveHash,
      planHash: decoded.planHash,
      payeeRoot,
    }),
    value: "0",
    chainId: 5042002,
    decoded,
    expiresAt,
  };
  return { plan, intent };
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(ARC_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? `Local Arc RPC method ${method} failed.`);
  return body.result;
}
