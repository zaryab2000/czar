// Production parameters added during the public-alpha cloud window (SCR-170 §7, §8).
// Every key production work adds in this window lives here, not in registry.ts, so the agent
// social network and production never edit the same registry lines. Entries are grouped by the
// lane that owns them, in the order A, B, C, D, E. Same shape and rules as registry.ts:
// a default (or `noDefault`), a unit, a reason, and a `source` of the form docs/specs/<path>.md:<line>.
import type { ParameterSpec } from "./types.ts";

const SCR_170 = "docs/specs/06-review/change-requests/SCR-170-public-alpha-cloud-deployment.md";
const CZ_20 = "docs/specs/04-components/server/server-supply-side.md";
const CZ_27 = "docs/specs/04-components/server/server-autonomy-roi-keys.md";

export const PRODUCTION_PARAMETERS = [
  // Lane A: deploy — the cloud machine, its files and the recorded deployment.
  {
    key: "deploy.environment",
    type: "enum",
    values: ["local", "cloud-testnet"],
    default: "local",
    unit: "",
    reason: "cloud entry points refuse to start unless this is cloud-testnet (SCR-170 §3)",
    source: `${SCR_170}:197`,
  },
  {
    key: "deploy.allowedRpcHosts",
    type: "string[]",
    default: ["rpc.testnet.arc.io"],
    unit: "",
    reason: "the only RPC hosts a cloud process may use; Arc testnet only (CLAUDE.md)",
    source: `${SCR_170}:198`,
  },
  {
    key: "deploy.credentialFilesDir",
    type: "string",
    default: "/run/czar/secrets",
    unit: "path",
    reason:
      "credential files live under one tmpfs folder; never environment variables (SCR-170 §4)",
    source: `${SCR_170}:199`,
  },
  {
    key: "deploy.backupRetentionDays",
    type: "integer",
    default: 14,
    unit: "days",
    reason: "nightly database dump retention (SCR-170 §5)",
    source: `${SCR_170}:200`,
  },
  {
    key: "deploy.metadataTokenUrl",
    type: "string",
    default:
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    unit: "url",
    reason: "access tokens for Google APIs without key files (SCR-170 §4)",
    source: `${SCR_170}:201`,
  },
  {
    key: "deploy.deploymentFile",
    type: "string",
    default: "deployments/arc-testnet.json",
    unit: "path",
    reason: "the recorded testnet deployment read at startup (tracker PM-010)",
    source: `${SCR_170}:202`,
  },
  {
    key: "deploy.objectStorePath",
    type: "string",
    default: "/var/lib/czar/objects",
    unit: "path",
    reason: "server object store on the VM's persistent disk",
    source: `${SCR_170}:203`,
  },
  {
    key: "deploy.indexerUrl",
    type: "string",
    default: "http://127.0.0.1:42069",
    unit: "url",
    reason: "the indexer's loopback origin, read by the server and merchants cloud entries",
    source: `${SCR_170}:204`,
  },

  // Lane B: signer — the socket in a multi-user container, and the Cloud KMS backend.
  {
    key: "signer.socketGroupGid",
    type: "integer",
    default: null,
    unit: "count",
    reason:
      "group allowed to open the signer socket across users (SCR-170 §4); unset keeps today's owner-only socket",
    source: `${SCR_170}:205`,
    noDefault: true,
  },
  {
    key: "signer.kms.apiBaseUrl",
    type: "string",
    default: "https://cloudkms.googleapis.com",
    unit: "url",
    reason: "Cloud KMS REST endpoint",
    source: `${SCR_170}:206`,
  },
  {
    key: "signer.kms.projectId",
    type: "string",
    default: null,
    unit: "",
    reason: "the Google Cloud project holding the key rings; set per environment",
    source: `${SCR_170}:207`,
    noDefault: true,
  },
  {
    key: "signer.kms.location",
    type: "string",
    default: "asia-south1",
    unit: "",
    reason: "key ring location, close to the VM (SCR-170 §1)",
    source: `${SCR_170}:208`,
  },
  {
    key: "signer.kms.keyRing",
    type: "string",
    default: "czar-alpha",
    unit: "",
    reason: "long-lived keys K3, K5, K7, K8, K10, K21 and the relayer",
    source: `${SCR_170}:209`,
  },
  {
    key: "signer.kms.pocketKeyRing",
    type: "string",
    default: "czar-alpha-pockets",
    unit: "",
    reason: "runtime K4 pocket keys, created and destroyed per pocket (SCR-170 §4)",
    source: `${SCR_170}:210`,
  },
  {
    key: "signer.kms.keyVersions",
    type: "object",
    default: {},
    unit: "",
    reason:
      "key reference → full cryptoKeyVersions/N resource name; filled after key creation (tracker PM-018)",
    source: `${SCR_170}:211`,
  },
  // Lane B (PM-058): the K21a/K21b test-provider keys' per-key rate limits, read by the signer's
  // `rateLimitFor` as kms.maxSignaturesPerMin.<keyId>.
  {
    key: "kms.maxSignaturesPerMin.K21a",
    type: "integer",
    default: 60,
    unit: "count",
    reason: "one test provider, one job at a time",
    source: `${CZ_27}:418`,
    notes: "CZ-27 §5.2's per-key list does not name K21 yet; default from the PM-058 task",
  },
  {
    key: "kms.maxSignaturesPerMin.K21b",
    type: "integer",
    default: 60,
    unit: "count",
    reason: "one test provider, one job at a time",
    source: `${CZ_27}:418`,
    notes: "CZ-27 §5.2's per-key list does not name K21 yet; default from the PM-058 task",
  },

  // Lane C: server — the model provider, off until Zaryab connects it.
  {
    key: "models.provider",
    type: "enum",
    values: ["none", "anthropic"],
    default: "none",
    unit: "",
    reason: "no model is reachable until Zaryab connects one (SCR-170 §6)",
    source: `${SCR_170}:212`,
  },
  {
    key: "models.anthropic.baseUrl",
    type: "string",
    default: "https://api.anthropic.com",
    unit: "url",
    reason: "Messages API base URL",
    source: `${SCR_170}:213`,
  },
  {
    key: "models.anthropic.model",
    type: "string",
    default: "claude-haiku-5-5",
    unit: "",
    reason: "default model for every prompt",
    source: `${SCR_170}:214`,
  },
  {
    key: "models.anthropic.apiKeyFile",
    type: "string",
    default: "anthropic-api-key",
    unit: "path",
    reason:
      "file name under deploy.credentialFilesDir; the value is never a config value or variable (D78)",
    source: `${SCR_170}:215`,
  },
  {
    key: "models.anthropic.maxPromptTokens",
    type: "integer",
    default: 100000,
    unit: "tokens",
    reason: "a local refusal above this; the price tier changes above it",
    source: `${SCR_170}:216`,
  },

  // Lane D: daemon — no production keys yet.

  // Lane E: merchants — the `czar-spot` public data source (D49, the PM-041 ruling).
  {
    key: "merchants.spotSourceUrl",
    type: "string",
    default: "https://api.coinbase.com/v2/prices/{pair}/spot",
    unit: "url",
    reason: "D49 public free source, chosen in the PM-041 ruling",
    source: `${CZ_20}:64`,
    notes:
      "`{pair}` is replaced by one entry of merchants.spotPairs; keyless, no header or query identifies Czar",
  },
  {
    key: "merchants.spotPairs",
    type: "string[]",
    default: ["BTC-USD", "ETH-USD", "USDC-USD"],
    unit: "",
    reason: "pairs the cache refreshes",
    source: `${CZ_20}:60`,
  },
  // Lane E (PM-046): the two CZ-20 §5.11 test-provider instances. Each instance's `modes` is one work mode and
  // one behaviour mode; only the deterministic `placeholder` work mode ships (OD-41 partial, plan §2.3).
  {
    key: "merchants.provider.czar-provider-a.modes",
    type: "string[]",
    default: ["placeholder", "honest"],
    unit: "",
    reason: "D86: modes, not job types; behaviour honest by default",
    source: `${CZ_20}:216`,
    notes:
      "one work mode (placeholder) and one behaviour mode (honest, junk, silent, early-submit, over-budget, late, no-upload)",
  },
  {
    key: "merchants.provider.czar-provider-b.modes",
    type: "string[]",
    default: ["placeholder", "honest"],
    unit: "",
    reason: "D86: modes, not job types; behaviour honest by default",
    source: `${CZ_20}:216`,
    notes:
      "one work mode (placeholder) and one behaviour mode (honest, junk, silent, early-submit, over-budget, late, no-upload)",
  },
  {
    key: "merchants.provider.czar-provider-a.minWorkSeconds",
    type: "integer",
    default: 60,
    unit: "s",
    reason: "refuse jobs it cannot finish before submitBy",
    source: `${CZ_20}:217`,
    notes: "per work mode; the placeholder work mode needs no more than the upload and one submit",
  },
  {
    key: "merchants.provider.czar-provider-b.minWorkSeconds",
    type: "integer",
    default: 60,
    unit: "s",
    reason: "refuse jobs it cannot finish before submitBy",
    source: `${CZ_20}:217`,
    notes: "per work mode; the placeholder work mode needs no more than the upload and one submit",
  },
  {
    key: "merchants.provider.pollMs",
    type: "integer",
    default: 2000,
    unit: "ms",
    reason:
      "how often an instance reads new JobCreated/JobFunded events and the chain time (step 1, 5)",
    source: `${CZ_20}:178`,
    notes: "CZ-20 §5.11 step 1 names the watch, not its cadence; default from the PM-046 task",
  },
] as const satisfies readonly ParameterSpec[];
