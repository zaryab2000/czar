// PM-051: uptime checks, resource alerts and the low-gas alert, as code.
// Run with: node --test --experimental-strip-types ops/cloud/test/monitoring.test.ts
//
// Nothing in this file touches Google Cloud. `create-alerts.sh` is run in its default dry-run
// mode, or with --apply against a recording stand-in for `gcloud` on PATH; the stand-in never
// reaches a network.
//
// The log-line tests use the signer's REAL emitting code: `logAlertPort` from
// apps/signer/src/cloud-main.ts, writing through the real `createLogger`. The Ops Agent itself is
// not available here, so a small model of its `parse_json` processor (written from the Ops Agent
// documentation) applies the shipped ops-agent.yaml to the Docker-wrapped line. That model is the
// one thing these tests cannot check against the real agent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cloudRoot = new URL("../", import.meta.url);
const repoRoot = new URL("../../../", import.meta.url);
const monitoringRoot = new URL("monitoring/", cloudRoot);

function monitoringFile(relative: string): string {
  return readFileSync(new URL(relative, monitoringRoot), "utf8");
}

const scriptPath = fileURLToPath(new URL("create-alerts.sh", monitoringRoot));
const script = monitoringFile("create-alerts.sh");
const golden = readFileSync(new URL("test/golden/monitoring-dry-run.txt", cloudRoot), "utf8");
const opsAgentYaml = monitoringFile("ops-agent.yaml");
const metricDefinition = JSON.parse(monitoringFile("metrics/signer-gas-low.json")) as {
  filter: string;
  labelExtractors: Record<string, string>;
};

type Run = { status: number; stdout: string; stderr: string };

