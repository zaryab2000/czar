// Backtick tokens in docs/specs/04-components that look like `section.name` but are not parameters
// (socket methods, step-log and event names, file names, hosts, object field paths). Used by the
// spec-coverage test so every other such token must exist in the registry.
export const NON_PARAMETERS: readonly { readonly token: string; readonly reason: string }[] = [
  {
    token: "memory.db.corrupt-<ts>",
    reason: "file name of a moved-aside corrupt database",
  },
  {
    token: "memory.query",
    reason: "daemon socket JSON-RPC method",
  },
  {
    token: "soul.get",
    reason: "daemon socket JSON-RPC method",
  },
  {
    token: "soul.editBelief",
    reason: "daemon socket JSON-RPC method",
  },
  {
    token: "soul.deleteBelief",
    reason: "daemon socket JSON-RPC method",
  },
  {
    token: "soul.compileNow",
    reason: "daemon socket JSON-RPC method",
  },
  {
    token: "status.get",
    reason: "daemon socket JSON-RPC method",
  },
  {
    token: "status.pause",
    reason: "daemon socket JSON-RPC method",
  },
  {
    token: "objectives.list",
    reason: "daemon socket JSON-RPC method",
  },
  {
    token: "objectives.get",
    reason: "daemon socket JSON-RPC method",
  },
  {
    token: "shadow.report",
    reason: "daemon socket JSON-RPC method",
  },
  {
    token: "writeback.deliver",
    reason: "daemon socket JSON-RPC method",
  },
  {
    token: "audit.whatLeft",
    reason: "daemon socket JSON-RPC method",
  },
  {
    token: "reserve.sent",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "reserve.mined",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "auth.signed",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "call.sent",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "call.result",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "settle.sent",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "settle.mined",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "finalize.sent",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "finalize.mined",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "pocket.registered",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "pocket.gas",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "pocket.delegate",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "pocket.funded",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "pocket.writtenOff",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "pullback.requested",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "pullback.confirmed",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "job.opened",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "job.funded",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "job.synced",
    reason: "step_executions log entry name (CZ-15)",
  },
  {
    token: "soul.compiled",
    reason: "event name",
  },
  {
    token: "memory.appended",
    reason: "event name",
  },
  {
    token: "drives.candidate",
    reason: "event name",
  },
  {
    token: "objective.received",
    reason: "event name",
  },
  {
    token: "objective.delivered",
    reason: "event name",
  },
  {
    token: "objective.failed",
    reason: "event name",
  },
  {
    token: "plan.ready",
    reason: "event name",
  },
  {
    token: "plan.approved",
    reason: "event name",
  },
  {
    token: "step.started",
    reason: "event name",
  },
  {
    token: "step.finished",
    reason: "event name",
  },
  {
    token: "approval.created",
    reason: "event name",
  },
  {
    token: "result.delivered",
    reason: "event name",
  },
  {
    token: "merchant.request",
    reason: "event name",
  },
  {
    token: "merchant.served",
    reason: "event name",
  },
  {
    token: "merchant.settled",
    reason: "event name",
  },
  {
    token: "merchant.sweep",
    reason: "event name",
  },
  {
    token: "merchant.verified",
    reason: "event name",
  },
  {
    token: "soul.compile_failed",
    reason: "event name",
  },
  {
    token: "soul.json",
    reason: "file name",
  },
  {
    token: "soul.schema.json",
    reason: "file name",
  },
  {
    token: "objective.schema.json",
    reason: "file name",
  },
  {
    token: "hooks.json",
    reason: "file name",
  },
  {
    token: "mcp.json",
    reason: "file name",
  },
  {
    token: "config.toml",
    reason: "file name",
  },
  {
    token: "openapi.yaml",
    reason: "file name",
  },
  {
    token: "pricing.md",
    reason: "file name",
  },
  {
    token: "recompute.ts",
    reason: "file name",
  },
  {
    token: "memory.db",
    reason: "file name",
  },
  {
    token: "daemon.plist",
    reason: "file name",
  },
  {
    token: "daemon.service",
    reason: "file name",
  },
  {
    token: "soul.mdc",
    reason: "file name",
  },
  {
    token: "signer.sock",
    reason: "file name",
  },
  {
    token: "czar.dev",
    reason: "hostname / keychain item value",
  },
  {
    token: "rpc.testnet.arc.io",
    reason: "hostname / keychain item value",
  },
  {
    token: "rpc.mainnet.arc.io",
    reason: "hostname / keychain item value",
  },
  {
    token: "rpc.testnet.arc.network",
    reason: "hostname / keychain item value",
  },
  {
    token: "api.circle.com",
    reason: "hostname / keychain item value",
  },
  {
    token: "api.<env>.czar.dev",
    reason: "hostname / keychain item value",
  },
  {
    token: "app.<env>.czar.dev",
    reason: "hostname / keychain item value",
  },
  {
    token: "merchants.<env>.czar.dev",
    reason: "hostname / keychain item value",
  },
  {
    token: "dev.czar.signer.keystore",
    reason: "hostname / keychain item value",
  },
  {
    token: "objective.goal",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "provenance.flags",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "provenance.hookEvent",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "settings.paused",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "beliefs.deletedAt",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "getMe.balances.free",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "getResult.provenance",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "soul.json.hourlyValue",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "balances.pocketOutstanding",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "constraints.maxTotal",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "detail.hashMismatch",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "approval.txHash",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "extensions.bazaar.info.input",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "extensions.czar.evidence",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "gateway.require",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "inputTemplate.inputKeys",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "metadata.supportsVanillax402",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "msg.sender",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "paths.jobsHalted",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "paths.pocketHalted",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "paths.vaultDirectHalted",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "pay.input",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "receipt.paymentRefHash",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "source.origin",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "screen.flags",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "screen.modelUnavailable",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "redaction.layer1",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "redaction.layer2",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "roi.setByUser",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "mcp.server",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "vault.autonomyNonce",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "vault.code.length",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "vault.evaluator",
    reason: "object field path / log field / contract field, not config",
  },
  {
    token: "app.fxSource",
    reason:
      "removed by D51 (app-and-notifications.md:343; amendments line 40) — test grep must allowlist it",
  },
  {
    token: "kms.pocketKeyGraceHours",
    reason:
      "superseded by signer.pocketKeyRetainHours, signer.slowWithdrawMarginHours and signer.pocketDustAtomic (RV-004)",
  },
];

