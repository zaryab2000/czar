import type {
  ApprovalIntent,
  ApprovalIntentRequest,
  ApprovalSummary,
  AuthChallenge,
  AppPage,
  AppPlan,
  EnvelopeDetail,
  FreezeIntent,
  LedgerReceipt,
  Me,
  SessionRequest,
  SessionResponse,
  PasskeyRegistration,
  SoulPointer,
  SubjectsRevision,
  SubmittedNotice,
} from "@czar/schemas";

const SESSION_KEY = "czar.appSession";
const SESSION_EXPIRY_KEY = "czar.appSessionExpiresAt";

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
  getApproval: (planId: string) => request<AppPlan>(`/v1/approvals/${encodeURIComponent(planId)}`),
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
  listReceipts: (cursor?: string) => {
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    return request<AppPage<LedgerReceipt>>(`/v1/ledger/receipts?${query}`);
  },
  getSoulPointer: () => request<SoulPointer>("/v1/soul/pointer"),
  createFreezeIntent: (action: "freeze" | "unfreeze") =>
    request<FreezeIntent>("/v1/freeze/intent", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify({ action }),
    }),
};
