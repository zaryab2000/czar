// PM-011/PM-012: the boot-time credential-file unit (SCR-170 §4).
// Run with: node --test --experimental-strip-types ops/cloud/test/fetch-secrets.test.ts
//
// Credentials are files under deploy.credentialFilesDir, mode 0400, owned by the container UID
// that reads them. They are never environment variables, command-line arguments, image layers,
// compose files or config values (D70, D78).
//
// Nothing here talks to Google. A fake metadata server and a fake Secret Manager run on
// loopback, and the two base URLs are overridden for the test only. The fixture values below
// are invented strings, not credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const cloudRoot = new URL("../", import.meta.url);
const scriptPath = fileURLToPath(new URL("systemd/fetch-secrets.sh", cloudRoot));
const script = readFileSync(scriptPath, "utf8");
const unit = readFileSync(new URL("systemd/czar-secrets.service", cloudRoot), "utf8");
const mountUnit = readFileSync(new URL("systemd/run-czar-secrets.mount", cloudRoot), "utf8");
const shippedList = readFileSync(new URL("systemd/secrets.list", cloudRoot), "utf8");

const FAKE_TOKEN = "fake-access-token-for-the-test-only";
const FAKE_PROJECT = "czar-test-project";
/** Marker value: make the fake Secret Manager answer 200 with no `payload` at all. */
const EMPTY_PAYLOAD = "__no_payload__";

type Fake = {
  metadataOrigin: string;
  secretManagerOrigin: string;
  requests: { url: string; authorization: string; metadataFlavor: string }[];
  close: () => Promise<void>;
};

const servers: Server[] = [];
after(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

/** A fake metadata server and a fake Secret Manager, both on loopback. */
async function fakes(values: Record<string, string | number>): Promise<Fake> {
  const requests: Fake["requests"] = [];
  const record = (url: string, headers: Record<string, string | string[] | undefined>): void => {
    requests.push({
      url,
      authorization: String(headers.authorization ?? ""),
      metadataFlavor: String(headers["metadata-flavor"] ?? ""),
    });
  };

  const metadata = createServer((request, response) => {
    record(request.url ?? "", request.headers);
    if (request.headers["metadata-flavor"] !== "Google") {
      response.writeHead(403).end("missing Metadata-Flavor");
      return;
    }
    if ((request.url ?? "").endsWith("/project/project-id")) {
      response.writeHead(200, { "content-type": "text/plain" }).end(FAKE_PROJECT);
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ access_token: FAKE_TOKEN, expires_in: 3599, token_type: "Bearer" }));
  });

  const secretManager = createServer((request, response) => {
    const url = request.url ?? "";
    record(url, request.headers);
    if (request.headers.authorization !== `Bearer ${FAKE_TOKEN}`) {
      response.writeHead(401).end("bad token");
      return;
    }
    const matched = /^\/v1\/projects\/([^/]+)\/secrets\/([^/]+)\/versions\/latest:access$/.exec(
      url,
    );
    if (matched === null || matched[1] !== FAKE_PROJECT) {
      response.writeHead(400).end("bad path");
      return;
    }
    const value = values[matched[2] ?? ""];
    if (value === undefined) {
      response
        .writeHead(404, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { code: 404, status: "NOT_FOUND" } }));
      return;
    }
    if (typeof value === "number") {
      response.writeHead(value).end("fault");
      return;
    }
    // A 200 that carries no payload at all, to prove the script does not write garbage.
    if (value === EMPTY_PAYLOAD) {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ name: `projects/${FAKE_PROJECT}/secrets/${matched[2]}/versions/1` }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        name: `projects/${FAKE_PROJECT}/secrets/${matched[2]}/versions/1`,
        payload: { data: Buffer.from(value, "utf8").toString("base64") },
      }),
    );
  });

  const metadataOrigin = await listen(metadata);
  const secretManagerOrigin = await listen(secretManager);
  return {
    metadataOrigin,
    secretManagerOrigin,
    requests,
    close: async () => {},
  };
}

