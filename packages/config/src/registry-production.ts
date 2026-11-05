// Production parameters added during the public-alpha cloud window (SCR-170 §7, §8).
// Every key production work adds in this window lives here, not in registry.ts, so the agent
// social network and production never edit the same registry lines. Entries are grouped by the
// lane that owns them, in the order A, B, C, D, E. Same shape and rules as registry.ts:
// a default (or `noDefault`), a unit, a reason, and a `source` of the form docs/specs/<path>.md:<line>.
import type { ParameterSpec } from "./types.ts";

const SCR_170 = "docs/specs/06-review/change-requests/SCR-170-public-alpha-cloud-deployment.md";
const CZ_20 = "docs/specs/04-components/server/server-supply-side.md";
const CZ_27 = "docs/specs/04-components/server/server-autonomy-roi-keys.md";
const SCR_182 = "docs/specs/06-review/change-requests/SCR-182-audit-merchants.md";

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
  // Lane E (MR-08): the two audit merchants' prices (SCR-182 §1, §6). Both stay at or under
  // planner.defaultMaxUnitAtomic, which a config test enforces.
  {
    key: "merchants.audit.quick.priceAtomic",
    type: "string",
    default: "500000",
    unit: "USDC atomic",
    reason: "Czar Lab Quick Audit (czar-audit-quick): the cheaper first pass, 0.50 testnet USDC",
    source: `${SCR_182}:135`,
  },
  {
    key: "merchants.audit.deep.priceAtomic",
    type: "string",
    default: "1000000",
    unit: "USDC atomic",
    reason:
      "Czar Lab Deep Audit (czar-audit-deep): the thorough review, 1.00 testnet USDC; at most planner.defaultMaxUnitAtomic",
    source: `${SCR_182}:136`,
  },
  // Lane E (MR-01, MR-02, MR-05): the rest of the audit merchants' keys (SCR-182 §4, §6). Each service is off
  // until its K10 payout key exists; a disabled service registers no route and looks up no key.
  {
    key: "merchants.audit.quick.enabled",
    type: "boolean",
    default: false,
    unit: "flag",
    reason: "off until K10:czar-audit-quick exists (MR-03)",
    source: `${SCR_182}:133`,
  },
  {
    key: "merchants.audit.deep.enabled",
    type: "boolean",
    default: false,
    unit: "flag",
    reason: "off until K10:czar-audit-deep exists (MR-03)",
    source: `${SCR_182}:134`,
  },
  {
    key: "merchants.audit.quick.model",
    type: "string",
    default: "claude-haiku-5-5",
    unit: "model",
    reason: "fast, cheap model for the shallow first pass",
    source: `${SCR_182}:137`,
  },
  {
    key: "merchants.audit.deep.model",
    type: "string",
    default: "claude-sonnet-5-5",
    unit: "model",
    reason: "stronger model for the thorough review",
    source: `${SCR_182}:138`,
  },
  {
    key: "merchants.audit.quick.maxFindings",
    type: "integer",
    default: 3,
    unit: "count",
    reason: "shallow by design: at most three generic findings",
    source: `${SCR_182}:139`,
  },
  {
    key: "merchants.audit.deep.maxFindings",
    type: "integer",
    default: 15,
    unit: "count",
    reason: "the audit-report schema maximum",
    source: `${SCR_182}:140`,
  },
  {
    key: "merchants.audit.maxInputChars",
    type: "integer",
    default: 2000,
    unit: "chars",
    reason: "longest contract a buyer may send; equals app.objectiveMaxSourceChars",
    source: `${SCR_182}:141`,
  },
  {
    key: "merchants.audit.maxOutputTokens",
    type: "integer",
    default: 2000,
    unit: "tokens",
    reason: "bounds the cost of one model call",
    source: `${SCR_182}:142`,
  },
  {
    key: "merchants.audit.handlerTimeoutMs",
    type: "integer",
    default: 45000,
    unit: "ms",
    reason: "one model call plus validation; past it the call fails and is not settled",
    source: `${SCR_182}:143`,
  },
  {
    key: "merchants.audit.dailyModelCallCap",
    type: "integer",
    default: 200,
    unit: "calls/day/service",
    reason: "hard spend bound; past it the route answers 503 before payment verification",
    source: `${SCR_182}:144`,
  },
  {
    key: "merchants.audit.anthropicApiKeyFile",
    type: "string",
    default: "anthropic-api-key",
    unit: "file name",
    reason:
      "the API key's file name inside the merchants' own folder of deploy.credentialFilesDir; never an env var",
    source: `${SCR_182}:145`,
  },
  {
    key: "merchants.audit.addressLookupEnabled",
    type: "boolean",
    default: false,
    unit: "flag",
    reason: "address mode is optional; when off, an address is refused with 400 before payment",
    source: `${SCR_182}:146`,
  },
  {
    key: "merchants.audit.sourceLookupUrlTemplate",
    type: "string",
    default: "",
    unit: "URL template",
    reason:
      "https URL that returns a contract's verified source; {address} is replaced by the address; required when the lookup is on",
    source: `${SCR_182}:147`,
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

  // The test-merchant lab (PM-043, T-106): one `enabled` switch per service and each profile's parameter, per CZ-20 §5.8a.
  {
    key: "merchants.lab.lab-search-steady.enabled",
    type: "boolean",
    default: true,
    unit: "",
    reason:
      "switches this lab service off on its own (CZ-20 §5.8a); the lab as a whole is merchants.lab.enabled",
    source: `${CZ_20}:164`,
    notes: "profile row at line 157 of the CZ-20 §5.8a table",
  },
  {
    key: "merchants.lab.lab-search-flaky.enabled",
    type: "boolean",
    default: true,
    unit: "",
    reason:
      "switches this lab service off on its own (CZ-20 §5.8a); the lab as a whole is merchants.lab.enabled",
    source: `${CZ_20}:164`,
    notes: "profile row at line 158 of the CZ-20 §5.8a table",
  },
  {
    key: "merchants.lab.lab-search-slow.enabled",
    type: "boolean",
    default: true,
    unit: "",
    reason:
      "switches this lab service off on its own (CZ-20 §5.8a); the lab as a whole is merchants.lab.enabled",
    source: `${CZ_20}:164`,
    notes: "profile row at line 159 of the CZ-20 §5.8a table",
  },
  {
    key: "merchants.lab.lab-extract-schemabreak.enabled",
    type: "boolean",
    default: true,
    unit: "",
    reason:
      "switches this lab service off on its own (CZ-20 §5.8a); the lab as a whole is merchants.lab.enabled",
    source: `${CZ_20}:164`,
    notes: "profile row at line 160 of the CZ-20 §5.8a table",
  },
  {
    key: "merchants.lab.lab-extract-drift.enabled",
    type: "boolean",
    default: true,
    unit: "",
    reason:
      "switches this lab service off on its own (CZ-20 §5.8a); the lab as a whole is merchants.lab.enabled",
    source: `${CZ_20}:164`,
    notes: "profile row at line 161 of the CZ-20 §5.8a table",
  },
  {
    key: "merchants.lab.lab-spot-payee-swap.enabled",
    type: "boolean",
    default: true,
    unit: "",
    reason:
      "switches this lab service off on its own (CZ-20 §5.8a); the lab as a whole is merchants.lab.enabled",
    source: `${CZ_20}:164`,
    notes: "profile row at line 162 of the CZ-20 §5.8a table",
  },
  {
    key: "merchants.lab.lab-search-flaky.failRate",
    type: "number",
    default: 0.3,
    unit: "fraction of calls",
    reason:
      "share of calls whose handler fails with a 5xx, unsettled and not charged (CZ-20 §5.8a)",
    source: `${CZ_20}:158`,
  },
  {
    key: "merchants.lab.lab-search-slow.delayMs",
    type: "integer",
    default: 6000,
    unit: "ms",
    reason:
      "delivery delay, inside merchants.maxTimeoutSeconds and merchants.handlerTimeoutMs (CZ-20 §5.8a)",
    source: `${CZ_20}:159`,
  },
  {
    key: "merchants.lab.lab-extract-schemabreak.schemaBreakRate",
    type: "number",
    default: 0.2,
    unit: "fraction of calls",
    reason: "share of calls returning JSON that lacks `text` (CZ-20 §5.8a)",
    source: `${CZ_20}:160`,
  },
  {
    key: "merchants.lab.lab-extract-drift.driftRate",
    type: "number",
    default: 0.33,
    unit: "fraction of 402s",
    reason: "share of live 402s quoting a price above the index entry (CZ-20 §5.8a)",
    source: `${CZ_20}:161`,
  },
  {
    key: "merchants.lab.lab-extract-drift.driftBps",
    type: "integer",
    default: 2000,
    unit: "bps",
    reason: "how far above the index price a drifted 402 quotes: +2,000 bps is +20% (CZ-20 §5.8a)",
    source: `${CZ_20}:161`,
  },
  {
    key: "merchants.lab.lab-spot-payee-swap.payeeSwapEveryDays",
    type: "integer",
    default: 7,
    unit: "days",
    reason:
      "the live 402 changes between the indexed payTo and a second Czar-owned payTo every this many days (CZ-20 §5.8a)",
    source: `${CZ_20}:162`,
  },
] as const satisfies readonly ParameterSpec[];
