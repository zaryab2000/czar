import type {
  ApprovalIntent,
  ApprovalIntentRequest,
  ApprovalSummary,
  AuthChallenge,
  AppBundler,
  AppWalletConfig,
  AppPage,
  AppPlan,
  Device,
  EnvelopeDetail,
  FreezeIntent,
  LedgerReceipt,
  ManualReturn,
  Me,
  SessionRequest,
  SessionResponse,
  PasskeyRegistration,
  PairingCode,
  SoulPointer,
  SubjectsRevision,
  SubmittedNotice,
} from "@czar/schemas";

const SESSION_KEY = "czar.appSession";
const SESSION_EXPIRY_KEY = "czar.appSessionExpiresAt";
const BUNDLERS = ["circle", "pimlico", "alchemy", "zerodev"] as const;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
let appWalletConfigRequest: Promise<AppWalletConfig> | undefined;

export async function getAppWalletConfig(): Promise<AppWalletConfig> {
  if (!appWalletConfigRequest) appWalletConfigRequest = fetchAppWalletConfig();
  const pendingConfigRequest = appWalletConfigRequest;
  try {
    return await pendingConfigRequest;
  } catch (error) {
    if (appWalletConfigRequest === pendingConfigRequest) appWalletConfigRequest = undefined;
    throw error;
  }
}

async function fetchAppWalletConfig(): Promise<AppWalletConfig> {
  let response: Response;
  try {
    response = await fetch("/v1/app/wallet-config", {
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
      mode: "same-origin",
      redirect: "error",
    });
  } catch {
    throw new Error("Czar could not load wallet configuration. Check the connection and retry.");
  }
  if (!response.ok || !hasNoStore(response.headers)) {
    throw new Error("Czar could not load wallet configuration. Check the connection and retry.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Czar received invalid wallet configuration. Reload and try again.");
  }
  const parsed = parseAppWalletConfig(body);
  if (!parsed) throw new Error("Czar received invalid wallet configuration. Reload and try again.");
  return parsed;
}

export class AppApiError extends Error {
  readonly status: number;
  readonly czarCode?: string;

  constructor(message: string, status: number, czarCode?: string) {
    super(message);
    this.name = "AppApiError";
    this.status = status;
    if (czarCode !== undefined) this.czarCode = czarCode;
  }
}

function sessionToken(): string | undefined {
  try {
    const token = sessionStorage.getItem(SESSION_KEY) ?? undefined;
    const expiresAt = sessionStorage.getItem(SESSION_EXPIRY_KEY);
    if (token && expiresAt && Date.parse(expiresAt) > Date.now()) return token;
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_EXPIRY_KEY);
    return undefined;
  } catch {
    return undefined;
  }
}

export function hasAppSession(): boolean {
  return sessionToken() !== undefined;
}

export function storeSession(response: SessionResponse): void {
  try {
    sessionStorage.setItem(SESSION_KEY, response.sessionToken);
    sessionStorage.setItem(SESSION_EXPIRY_KEY, response.expiresAt);
  } catch {
    throw new Error(
      "This browser could not store your sign-in session. Enable session storage and try again.",
    );
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_EXPIRY_KEY);
  } catch {
    return;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await requestWithHeaders<T>(path, init)).data;
}

async function requestWithHeaders<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ data: T; headers: Headers }> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  const token = sessionToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  if (!response.ok) {
    if (response.status === 401) clearSession();
    const body = (await response.json().catch(() => ({}))) as {
      detail?: string;
      czarCode?: string;
    };
    throw new AppApiError(body.detail ?? response.statusText, response.status, body.czarCode);
  }
  const data =
    response.status === 204 || response.status === 202
      ? (undefined as T)
      : ((await response.json()) as T);
  return { data, headers: response.headers };
}

function idempotencyKey(): string {
  return crypto.randomUUID();
}

