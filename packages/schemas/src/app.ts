import type {
  Envelope,
  JobRecord,
  Plan,
  PocketRecord,
  Reservation,
  TaskSpec,
} from "#src/generated/types";

export interface AppPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export type AppBundler = "circle" | "pimlico" | "alchemy" | "zerodev";

export interface AppWalletConfig {
  readonly circleClientUrl: string;
  readonly circleClientKey: string;
  readonly arcRpcUrl: string;
  readonly bundlerOrder: readonly AppBundler[];
  readonly bundlerEndpoints: Partial<Record<AppBundler, string>>;
}

export interface SessionRequest {
  readonly challengeId: string;
  readonly credentialId: string;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly signature: string;
}

export interface SessionResponse {
  readonly sessionToken: string;
  readonly expiresAt: string;
}

export interface AuthChallengeRequest {
  readonly purpose: "register" | "session";
}

export interface AuthChallenge {
  readonly challengeId: string;
  readonly challenge: string;
  readonly expiresAt: string;
}

export interface PasskeyRegistration {
  readonly challengeId: string;
  readonly credentialId: string;
  readonly clientDataJSON: string;
  readonly attestationObject: string;
  readonly msca: `0x${string}`;
}

export interface Me {
  readonly userId: string;
  readonly msca: string;
  readonly vault: string;
  readonly vaultCreated: boolean;
  readonly network: string;
  readonly balances: {
    readonly vaultBalance: string;
    readonly free: string;
    readonly committed: string;
    readonly mscaBalance: string;
    readonly pocketOutstanding: string;
    readonly asOfBlock: number;
  };
  readonly limits: readonly {
    readonly category: string;
    readonly userMax: string;
    readonly autoLimit: string;
    readonly usedThisPeriod: string;
    readonly periodId: number;
    readonly periodEndsAt: string;
  }[];
  readonly mode?: "shadow" | "live";
  readonly shadowEndsAt?: string;
  readonly frozen: boolean;
  readonly paused: boolean;
  readonly displayCurrency?: "USD";
}

export interface ApprovalSummary {
  readonly planId: string;
  readonly objectiveId: string;
  readonly goal: string;
  readonly cap: string;
  readonly capDisplay: string;
  readonly category: string;
  readonly stepCount: number;
  readonly newPayees?: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: "pending" | "intent-issued" | "submitted" | "opened" | "expired" | "declined";
}

export interface ApprovalIntentRequest {
  readonly fillInPlace?: boolean;
}

export interface ApprovalIntent {
  readonly planId: string;
  readonly planHash: string;
  readonly objectiveHash: string;
  readonly payeeRoot: string;
  readonly vault: `0x${string}`;
  readonly to: `0x${string}`;
  readonly calldata: `0x${string}`;
  readonly value: "0";
  readonly chainId: number;
  readonly decoded: {
    readonly cap: string;
    readonly maxStepAmount: string;
    readonly pocketCapBps: number;
    readonly expiresAt: number;
    readonly categoryId: `0x${string}`;
    readonly objectiveHash: `0x${string}`;
    readonly planHash: `0x${string}`;
    readonly payeeRoot: `0x${string}`;
  };
  readonly expiresAt: string;
}

export interface SubmittedNotice {
  readonly userOpHash: `0x${string}`;
  readonly bundler?: "circle" | "pimlico" | "alchemy" | "zerodev";
}

export type ResultAckSurface = "claude-code-file" | "pr-comment" | "doc-insert";

export interface ResultAck {
  readonly resultId: string;
  readonly writtenAt: string;
  readonly surface: ResultAckSurface;
  readonly artifacts?: {
    readonly delivered: number;
    readonly heldForReview: number;
    readonly released?: number;
  };
  readonly fill?: {
    readonly status: "filled" | "partial" | "none-filled" | "off" | "file-missing";
    readonly cellsFilled?: number;
    readonly cellsSkippedClash?: number;
    readonly cellsNotFound?: number;
  };
  readonly assembly?: readonly {
    readonly stepIndex: number;
    readonly kind: "local" | "agent-assist";
    readonly status: "assembled" | "assembly-failed" | "handed-to-agent" | "dropped-no-agent";
    readonly rows?: number;
    readonly columns?: number;
    readonly structuralPass?: boolean;
  }[];
}