export const WILDCARDS: Readonly<Record<string, readonly string[]>> = {
  "soul.*": [
    "soul.confidenceHalfLifeDays",
    "soul.minReceipts",
    "soul.diversityTarget",
    "soul.evidenceScale",
    "soul.activeConfidence",
    "soul.missionWindowDays",
    "soul.ritualMinRepeats",
    "soul.ritualMinWeeks",
    "soul.staleDays",
    "soul.fadeDays",
    "soul.dropConfidence",
    "soul.archiveRetentionDays",
    "soul.maxCandidatesPerSession",
    "soul.excerptReceiptsPerCandidate",
    "soul.diffDelta",
    "soul.compileCron",
    "soul.allowedProvenance",
    "soul.versionRetention",
    "soul.maxScreenFlags",
  ],
  "models.*": [
    "models.screenMonthlyTokens",
    "models.readerMonthlyTokens",
    "models.plannerMonthlyTokens",
    "models.soulMonthlyTokens",
    "models.drivesMonthlyTokens",
    "models.refusalMonthlyTokens",
    "models.userMonthlyTokens",
    "models.screen.timeoutMs",
    "models.reader.timeoutMs",
    "models.soul-compiler.timeoutMs",
    "models.planner.timeoutMs",
    "models.drives-helper.timeoutMs",
    "models.refusal-classifier.timeoutMs",
  ],
  "models.<name>.timeoutMs": [
    "models.screen.timeoutMs",
    "models.reader.timeoutMs",
    "models.planner.timeoutMs",
    "models.soul-compiler.timeoutMs",
    "models.drives-helper.timeoutMs",
    "models.refusal-classifier.timeoutMs",
  ],
  "routing.gas.*": [
    "routing.gas.reserve",
    "routing.gas.settleBase",
    "routing.gas.settleIdx",
    "routing.gas.finalize",
    "routing.gas.pocketSetup",
    "routing.gas.pocketDrain",
    "routing.gas.pocketSweep",
  ],
  "drives.minutes.*": [
    "drives.minutes.placeholder",
    "drives.minutes.repeated-error",
    "drives.minutes.agent-refusal",
  ],
  "signer.gas.*": [
    "signer.gas.K3.minAtomic",
    "signer.gas.K3.targetAtomic",
    "signer.gas.K3.maxAtomic",
    "signer.gas.K7.minAtomic",
    "signer.gas.K7.targetAtomic",
    "signer.gas.K7.maxAtomic",
    "signer.gas.K8.minAtomic",
    "signer.gas.K8.targetAtomic",
    "signer.gas.K8.maxAtomic",
  ],
  "signer.gas.K7.*": [
    "signer.gas.K7.minAtomic",
    "signer.gas.K7.targetAtomic",
    "signer.gas.K7.maxAtomic",
  ],
  "signer.gas.K8.*": [
    "signer.gas.K8.minAtomic",
    "signer.gas.K8.targetAtomic",
    "signer.gas.K8.maxAtomic",
  ],
  "signer.gas.<key>.minAtomic": [
    "signer.gas.K3.minAtomic",
    "signer.gas.K7.minAtomic",
    "signer.gas.K8.minAtomic",
  ],
  "signer.gas.<key>.maxAtomic": [
    "signer.gas.K3.maxAtomic",
    "signer.gas.K7.maxAtomic",
    "signer.gas.K8.maxAtomic",
  ],
  "kms.maxSignaturesPerMin": [
    "kms.maxSignaturesPerMin.K3",
    "kms.maxSignaturesPerMin.K4",
    "kms.maxSignaturesPerMin.K5",
    "kms.maxSignaturesPerMin.K7",
    "kms.maxSignaturesPerMin.K8",
    "kms.maxSignaturesPerMin.K10",
    "kms.maxSignaturesPerMin.relayer",
  ],
  "fetch.*": [
    "fetch.maxRedirects",
    "fetch.maxBytes",
    "fetch.timeoutMs",
    "fetch.localMerchantOrigins",
  ],
  "acceptance.deliverableRefetch*": [
    "acceptance.deliverableRefetchTries",
    "acceptance.deliverableRefetchDelayMs",
  ],
};