export const appApi = {
  createAuthChallenge: (purpose: "register" | "session") =>
    request<AuthChallenge>("/v1/auth/challenge", {
      method: "POST",
      body: JSON.stringify({ purpose }),
    }),
  registerPasskey: (body: PasskeyRegistration) =>
    request<SessionResponse>("/v1/auth/passkey", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify(body),
    }).then((response) => {
      storeSession(response);
      return response;
    }),
  createSession: async (body: SessionRequest) => {
    const response = await request<SessionResponse>("/v1/auth/session", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify(body),
    });
    storeSession(response);
    return response;
  },
  getMe: () => request<Me>("/v1/me"),
  listApprovals: (status = "pending", cursor?: string) => {
    const query = new URLSearchParams({ status });
    if (cursor) query.set("cursor", cursor);
    return request<AppPage<ApprovalSummary>>(`/v1/approvals?${query}`);
  },
  listPendingApprovals: async () => {
    const result = await requestWithHeaders<AppPage<ApprovalSummary>>(
      "/v1/approvals?status=pending",
    );
    const pollSeconds = Number(result.headers.get("X-Czar-Pending-Poll-Seconds"));
    const confirmTimeoutSeconds = Number(
      result.headers.get("X-Czar-Approval-Confirm-Timeout-Seconds"),
    );
    if (
      !Number.isSafeInteger(pollSeconds) ||
      pollSeconds < 1 ||
      !Number.isSafeInteger(confirmTimeoutSeconds) ||
      confirmTimeoutSeconds < 1
    ) {
      throw new Error("The server did not provide valid approval timing settings.");
    }
    return { page: result.data, pollSeconds, confirmTimeoutSeconds };
  },
  getApproval: async (planId: string) => {
    const result = await requestWithHeaders<AppPlan>(`/v1/approvals/${encodeURIComponent(planId)}`);
    const largeCapWarnBps = Number(result.headers.get("X-Czar-Large-Cap-Warn-Bps"));
    if (!Number.isSafeInteger(largeCapWarnBps) || largeCapWarnBps < 1) {
      throw new Error("The server did not provide a valid large-cap warning setting.");
    }
    return { plan: result.data, largeCapWarnBps };
  },
  revisePlanSubjects: (planId: string, body: SubjectsRevision) =>
    request<AppPlan>(`/v1/approvals/${encodeURIComponent(planId)}/subjects`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify(body),
    }),
  createApprovalIntent: (planId: string, body: ApprovalIntentRequest) =>
    request<ApprovalIntent>(`/v1/approvals/${encodeURIComponent(planId)}/intent`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify(body),
    }),
  notifySubmitted: (planId: string, body: SubmittedNotice) =>
    request<void>(`/v1/approvals/${encodeURIComponent(planId)}/submitted`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify(body),
    }),
  listEnvelopes: (cursor?: string) => {
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    return request<AppPage<import("@czar/schemas").Envelope>>(`/v1/envelopes?${query}`);
  },
  getEnvelope: (ref: string) => request<EnvelopeDetail>(`/v1/envelopes/${encodeURIComponent(ref)}`),
  listManualReturns: (cursor?: string) => {
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    return request<AppPage<ManualReturn>>(`/v1/pockets/manual-returns?${query}`);
  },
  listAllManualReturns: () => listAllManualReturns(),
  listReceipts: (cursor?: string) => {
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    return request<AppPage<LedgerReceipt>>(`/v1/ledger/receipts?${query}`);
  },
  getSoulPointer: () => request<SoulPointer>("/v1/soul/pointer"),
  createPairingCode: () =>
    request<PairingCode>("/v1/devices/pairing-codes", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
    }),
  listDevices: (cursor?: string) => {
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    return request<AppPage<Device>>(`/v1/devices?${query}`);
  },
  revokeDevice: (deviceId: string) =>
    request<void>(`/v1/devices/${encodeURIComponent(deviceId)}/revoke`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
    }),
  createFreezeIntent: (action: "freeze" | "unfreeze") =>
    request<FreezeIntent>("/v1/freeze/intent", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify({ action }),
    }),
};

async function listAllManualReturns(): Promise<AppPage<ManualReturn>> {
  const items: ManualReturn[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = await appApi.listManualReturns(cursor);
    items.push(...page.items);
    if (page.nextCursor === null) return { items, nextCursor: null };
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("The server repeated a manual-return pagination cursor.");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

function parseAppWalletConfig(value: unknown): AppWalletConfig | undefined {
  if (!isRecord(value)) return undefined;
  const expected = [
    "arcRpcUrl",
    "bundlerEndpoints",
    "bundlerOrder",
    "circleClientKey",
    "circleClientUrl",
    "vaultFactory",
    "webauthnRpId",
  ];
  if (Object.keys(value).toSorted().join(",") !== expected.join(",")) return undefined;
  if (
    !isHttpUrl(value["circleClientUrl"]) ||
    typeof value["circleClientKey"] !== "string" ||
    value["circleClientKey"].trim().length === 0 ||
    !isHttpUrl(value["arcRpcUrl"]) ||
    !Array.isArray(value["bundlerOrder"]) ||
    value["bundlerOrder"].length === 0 ||
    value["bundlerOrder"].some((name) => typeof name !== "string" || !isBundler(name)) ||
    new Set(value["bundlerOrder"]).size !== value["bundlerOrder"].length ||
    !isRecord(value["bundlerEndpoints"]) ||
    typeof value["vaultFactory"] !== "string" ||
    !ADDRESS.test(value["vaultFactory"]) ||
    !isHostName(value["webauthnRpId"])
  ) {
    return undefined;
  }
  for (const [name, endpoint] of Object.entries(value["bundlerEndpoints"])) {
    if (!isBundler(name) || !isHttpUrl(endpoint)) return undefined;
  }
  return value as unknown as AppWalletConfig;
}

/** A bare host name, as `new URL(origin).hostname` gives it: no scheme, port or path. */
function isHostName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return new URL(`http://${value}`).hostname === value;
  } catch {
    return false;
  }
}

function isBundler(value: string): value is AppBundler {
  return BUNDLERS.some((name) => name === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function hasNoStore(headers: Headers): boolean {
  return headers.get("Cache-Control")?.toLowerCase().includes("no-store") === true;
}
