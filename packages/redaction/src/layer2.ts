// Layer-2 (personal data) client interface. The implementation talks to the `czar-redact` sidecar
// (T-064) over the Unix socket `czar-redact.sock` with JSON-RPC 2.0 (CZ-26 §4).

export interface EntityCount {
  /** Presidio entity name, e.g. `PERSON`, `EMAIL_ADDRESS` (C2-05). */
  readonly type: string;
  readonly count: number;
}

export interface Layer2Result {
  readonly text: string;
  readonly entities: readonly EntityCount[];
  /** True when the sidecar was unavailable and the regex fallback ran; the objective must be reviewed (D45). */
  readonly forcedReview: boolean;
}

export interface Layer2Options {
  readonly language: string;
  readonly entities?: readonly string[];
}

export interface Layer2Client {
  redact(text: string, options: Layer2Options): Promise<Layer2Result>;
}

/** Sidecar JSON-RPC method and payloads (CZ-26 §4). */
export const LAYER2_METHOD = "analyze_anonymize";

export interface AnalyzeAnonymizeParams {
  readonly text: string;
  readonly language: string;
  readonly entities?: readonly string[];
}

export interface AnalyzeAnonymizeResult {
  readonly text: string;
  readonly entities: readonly EntityCount[];
}