export interface Result {
  readonly resultId: string;
  readonly objectiveId: string;
  readonly mimeType: "text/markdown" | "application/json";
  readonly body: string;
  readonly provenance: readonly {
    readonly stepIndex: number;
    readonly origin: string;
    readonly paymentRefHash: string;
    readonly accepted: boolean;
  }[];
  readonly assembly?: readonly {
    readonly stepIndex: number;
    readonly kind: "local" | "agent-assist";
    readonly capability: string;
    readonly template?: "table-build" | "list-build" | "merge-dedupe";
    readonly columns?: readonly string[];
    readonly inputs: readonly {
      readonly stepIndex: number;
      readonly subjectIndex?: number;
      readonly accepted: boolean;
      readonly fields: readonly { readonly name: string; readonly value: string }[];
    }[];
  }[];
  readonly taskSpec?: TaskSpec;
  readonly fillInPlace?: boolean;
  readonly artifacts?: readonly {
    readonly stepIndex: number;
    readonly name: string;
    readonly mimeType: string;
    readonly contentHash: string;
    readonly bytes: number;
    readonly flags: readonly ("injection-suspect" | "pii-suspect" | "screen-unavailable")[];
  }[];
  readonly costTotal?: string;
  readonly minutesSaved?: number;
  readonly createdAt: string;
}

export interface FreezeIntent {
  readonly vault: `0x${string}`;
  readonly to: `0x${string}`;
  readonly calldata: `0x${string}`;
  readonly value: "0";
  readonly chainId: number;
}

export interface FreezeIntentRequest {
  readonly action: "freeze" | "unfreeze";
}

export interface EnvelopeDetail {
  readonly envelope: Envelope;
  readonly reservations: readonly Reservation[];
  readonly pockets: readonly PocketRecord[];
  readonly jobs: readonly JobRecord[];
}

export interface ManualReturn {
  readonly envelopeRef: string;
  readonly vault: `0x${string}`;
  readonly pocket: `0x${string}`;
  readonly returnedAmount: string;
  readonly returnTx: `0x${string}`;
  readonly state: "manual-return-required" | "recorded" | "expired";
  readonly recordedCredit?: string;
  readonly recordedTx?: `0x${string}`;
}

export interface LedgerReceipt {
  readonly objectiveId: string;
  readonly envelopeRef: string;
  readonly stepIndex: number;
  readonly amount: string;
  readonly amountDisplay?: string;
  readonly rail: "x402-exact" | "gateway-batched" | "erc8183-job";
  readonly status:
    | "reserved"
    | "settled"
    | "pending"
    | "completed"
    | "released"
    | "refunded"
    | "failed"
    | "quarantined";
  readonly merchantIsCzar?: boolean;
  readonly merchantLabel?: string;
  readonly accepted?: boolean | null;
  readonly minutesSaved?: number;
  readonly minutesSource?: "estimate" | "reported";
  readonly paymentRefHash: `0x${string}`;
  readonly settlementTx?: `0x${string}`;
  readonly createdAt: string;
}

export interface MonthlyStatement {
  readonly month: string;
  readonly totalSpent: string;
  readonly totalSpentDisplay: string;
  readonly totalMinutesSaved: number;
  readonly objectives: number;
  readonly receipts: number;
  readonly byCategory?: readonly {
    readonly category: string;
    readonly spent: string;
    readonly minutesSaved: number;
  }[];
}

export interface SoulPointer {
  readonly available: false;
  readonly message: string;
  readonly desktopUrl?: "http://127.0.0.1/soul";
}

export interface PairingCode {
  readonly code: string;
  readonly expiresAt: string;
}

export interface Device {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly platform: "macos" | "linux" | "windows";
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface SubjectsRevision {
  readonly subjects: readonly {
    readonly label: string;
    readonly sourceLine?: number;
    readonly addedByUser?: boolean;
  }[];
}

export type AppPlan = Plan;