type Run = { status: number; stdout: string; stderr: string; dir: string };

/**
 * Runs the script against the fakes. Async on purpose: the fake servers live in this process,
 * so a synchronous spawn would block the event loop and the script's own requests would never
 * be answered.
 */
function runFetch(fake: Fake, listBody: string): Promise<Run> {
  const work = mkdtempSync(join(tmpdir(), "czar-secrets-"));
  const dir = join(work, "secrets");
  mkdirSync(dir, { recursive: true });
  const listPath = join(work, "secrets.list");
  writeFileSync(listPath, listBody);
  const child = spawn("bash", [scriptPath], {
    env: {
      ...process.env,
      CZAR_SECRETS_LIST: listPath,
      CZAR_CREDENTIAL_FILES_DIR: dir,
      CZAR_METADATA_TOKEN_URL: `${fake.metadataOrigin}/computeMetadata/v1/instance/service-accounts/default/token`,
      CZAR_METADATA_PROJECT_URL: `${fake.metadataOrigin}/computeMetadata/v1/project/project-id`,
      CZAR_SECRET_MANAGER_BASE_URL: fake.secretManagerOrigin,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise<Run>((resolve) => {
    child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr, dir }));
  });
}

const uid = process.getuid?.() ?? 0;

test("each listed credential becomes a 0400 file owned by its service UID", async () => {
  const fake = await fakes({
    "czar-alpha-db-password-server": "fixture-db-value",
    "czar-alpha-signer-token-server": "fixture-token-value",
  });
  const run = await runFetch(
    fake,
    [
      "# name service file uid requirement",
      `czar-alpha-db-password-server server db-password ${uid} required`,
      `czar-alpha-signer-token-server server signer-token ${uid} required`,
      `czar-alpha-signer-token-server signer client-tokens/server ${uid} required`,
      "",
    ].join("\n"),
  );
  assert.equal(run.status, 0, run.stderr);

  const written = [
    { path: join(run.dir, "server", "db-password"), value: "fixture-db-value" },
    { path: join(run.dir, "server", "signer-token"), value: "fixture-token-value" },
    { path: join(run.dir, "signer", "client-tokens", "server"), value: "fixture-token-value" },
  ];
  for (const file of written) {
    assert.ok(existsSync(file.path), `missing ${file.path}`);
    assert.equal(readFileSync(file.path, "utf8"), file.value);
    const stats = statSync(file.path);
    assert.equal(stats.mode & 0o777, 0o400, `${file.path} is not 0400`);
    assert.equal(stats.uid, uid);
  }
  // The service folder is readable by its own UID only: no other container may list it.
  const serviceDir = statSync(join(run.dir, "server"));
  assert.equal(serviceDir.mode & 0o777, 0o500);
  assert.equal(serviceDir.uid, uid);
});

test("a folder that exists only as a parent is owned and sealed like a leaf one", async () => {
  // signer/ here exists only because signer/client-tokens/ is below it. If it were left
  // root-owned at 0755, another container could list the signer's folder.
  const fake = await fakes({ "czar-alpha-signer-token-server": "fixture-token-value" });
  const run = await runFetch(
    fake,
    `czar-alpha-signer-token-server signer client-tokens/server ${uid} required\n`,
  );
  assert.equal(run.status, 0, run.stderr);
  for (const folder of [join(run.dir, "signer"), join(run.dir, "signer", "client-tokens")]) {
    const stats = statSync(folder);
    assert.equal(stats.mode & 0o777, 0o500, `${folder} is not 0500`);
    assert.equal(stats.uid, uid, `${folder} is not owned by the service UID`);
  }
  assert.equal(
    readFileSync(join(run.dir, "signer", "client-tokens", "server"), "utf8"),
    "fixture-token-value",
  );
});