function runScript(args: readonly string[], pathPrefix?: string): Run {
  const result = spawnSync("bash", [scriptPath, ...args], {
    cwd: fileURLToPath(repoRoot),
    encoding: "utf8",
    env: {
      ...process.env,
      ...(pathPrefix === undefined ? {} : { PATH: `${pathPrefix}:${process.env.PATH ?? ""}` }),
    },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A recording `gcloud` on PATH. The channel-create call answers with a fixed channel name. */
function recordingGcloud(): { binDir: string; marker: string } {
  const binDir = mkdtempSync(join(tmpdir(), "pm-051-bin-"));
  const marker = join(binDir, "called.log");
  const stub = join(binDir, "gcloud");
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(marker)}`,
      'case "$*" in',
      '  *"channels create"*) echo "projects/p/notificationChannels/4242" ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  return { binDir, marker };
}

// ---- the dry run --------------------------------------------------------------------------

test("create-alerts.sh dry run prints exactly the reviewed command list", () => {
  const run = runScript(["--dry-run", "--project", "p", "--domain", "d.example"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, golden);
});

test("dry run is the default, with no flag at all", () => {
  const withFlag = runScript(["--dry-run", "--project", "p", "--domain", "d.example"]);
  const withoutFlag = runScript(["--project", "p", "--domain", "d.example"]);
  assert.equal(withoutFlag.status, 0, withoutFlag.stderr);
  assert.equal(withoutFlag.stdout, withFlag.stdout);
});

test("the dry run executes no command: a recording gcloud stand-in is never called", () => {
  const { binDir, marker } = recordingGcloud();
  const run = runScript(["--project", "p", "--domain", "d.example"], binDir);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(marker), false, "dry run invoked gcloud");
});

test("the dry run carries a placeholder address, and --email replaces it", () => {
  const placeholder = runScript(["--project", "p", "--domain", "d.example"]);
  assert.match(placeholder.stdout, /email_address=OPERATOR_EMAIL_ADDRESS /);
  const supplied = runScript([
    "--project",
    "p",
    "--domain",
    "d.example",
    "--email",
    "ops@alerts.invalid",
  ]);
  assert.match(supplied.stdout, /email_address=ops@alerts\.invalid /);
  assert.doesNotMatch(supplied.stdout, /OPERATOR_EMAIL_ADDRESS/);
});

test("--apply without --email refuses and runs nothing", () => {
  const { binDir, marker } = recordingGcloud();
  const run = runScript(["--project", "p", "--domain", "d.example", "--apply"], binDir);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--email/);
  assert.equal(run.stdout, "");
  assert.equal(existsSync(marker), false);
});

test("--apply runs every command in order, with the new channel name in each policy", () => {
  const { binDir, marker } = recordingGcloud();
  const run = runScript(
    ["--project", "p", "--domain", "d.example", "--email", "ops@alerts.invalid", "--apply"],
    binDir,
  );
  assert.equal(run.status, 0, run.stderr);
  const calls = readFileSync(marker, "utf8").trim().split("\n");
  const printed = golden.trim().split("\n");
  assert.equal(calls.length, printed.length);
  assert.match(calls[0] ?? "", /^beta monitoring channels create /);
  assert.match(calls[0] ?? "", /email_address=ops@alerts\.invalid/);
  const policies = calls.filter((call) => call.startsWith("monitoring policies create "));
  assert.equal(policies.length, 4);
  for (const call of policies) {
    assert.match(call, /--notification-channels=projects\/p\/notificationChannels\/4242$/);
    assert.doesNotMatch(call, /@CHANNEL_NAME@/);
  }
  // The metric exists before any policy that reads it.
  const metricAt = calls.findIndex((call) => call.startsWith("logging metrics create "));
  const firstPolicyAt = calls.findIndex((call) => call.startsWith("monitoring policies create "));
  assert.ok(metricAt >= 0 && metricAt < firstPolicyAt);
});

test("create-alerts.sh exits non-zero without --project or --domain, printing nothing", () => {
  const noProject = runScript(["--dry-run", "--domain", "d.example"]);
  assert.notEqual(noProject.status, 0);
  assert.match(noProject.stderr, /--project/);
  assert.equal(noProject.stdout, "");
  const noDomain = runScript(["--dry-run", "--project", "p"]);
  assert.notEqual(noDomain.status, 0);
  assert.match(noDomain.stderr, /--domain/);
  assert.equal(noDomain.stdout, "");
});

test("create-alerts.sh rejects an unknown flag and a malformed address, printing nothing", () => {
  const unknown = runScript(["--project", "p", "--domain", "d.example", "--wat"]);
  assert.notEqual(unknown.status, 0);
  assert.equal(unknown.stdout, "");
  const badEmail = runScript(["--project", "p", "--domain", "d.example", "--email", "a b@c"]);
  assert.notEqual(badEmail.status, 0);
  assert.equal(badEmail.stdout, "");
});

test("the printed commands match the scope: two /health checks, every 60 s, three regions", () => {
  const lines = golden.trim().split("\n");
  const uptime = lines.filter((line) => line.startsWith("gcloud monitoring uptime create "));
  assert.equal(uptime.length, 2);
  assert.match(uptime[0] ?? "", /host=app\.d\.example,/);
  assert.match(uptime[1] ?? "", /host=merchants\.d\.example,/);
  for (const line of uptime) {
    assert.match(line, / --protocol=https /);
    assert.match(line, / --path=\/health /);
    assert.match(line, / --period=1 /);
    const regions = /--regions=(\S+)/.exec(line)?.[1]?.split(",") ?? [];
    assert.equal(new Set(regions).size, 3);
  }
  assert.equal(lines.filter((line) => line.includes("channels create")).length, 1);
  assert.match(lines[0] ?? "", / --type=email /);
});

test("no real address is in the monitoring folder, or the golden file", () => {
  const files = readdirSync(fileURLToPath(monitoringRoot), { recursive: true, encoding: "utf8" })
    .map((relative) => join(fileURLToPath(monitoringRoot), relative))
    .filter((path) => statSync(path).isFile());
  assert.ok(files.length === 7, "expected the monitoring definitions");
  for (const path of [
    ...files,
    fileURLToPath(new URL("test/golden/monitoring-dry-run.txt", cloudRoot)),
  ]) {
    const text = readFileSync(path, "utf8");
    assert.doesNotMatch(
      text,
      /[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/,
      `email-like text in ${path}`,
    );
  }
});

// ---- the alert policies -------------------------------------------------------------------

type Condition = {
  conditionThreshold: {
    filter: string;
    aggregations: { alignmentPeriod: string; perSeriesAligner: string }[];
    comparison: string;
    thresholdValue: number;
    duration: string;
  };
};

function policyCondition(file: string): Condition["conditionThreshold"] {
  const policy = JSON.parse(monitoringFile(`policies/${file}`)) as { conditions: Condition[] };
  assert.equal(policy.conditions.length, 1);
  return (policy.conditions[0] as Condition).conditionThreshold;
}

test("the four policies carry the reviewed thresholds and durations", () => {
  const uptime = policyCondition("uptime-failing.json");
  assert.match(uptime.filter, /uptime_check\/check_passed/);
  assert.equal(uptime.duration, "120s");

  const disk = policyCondition("disk-high.json");
  assert.match(disk.filter, /agent\.googleapis\.com\/disk\/percent_used/);
  assert.equal(disk.thresholdValue, 80);
  assert.equal(disk.comparison, "COMPARISON_GT");

  const memory = policyCondition("memory-high.json");
  assert.match(memory.filter, /agent\.googleapis\.com\/memory\/percent_used/);
  assert.equal(memory.thresholdValue, 90);
  assert.equal(memory.duration, "600s");

  const gas = policyCondition("signer-gas-low.json");
  assert.equal(gas.thresholdValue, 0);
  assert.equal(gas.comparison, "COMPARISON_GT");
  assert.equal(gas.aggregations[0]?.alignmentPeriod, "300s");
});

test("no policy embeds a notification channel: the script passes it at apply time", () => {
  for (const file of readdirSync(fileURLToPath(new URL("policies/", monitoringRoot)))) {
    assert.doesNotMatch(monitoringFile(`policies/${file}`), /notificationChannels/, file);
  }
});

test("the gas policy reads the log-based metric that the script creates", () => {
  const created = /gcloud logging metrics create (\S+) /.exec(golden)?.[1];
  assert.ok(created);
  assert.equal(
    policyCondition("signer-gas-low.json").filter,
    `metric.type="logging.googleapis.com/user/${created}"`,
  );
  assert.match(script, new RegExp(`GAS_METRIC_NAME="${created}"`));
});

// ---- the signer's real log line -----------------------------------------------------------

/** One YAML subset reader: block maps, block lists, plain or double-quoted scalars. */
type Yaml = string | boolean | Yaml[] | { [key: string]: Yaml };

function scalar(raw: string): string | boolean {
  assert.doesNotMatch(raw, / #/, `inline comment not supported: ${raw}`);
  assert.doesNotMatch(raw, /^[[{|>&*!]/, `unsupported YAML scalar: ${raw}`);
  if (/^".*"$/.test(raw)) return raw.slice(1, -1);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

function parseYaml(source: string): Yaml {
  const rows = source
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
    .map((line) => ({ indent: line.length - line.trimStart().length, text: line.trim() }));
  let position = 0;

  const block = (indent: number): Yaml => {
    const first = rows[position];
    assert.ok(first && first.indent === indent, "bad indentation");
    if (first.text.startsWith("- ")) {
      const list: Yaml[] = [];
      while (rows[position]?.indent === indent && rows[position]?.text.startsWith("- ")) {
        list.push(scalar((rows[position] as { text: string }).text.slice(2).trim()));
        position += 1;
      }
      return list;
    }
    const map: { [key: string]: Yaml } = {};
    while (rows[position]?.indent === indent) {
      const text = (rows[position] as { text: string }).text;
      const split = /^([A-Za-z0-9_]+):(?: (.*))?$/.exec(text);
      assert.ok(split, `unsupported YAML line: ${text}`);
      const key = split[1] as string;
      position += 1;
      if (split[2] === undefined || split[2] === "") {
        const child = rows[position];
        assert.ok(child && child.indent > indent, `${key} has no value`);
        map[key] = block(child.indent);
      } else {
        map[key] = scalar(split[2]);
      }
    }
    return map;
  };

  const parsed = block(0);
  assert.equal(position, rows.length, "unparsed YAML left over");
  return parsed;
}

function at(root: Yaml, path: string): Yaml {
  let node: Yaml = root;
  for (const part of path.split(".")) {
    assert.ok(typeof node === "object" && !Array.isArray(node), `${path}: not a map at ${part}`);
    const next: Yaml | undefined = node[part];
    assert.ok(next !== undefined, `${path}: no ${part}`);
    node = next;
  }
  return node;
}

type LogRecord = Record<string, unknown>;

/**
 * A model of the Ops Agent for the one pipeline this config defines. A `files` receiver yields
 * `{ message: <line> }`. A `parse_json` processor parses `field` (default `message`), removes it, and
 * merges the parsed keys into the record; `time_key` moves into the entry timestamp. A value that is
 * not a JSON object leaves the record unchanged. The record that remains is `jsonPayload`.
 */
function runPipeline(config: Yaml, pipeline: string, line: string): LogRecord {
  const wiring = at(config, `logging.service.pipelines.${pipeline}`);
  assert.ok(typeof wiring === "object" && !Array.isArray(wiring));
  const receiver = (wiring["receivers"] as Yaml[])[0];
  assert.equal(at(config, `logging.receivers.${String(receiver)}.type`), "files");
  const record: LogRecord = { message: line };
  for (const id of wiring["processors"] as string[]) {
    const processor = at(config, `logging.processors.${id}`) as { [key: string]: Yaml };
    assert.equal(processor["type"], "parse_json", `model only knows parse_json, got ${id}`);
    const field = typeof processor["field"] === "string" ? processor["field"] : "message";
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(record[field]));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    delete record[field];
    Object.assign(record, parsed);
    if (typeof processor["time_key"] === "string") delete record[processor["time_key"]];
  }
  return record;
}

/** Cloud Logging filter: `jsonPayload.<field>="<value>"` clauses joined by AND. */
function filterMatches(filter: string, jsonPayload: LogRecord): boolean {
  return filter.split(" AND ").every((clause) => {
    const parsed = /^jsonPayload\.([A-Za-z]+)="([^"]*)"$/.exec(clause.trim());
    assert.ok(parsed, `filter clause not understood: ${clause}`);
    return jsonPayload[parsed[1] as string] === parsed[2];
  });
}

async function realGasLowLine(message: string): Promise<string> {
  const { logAlertPort } = (await import(
    new URL("apps/signer/src/cloud-main.ts", repoRoot).href
  )) as {
    logAlertPort: (logger: unknown) => (message: string) => Promise<void>;
  };
  const { createLogger } = (await import(
    new URL("packages/logging/src/index.ts", repoRoot).href
  )) as {
    createLogger: (options: {
      service: string;
      component: string;
      sink: (line: string) => void;
    }) => unknown;
  };
  const lines: string[] = [];
  const logger = createLogger({
    service: "signer",
    component: "CZ-27",
    sink: (line) => lines.push(line),
  });
  await logAlertPort(logger)(message);
  assert.equal(lines.length, 1);
  return lines[0] as string;
}

/** What Docker's json-file driver writes for one stdout line of a container. */
function dockerJsonFileLine(appLine: string): string {
  return JSON.stringify({
    log: `${appLine}\n`,
    stream: "stdout",
    time: "2026-11-05T02:49:14.781234567Z",
  });
}

const opsAgent = parseYaml(opsAgentYaml);

test("the Ops Agent config reads the Docker json-file logs and records no file path", () => {
  const receiver = "logging.receivers.docker_json_files";
  assert.equal(at(opsAgent, `${receiver}.type`), "files");
  assert.deepEqual(at(opsAgent, `${receiver}.include_paths`), [
    "/var/lib/docker/containers/*/*-json.log",
  ]);
  // File paths are never logged (cross-cutting §4).
  assert.equal(at(opsAgent, `${receiver}.record_log_file_path`), false);
});

test("the Ops Agent config collects host metrics", () => {
  assert.equal(at(opsAgent, "metrics.receivers.hostmetrics.type"), "hostmetrics");
  assert.deepEqual(at(opsAgent, "metrics.service.pipelines.default_pipeline.receivers"), [
    "hostmetrics",
  ]);
});

test("the real signer_gas_low line, wrapped by Docker, parses to event and keyId", async () => {
  const appLine = await realGasLowLine("signer gas low for K7: below-min-after-refill");
  // The shape the filter must match, taken from the code that emits it.
  assert.equal((JSON.parse(appLine) as LogRecord)["event"], "signer_gas_low");
  assert.equal((JSON.parse(appLine) as LogRecord)["keyId"], "K7");

  const jsonPayload = runPipeline(opsAgent, "czar_containers", dockerJsonFileLine(appLine));
  assert.equal(jsonPayload["event"], "signer_gas_low");
  assert.equal(jsonPayload["keyId"], "K7");
  assert.equal(jsonPayload["service"], "signer");
  // Docker's own wrapper fields are consumed, not left as noise next to the app's fields.
  assert.equal(jsonPayload["log"], undefined);
  assert.equal(jsonPayload["message"], undefined);
});

test("the log-based metric filter matches that parsed entry and nothing else the signer emits", async () => {
  const filter = metricDefinition.filter;
  const gasLow = runPipeline(
    opsAgent,
    "czar_containers",
    dockerJsonFileLine(await realGasLowLine("signer gas low for K7: below-min-after-refill")),
  );
  assert.equal(filterMatches(filter, gasLow), true);

  // The signer's other alert event, and a Docker line that is not JSON at all.
  const otherAlert = runPipeline(
    opsAgent,
    "czar_containers",
    dockerJsonFileLine(await realGasLowLine("writeoff-manual-return-overdue vault=0x1")),
  );
  assert.equal(otherAlert["event"], "signer_alert_raised");
  assert.equal(filterMatches(filter, otherAlert), false);

  const plainText = runPipeline(
    opsAgent,
    "czar_containers",
    dockerJsonFileLine("LOG:  checkpoint starting: time"),
  );
  assert.equal(filterMatches(filter, plainText), false);
});

test("the metric's key_id label is extracted from keyId, and keyId is an allowed log field", async () => {
  assert.equal(metricDefinition.labelExtractors["key_id"], "EXTRACT(jsonPayload.keyId)");

  const { acceptField } = (await import(
    new URL("packages/logging/src/allowlist.ts", repoRoot).href
  )) as {
    acceptField: (name: string, value: unknown) => unknown;
  };
  // Every jsonPayload field the definitions read, checked against the logging allowlist.
  const read = new Set<string>();
  for (const text of [
    metricDefinition.filter,
    ...Object.values(metricDefinition.labelExtractors),
  ]) {
    for (const match of text.matchAll(/jsonPayload\.([A-Za-z]+)/g)) read.add(match[1] as string);
  }
  assert.deepEqual([...read].toSorted(), ["event", "keyId"]);
  assert.equal(acceptField("keyId", "K7"), "K7");
  assert.equal(acceptField("keyId", "relayer"), "relayer");
  // `event` is one of the logger's fixed fields, written for every line.
  const appLine = await realGasLowLine("signer gas low for K3: below-min-after-refill");
  assert.equal((JSON.parse(appLine) as LogRecord)["event"], "signer_gas_low");
});