test("nothing is printed to stdout, and no value or token reaches stderr", async () => {
  const fake = await fakes({ "czar-alpha-db-password-server": "fixture-db-value" });
  const run = await runFetch(
    fake,
    `czar-alpha-db-password-server server db-password ${uid} required\n`,
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  assert.doesNotMatch(run.stderr, /fixture-db-value/);
  assert.doesNotMatch(run.stderr, new RegExp(FAKE_TOKEN));
  // Names are allowed in the log; values never are.
  assert.match(run.stderr, /czar-alpha-db-password-server/);
});

test("the token is fetched once from the metadata server and sent as a bearer header", async () => {
  const fake = await fakes({
    "czar-alpha-db-password-server": "fixture-a",
    "czar-alpha-db-password-indexer": "fixture-b",
  });
  const run = await runFetch(
    fake,
    [
      `czar-alpha-db-password-server server db-password ${uid} required`,
      `czar-alpha-db-password-indexer indexer db-password ${uid} required`,
      "",
    ].join("\n"),
  );
  assert.equal(run.status, 0, run.stderr);
  const tokenRequests = fake.requests.filter((request) => request.url.endsWith("/token"));
  assert.equal(tokenRequests.length, 1, "the token is fetched more than once");
  assert.equal(tokenRequests[0]?.metadataFlavor, "Google");
  const accesses = fake.requests.filter((request) => request.url.includes(":access"));
  assert.equal(accesses.length, 2);
  for (const access of accesses) assert.equal(access.authorization, `Bearer ${FAKE_TOKEN}`);
});

test("a missing required credential fails the unit and writes no file", async () => {
  const fake = await fakes({ "czar-alpha-db-password-server": "fixture-a" });
  const run = await runFetch(
    fake,
    [
      `czar-alpha-db-password-server server db-password ${uid} required`,
      `czar-alpha-anthropic-api-key server anthropic-api-key ${uid} required`,
      "",
    ].join("\n"),
  );
  assert.notEqual(run.status, 0);
  assert.equal(existsSync(join(run.dir, "server", "anthropic-api-key")), false);
  assert.match(run.stderr, /czar-alpha-anthropic-api-key/);
});

test("a missing optional credential is skipped, because models.provider defaults to none", async () => {
  const fake = await fakes({ "czar-alpha-db-password-server": "fixture-a" });
  const run = await runFetch(
    fake,
    [
      `czar-alpha-db-password-server server db-password ${uid} required`,
      `czar-alpha-anthropic-api-key server anthropic-api-key ${uid} optional`,
      "",
    ].join("\n"),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(join(run.dir, "server", "db-password")));
  assert.equal(existsSync(join(run.dir, "server", "anthropic-api-key")), false);
});

test("a non-404 Secret Manager failure fails the unit even for an optional credential", async () => {
  const fake = await fakes({ "czar-alpha-anthropic-api-key": 500 });
  const run = await runFetch(
    fake,
    `czar-alpha-anthropic-api-key server anthropic-api-key ${uid} optional\n`,
  );
  assert.notEqual(run.status, 0, "a 500 must not be read as 'not configured'");
});

test("a 200 with no payload fails the unit instead of writing garbage", async () => {
  // `jq -r '.payload.data'` prints the literal "null" here, and `base64 --decode` turns that
  // into three bytes and exits 0. Without a check, the service would get a corrupt credential
  // and fail much later, somewhere unrelated.
  const fake = await fakes({ "czar-alpha-db-password-server": EMPTY_PAYLOAD });
  const run = await runFetch(
    fake,
    `czar-alpha-db-password-server server db-password ${uid} required\n`,
  );
  assert.notEqual(run.status, 0, "a payload-less 200 must fail the unit");
  assert.equal(existsSync(join(run.dir, "server", "db-password")), false, "garbage was written");
  assert.match(run.stderr, /no payload/);
});

test("nothing is ever written outside deploy.credentialFilesDir", async () => {
  const fake = await fakes({ "czar-alpha-db-password-server": "fixture-a" });
  for (const line of [
    `czar-alpha-db-password-server ../escape db-password ${uid} required`,
    `czar-alpha-db-password-server server ../../escape ${uid} required`,
    `czar-alpha-db-password-server server /etc/escape ${uid} required`,
  ]) {
    const run = await runFetch(fake, `${line}\n`);
    assert.notEqual(run.status, 0, `accepted an escaping destination: ${line}`);
    assert.equal(existsSync(join(run.dir, "..", "escape")), false);
  }
});

test("a malformed list line fails the unit instead of being skipped", async () => {
  const fake = await fakes({ "czar-alpha-db-password-server": "fixture-a" });
  for (const line of [
    "czar-alpha-db-password-server server db-password",
    `czar-alpha-db-password-server server db-password ${uid} maybe`,
    `czar-alpha-db-password-server server db-password notanumber required`,
  ]) {
    const run = await runFetch(fake, `${line}\n`);
    assert.notEqual(run.status, 0, `accepted a malformed line: ${line}`);
  }
});

test("the script keeps values off command lines and out of the environment", () => {
  assert.match(script, /^#!\/usr\/bin\/env bash$/m);
  assert.match(script, /^set -euo pipefail$/m);
  assert.match(script, /^umask 077$/m);
  // A value is never echoed, exported, or passed as an argument.
  assert.doesNotMatch(script, /^\s*echo "\$value/m);
  assert.doesNotMatch(script, /export [A-Z_]*(PASSWORD|TOKEN|SECRET|KEY)/);
  assert.doesNotMatch(script, /set -x/);
  // curl reads the bearer header from a file, never from argv, where `ps` would show it.
  assert.match(script, /--header-file|-H @|@"\$header_file"/);
});

test("the unit runs at boot, as root, after the credential tmpfs is mounted", () => {
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^RemainAfterExit=yes$/m);
  assert.match(unit, /^ExecStart=\/opt\/czar\/bin\/fetch-secrets\.sh$/m);
  assert.match(unit, /^Requires=run-czar-secrets\.mount$/m);
  assert.match(unit, /^After=run-czar-secrets\.mount network-online\.target$/m);
  assert.match(unit, /^Before=docker\.service$/m);
  assert.match(unit, /^WantedBy=multi-user\.target$/m);
  // No credential may be handed to the unit through its own environment.
  assert.doesNotMatch(unit, /^Environment=/m);
  assert.doesNotMatch(unit, /^EnvironmentFile=/m);
});

test("the credential folder is a dedicated tmpfs with no exec, suid or devices", () => {
  assert.match(mountUnit, /^Where=\/run\/czar\/secrets$/m);
  assert.match(mountUnit, /^Type=tmpfs$/m);
  for (const option of ["nosuid", "nodev", "noexec", "mode=0755", "size="]) {
    assert.ok(mountUnit.includes(option), `the mount is missing ${option}`);
  }
});

test("the shipped list names files only, with the signer's own UID on the signer's files", () => {
  const rows = shippedList
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter((line) => line !== "")
    .map((line) => line.split(/\s+/));
  assert.ok(rows.length > 0, "secrets.list is empty");
  for (const row of rows) {
    assert.equal(row.length, 5, `malformed row: ${row.join(" ")}`);
    const [name, service, , rowUid, requirement] = row;
    assert.match(name ?? "", /^czar-alpha-[a-z0-9-]+$/, `secret name: ${name}`);
    assert.ok(["required", "optional"].includes(requirement ?? ""), `requirement: ${requirement}`);
    // SCR-170 §4: the signer image runs as 10002, every other Czar image as 10001.
    const expected = service === "signer" ? "10002" : service === "backup" ? "0" : "10001";
    assert.equal(rowUid, expected, `wrong UID for ${service}: ${rowUid}`);
  }
  // The list holds names, never values: no row may carry anything that looks like one.
  assert.doesNotMatch(shippedList, /-----BEGIN/);
  assert.doesNotMatch(shippedList, /\b[0-9a-fA-F]{32,}\b/);
  // The Anthropic key is optional, because models.provider defaults to none (SCR-170 §6).
  const anthropic = rows.find((row) => row[0] === "czar-alpha-anthropic-api-key");
  assert.ok(anthropic, "the list never names the Anthropic key file");
  assert.equal(anthropic[4], "optional");
});
