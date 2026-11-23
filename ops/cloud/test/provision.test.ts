// PM-011/PM-012: the provisioning script, the cloud-init image and the Caddy front door.
// Run with: node --test --experimental-strip-types ops/cloud/test/provision.test.ts
//
// Nothing in this file touches Google Cloud. `create.sh` is only ever run in its default
// dry-run mode, and one test proves that mode executes no command at all by putting a
// recording stand-in for `gcloud` on PATH.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cloudRoot = new URL("../", import.meta.url);
const repoRoot = new URL("../../../", import.meta.url);

function cloudFile(relative: string): string {
  return readFileSync(new URL(relative, cloudRoot), "utf8");
}

const createScriptPath = fileURLToPath(new URL("provision/create.sh", cloudRoot));
const createScript = cloudFile("provision/create.sh");
const cloudInit = cloudFile("provision/cloud-init.yaml");
const caddyfile = cloudFile("caddy/Caddyfile");
const secretsList = cloudFile("systemd/secrets.list");
const golden = cloudFile("test/golden/create-dry-run.txt");
const registry = readFileSync(new URL("packages/config/src/registry.ts", repoRoot), "utf8");
const productionRegistry = readFileSync(
  new URL("packages/config/src/registry-production.ts", repoRoot),
  "utf8",
);

type Run = { status: number; stdout: string; stderr: string };

function runCreate(args: readonly string[], pathPrefix?: string): Run {
  const result = spawnSync("bash", [createScriptPath, ...args], {
    cwd: fileURLToPath(repoRoot),
    encoding: "utf8",
    env: {
      ...process.env,
      ...(pathPrefix === undefined ? {} : { PATH: `${pathPrefix}:${process.env.PATH ?? ""}` }),
    },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Reads an integer default out of a registry entry, so no byte count is duplicated here. */
function registryDefault(source: string, key: string): number {
  const entry = source.split(/\n\s*\{\s*\n/).find((block) => block.includes(`key: "${key}"`));
  assert.ok(entry, `registry has no entry for ${key}`);
  const matched = /default:\s*(\d+),/.exec(entry);
  assert.ok(matched, `registry entry for ${key} has no integer default`);
  return Number(matched[1]);
}

test("create.sh dry run prints exactly the reviewed command list", () => {
  const run = runCreate(["--dry-run", "--project", "p", "--domain", "d.example"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, golden);
});

test("dry run is the default, with no flag at all", () => {
  const withFlag = runCreate(["--dry-run", "--project", "p", "--domain", "d.example"]);
  const withoutFlag = runCreate(["--project", "p", "--domain", "d.example"]);
  assert.equal(withoutFlag.status, 0, withoutFlag.stderr);
  assert.equal(withoutFlag.stdout, withFlag.stdout);
});

test("the dry run executes no command: a recording gcloud stand-in is never called", () => {
  const binDir = mkdtempSync(join(tmpdir(), "czar-create-bin-"));
  const marker = join(binDir, "called.log");
  for (const name of ["gcloud", "gsutil"]) {
    const stub = join(binDir, name);
    writeFileSync(stub, `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(marker)}\nexit 0\n`);
    chmodSync(stub, 0o755);
  }
  const run = runCreate(["--project", "p", "--domain", "d.example"], binDir);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(marker), false, "dry run invoked gcloud");
});

test("create.sh exits non-zero without --project", () => {
  const run = runCreate(["--dry-run", "--domain", "d.example"]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--project/);
  assert.equal(run.stdout, "");
});

test("create.sh exits non-zero without --domain", () => {
  const run = runCreate(["--dry-run", "--project", "p"]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--domain/);
  assert.equal(run.stdout, "");
});

test("create.sh exits non-zero on an unknown flag, printing nothing", () => {
  const run = runCreate(["--project", "p", "--domain", "d.example", "--wat"]);
  assert.notEqual(run.status, 0);
  assert.equal(run.stdout, "");
});

test("no printed line carries a credential value", () => {
  const run = runCreate(["--project", "p", "--domain", "d.example"]);
  const lines = run.stdout.split("\n");
  for (const line of lines) {
    assert.doesNotMatch(line, /-----BEGIN/, line);
    assert.doesNotMatch(line, /\b[0-9a-fA-F]{40,}\b/, `hex blob: ${line}`);
    assert.doesNotMatch(line, /--(password|token|api-key|passphrase)[= ]/, line);
    assert.doesNotMatch(line, /\b(PASSWORD|TOKEN|API_KEY|PASSPHRASE|MNEMONIC|SEED)=/, line);
    // Any line that mentions a credential at all may only name a Secret Manager resource.
    if (/password|api-key|signer-token|client-tokens/.test(line)) {
      assert.match(
        line,
        /^gcloud secrets (create|add-iam-policy-binding) czar-alpha-[a-z0-9-]+ /,
        `credential word outside a secret resource name: ${line}`,
      );
    }
  }
});

test("the printed list builds the machine SCR-170 §1 describes", () => {
  const run = runCreate(["--project", "p", "--domain", "d.example"]);
  const out = run.stdout;
  assert.match(out, /--machine-type=e2-medium/);
  assert.match(out, /--zone=asia-south1-a/);
  assert.match(out, /--image-family=debian-12/);
  assert.match(out, /--image-project=debian-cloud/);
  assert.match(out, /--boot-disk-size=30GB/);
  assert.match(out, /--boot-disk-type=pd-balanced/);
  assert.match(out, /--scopes=cloud-platform/);
  assert.match(out, /iam service-accounts create czar-alpha-vm/);
  assert.match(out, /kms keyrings create czar-alpha /);
  assert.match(out, /kms keyrings create czar-alpha-pockets /);
  // Arc testnet only, never mainnet: no other chain or RPC host may appear.
  assert.doesNotMatch(out, /rpc\.testnet\.arc\.network/);
  assert.doesNotMatch(out, /mainnet/);
});

test("--zone overrides the default zone and the derived region", () => {
  const run = runCreate(["--project", "p", "--domain", "d.example", "--zone", "europe-west1-b"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /--zone=europe-west1-b/);
  assert.doesNotMatch(run.stdout, /--zone=asia-south1-a/);
  assert.match(run.stdout, /--location=europe-west1/);
});

test("the firewall opens 80 and 443 to anyone and 22 only to the IAP range", () => {
  const out = runCreate(["--project", "p", "--domain", "d.example"]).stdout;
  const web = out.split("\n").find((line) => line.includes("czar-alpha-allow-web"));
  assert.ok(web, "no web firewall rule");
  assert.match(web, /--rules=tcp:80,tcp:443/);
  assert.match(web, /--source-ranges=0\.0\.0\.0\/0/);

  const ssh = out.split("\n").find((line) => line.includes("czar-alpha-allow-iap-ssh"));
  assert.ok(ssh, "no IAP ssh firewall rule");
  assert.match(ssh, /--rules=tcp:22/);
  assert.match(ssh, /--source-ranges=35\.235\.240\.0\/20/);

  // Nothing else inbound: the permissive default-network rules go, and a deny-all backs it up.
  assert.match(out, /firewall-rules delete default-allow-ssh/);
  assert.match(out, /firewall-rules delete default-allow-rdp/);
  const deny = out.split("\n").find((line) => line.includes("czar-alpha-deny-ingress"));
  assert.ok(deny, "no deny-all ingress rule");
  assert.match(deny, /--action=DENY/);
  assert.match(deny, /--rules=all/);
  assert.match(deny, /--source-ranges=0\.0\.0\.0\/0/);
  // Only the IAP range may ever reach 22: no rule may open it wider.
  for (const line of out.split("\n")) {
    if (/--rules=[^ ]*tcp:22/.test(line) && /--action=ALLOW/.test(line)) {
      assert.match(line, /--source-ranges=35\.235\.240\.0\/20/, line);
    }
  }
});

test("the service account gets only the SCR-170 §4 roles, each scoped", () => {
  const out = runCreate(["--project", "p", "--domain", "d.example"]).stdout;
  const bindings = out
    .split("\n")
    .filter((line) => line.includes("add-iam-policy-binding"))
    .map((line) => {
      const role = /--role=(\S+)/.exec(line);
      assert.ok(role, `binding without a role: ${line}`);
      return { line, role: role[1] };
    });
  const roles = new Set(bindings.map((binding) => binding.role));
  assert.deepEqual(
    [...roles].toSorted(),
    [
      "roles/cloudkms.admin",
      "roles/cloudkms.signerVerifier",
      "roles/cloudkms.viewer",
      "roles/secretmanager.secretAccessor",
      "roles/storage.objectAdmin",
    ],
    "the role set drifted from SCR-170 §4",
  );
  // No binding is ever made at project level: every one names a key ring, a secret or a bucket.
  for (const binding of bindings) {
    assert.doesNotMatch(
      binding.line,
      /^gcloud projects add-iam-policy-binding/,
      `project-level binding: ${binding.line}`,
    );
  }
  // cloudkms.admin exists only for the pocket key ring (runtime K4 creation).
  for (const binding of bindings) {
    if (binding.role === "roles/cloudkms.admin") {
      assert.match(binding.line, /kms keyrings add-iam-policy-binding czar-alpha-pockets /);
    }
  }
  // Signing rights exist only on the long-lived key ring.
  for (const binding of bindings) {
    if (binding.role === "roles/cloudkms.signerVerifier") {
      assert.match(binding.line, /kms keyrings add-iam-policy-binding czar-alpha /);
    }
  }
});

test("every secret named in secrets.list is created and bound, and nothing else is", () => {
  const out = runCreate(["--project", "p", "--domain", "d.example"]).stdout;
  const listed = new Set(
    secretsList
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim())
      .filter((line) => line !== "")
      .map((line) => line.split(/\s+/)[0] ?? ""),
  );
  assert.ok(listed.size > 0, "secrets.list is empty");
  const created = new Set(
    out
      .split("\n")
      .filter((line) => line.startsWith("gcloud secrets create "))
      .map((line) => line.split(" ")[3] ?? ""),
  );
  assert.deepEqual([...created].toSorted(), [...listed].toSorted());
  for (const name of listed) {
    assert.match(name, /^czar-alpha-/, `secret outside the czar-alpha-* prefix: ${name}`);
    assert.ok(
      out.includes(`gcloud secrets add-iam-policy-binding ${name} `),
      `no accessor binding for ${name}`,
    );
  }
  // A secret is created empty here. Adding a version is Zaryab's approval step, never this script.
  assert.doesNotMatch(out, /secrets versions add/);
});

test("the backup bucket is private and expires objects at deploy.backupRetentionDays", () => {
  const out = runCreate(["--project", "p", "--domain", "d.example"]).stdout;
  assert.match(out, /storage buckets create gs:\/\/czar-alpha-backups-p /);
  assert.match(out, /--uniform-bucket-level-access/);
  assert.match(out, /--public-access-prevention/);
  assert.match(out, /--lifecycle-file=ops\/cloud\/provision\/backup-lifecycle\.json/);

  const lifecycle = JSON.parse(cloudFile("provision/backup-lifecycle.json")) as {
    rule: { action: { type: string }; condition: { age: number } }[];
  };
  const retention = registryDefault(productionRegistry, "deploy.backupRetentionDays");
  assert.equal(lifecycle.rule.length, 1);
  assert.equal(lifecycle.rule[0]?.action.type, "Delete");
  assert.equal(lifecycle.rule[0]?.condition.age, retention);
});

test("create.sh is strict bash and refuses to apply without the explicit flag", () => {
  assert.match(createScript, /^#!\/usr\/bin\/env bash$/m);
  assert.match(createScript, /^set -euo pipefail$/m);
  // The only place a command is executed is behind the apply switch.
  assert.match(createScript, /if \[\[ "\$apply" == "yes" \]\]/);
});

test("cloud-init creates the users, group and signer socket folder SCR-170 §4 names", () => {
  // Created with groupadd/useradd rather than cloud-init's own users: module, because the
  // module's `gid` key is not available on every cloud-init a Debian 12 image may carry.
  assert.match(cloudInit, /groupadd --system --gid 10001 czar$/m);
  assert.match(
    cloudInit,
    /useradd --system --uid 10001 --gid 10001 --no-create-home --shell \/usr\/sbin\/nologin czar$/m,
  );
  assert.match(cloudInit, /groupadd --system --gid 10002 czar-signer$/m);
  assert.match(
    cloudInit,
    /useradd --system --uid 10002 --gid 10002 --no-create-home --shell \/usr\/sbin\/nologin czar-signer$/m,
  );
  assert.match(cloudInit, /groupadd --system --gid 10010 czar-signer-clients$/m);
  // Both users are in the signer-client group, so UID 10001 can open the signer's socket.
  assert.match(cloudInit, /usermod --append --groups czar-signer-clients czar$/m);
  assert.match(cloudInit, /usermod --append --groups czar-signer-clients czar-signer$/m);
  // Neither service user may log in.
  assert.doesNotMatch(cloudInit, /useradd[^\n]*--shell \/bin\/(ba)?sh/);

  // The signer socket folder: owned by the signer, readable by its client group, never world.
  // /run is a tmpfs, so tmpfiles.d recreates it on every later boot too.
  assert.match(cloudInit, /^ {6}d \/run\/czar\/signer 0750 10002 10010 -$/m);
  assert.match(cloudInit, /chown 10002:10010 \/run\/czar\/signer/);
  assert.match(cloudInit, /chmod 0750 \/run\/czar\/signer/);
});

test("cloud-init pins every third-party package and installs no unpinned one", () => {
  const installLines = cloudInit
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /apt-get (-y )?install/.test(line));
  assert.ok(installLines.length > 0, "cloud-init installs nothing");
  const tokens = installLines.flatMap((line) => line.split(/\s+/));

  // Docker, Caddy and the Ops Agent come from third-party repositories: each one pinned.
  const thirdParty = [
    "docker-ce",
    "docker-ce-cli",
    "containerd.io",
    "docker-compose-plugin",
    "caddy",
    "google-cloud-ops-agent",
    "postgresql-client-16",
  ];
  for (const name of thirdParty) {
    assert.ok(
      tokens.some((token) => token.startsWith(`${name}=`)),
      `${name} is not installed with a pinned version`,
    );
    assert.equal(tokens.includes(name), false, `${name} is also installed unpinned`);
    // A pinned version is worth nothing if apt upgrades past it on the next unattended run.
    assert.ok(
      new RegExp(`apt-mark hold[^\\n]*\\b${name.replace(".", "\\.")}\\b`).test(cloudInit),
      `${name} is pinned but not held`,
    );
  }

  // Only Debian's own signed point release may supply an unpinned package. Anything else
  // appearing here unpinned is a new third-party dependency that slipped in.
  const debianBase = new Set(["ca-certificates", "curl", "gnupg", "jq", "iptables"]);
  for (const token of tokens) {
    if (token.startsWith("-") || token.includes("=")) continue;
    if (["apt-get", "install"].includes(token)) continue;
    assert.ok(debianBase.has(token), `unpinned non-Debian package: ${token}`);
  }
});

test("every cloud-init runcmd entry is a command, not an accidental YAML mapping", () => {
  // A plain YAML scalar that contains a colon followed by a space parses as a MAPPING, so
  // `- curl -H 'Metadata-Flavor: Google' ...` silently becomes {"curl -H 'Metadata-Flavor":
  // "Google' ..."} and cloud-init never runs it. Such an entry must use the argv list form,
  // where each item is quoted.
  const lines = cloudInit.split("\n");
  const start = lines.indexOf("runcmd:");
  assert.ok(start > 0, "cloud-init has no runcmd block");
  let entries = 0;
  for (const line of lines.slice(start + 1)) {
    if (/^[a-z_]+:/.test(line)) break; // the next top-level key ends the block
    if (!line.startsWith("  - ")) continue;
    entries += 1;
    const entry = line.slice(4);
    if (entry.startsWith("[")) continue; // argv form: every item is its own quoted scalar
    assert.doesNotMatch(
      entry,
      /: /,
      `this entry parses as a YAML mapping, not a command; use the argv list form: ${entry}`,
    );
  }
  assert.ok(entries > 20, `only ${entries} runcmd entries found`);
});

test("cloud-init applies the metadata guard before Docker can start", () => {
  const guardEnable = cloudInit.indexOf("systemctl enable --now czar-metadata-guard.service");
  const dockerInstall = cloudInit.search(/apt-get (-y )?install[^\n]*docker-ce/);
  assert.ok(guardEnable > 0, "cloud-init never enables czar-metadata-guard.service");
  assert.ok(dockerInstall > 0, "cloud-init never installs docker-ce");
  assert.ok(
    guardEnable < dockerInstall,
    "Docker is installed before the metadata guard is applied",
  );
});

test("cloud-init installs every unit this task ships", () => {
  for (const unit of [
    "czar-metadata-guard.service",
    "czar-secrets.service",
    "run-czar-secrets.mount",
  ]) {
    assert.ok(cloudInit.includes(unit), `cloud-init does not install ${unit}`);
  }
  assert.match(cloudInit, /\/opt\/czar\/bin\/fetch-secrets\.sh/);
  assert.match(cloudInit, /\/opt\/czar\/bin\/metadata-guard\.sh/);
});

test("cloud-init writes no credential value and reads none from the environment", () => {
  for (const line of cloudInit.split("\n")) {
    assert.doesNotMatch(line, /-----BEGIN/, line);
    assert.doesNotMatch(line, /\b(PASSWORD|TOKEN|API_KEY|PASSPHRASE)=\S/, line);
  }
});

test("the Caddyfile is the only public listener and splits the two origins", () => {
  assert.match(caddyfile, /^app\.\{\$CZAR_DOMAIN\} \{$/m);
  assert.match(caddyfile, /^merchants\.\{\$CZAR_DOMAIN\} \{$/m);
  assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:3000/);
  assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:3100/);
  assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:8787/);
  // Every upstream is loopback: no container is ever addressed by another address.
  for (const match of caddyfile.matchAll(/reverse_proxy (\S+)/g)) {
    assert.match(match[1] ?? "", /^127\.0\.0\.1:\d+$/, `non-loopback upstream ${match[1]}`);
  }
  // No plaintext site block and no on-demand TLS: automatic HTTPS stays on.
  assert.doesNotMatch(caddyfile, /^http:\/\//m);
  assert.doesNotMatch(caddyfile, /auto_https\s+off/);
  assert.doesNotMatch(caddyfile, /on_demand/);
  assert.doesNotMatch(caddyfile, /tls\s+internal/);
});

test("the Caddyfile sends /v1/* and /health to the server and the rest to the web app", () => {
  const appBlock = caddyfile.slice(
    caddyfile.indexOf("app.{$CZAR_DOMAIN} {"),
    caddyfile.indexOf("merchants.{$CZAR_DOMAIN} {"),
  );
  assert.match(appBlock, /@czar_api path \/v1\/\*/);
  assert.match(appBlock, /@czar_health path \/health/);
  // The web app is the fall-through, and it is the last handler in the block.
  const fallThrough = appBlock.lastIndexOf("handle {");
  assert.ok(fallThrough > appBlock.indexOf("handle @czar_api"), "the API is not matched first");
  assert.match(appBlock.slice(fallThrough), /reverse_proxy 127\.0\.0\.1:3100/);
});

test("the Caddyfile caps /v1/* bodies at 1 MiB, with the job deliverable the one exception", () => {
  const deliverableLimit = registryDefault(registry, "acceptance.deliverableMaxBytes");
  // The deliverable route must be matched before the general /v1/* cap, or uploads break.
  const deliverableMatcher = caddyfile.indexOf("@czar_job_deliverable");
  const apiMatcher = caddyfile.indexOf("handle @czar_api");
  assert.ok(deliverableMatcher > 0, "no job-deliverable matcher");
  assert.ok(
    caddyfile.indexOf("handle @czar_job_deliverable") < apiMatcher,
    "the general /v1/* cap is matched before the job-deliverable route",
  );
  assert.match(
    caddyfile,
    /@czar_job_deliverable path_regexp \^\/v1\/jobs\/\[\^\/\]\+\/deliverable\$/,
    "the deliverable matcher does not match apps/server/src/app.ts's route shape",
  );
  const sizes = [...caddyfile.matchAll(/max_size (\d+)/g)].map((match) => Number(match[1]));
  assert.deepEqual(sizes, [deliverableLimit, 1048576], "body caps drifted");
});

test("both Caddy origins send the security headers the task names", () => {
  for (const header of ["Strict-Transport-Security", "X-Content-Type-Options", "Referrer-Policy"]) {
    assert.ok(caddyfile.includes(header), `the Caddyfile never sets ${header}`);
  }
  // The shared snippet is imported by both site blocks, so neither can drift.
  const imports = [...caddyfile.matchAll(/^\timport czar_security_headers$/gm)];
  assert.equal(imports.length, 2, "the security-header snippet is not imported by both origins");
});

test("the Caddy admin API is off, so a host-network container cannot reconfigure the proxy", () => {
  assert.match(caddyfile, /^\tadmin off$/m);
});

// ---- PM-052b: the nightly backup reaches the VM ------------------------------------------------

const BACKUP_FILES = [
  {
    attribute: "czar-backup-sh",
    source: "ops/cloud/backup/pg-backup.sh",
    target: "/opt/czar/ops/backup/pg-backup.sh",
  },
  {
    attribute: "czar-backup-lib-sh",
    source: "ops/cloud/backup/lib.sh",
    target: "/opt/czar/ops/backup/lib.sh",
  },
  {
    attribute: "czar-restore-drill-sh",
    source: "ops/cloud/backup/pg-restore-drill.sh",
    target: "/opt/czar/ops/backup/pg-restore-drill.sh",
  },
  {
    attribute: "czar-backup-service",
    source: "ops/cloud/backup/czar-backup.service",
    target: "/etc/systemd/system/czar-backup.service",
  },
  {
    attribute: "czar-backup-timer",
    source: "ops/cloud/backup/czar-backup.timer",
    target: "/etc/systemd/system/czar-backup.timer",
  },
] as const;

test("create.sh passes the backup files and the bucket name to the VM", () => {
  const run = runCreate(["--project", "p", "--domain", "d.example"]);
  assert.equal(run.status, 0, run.stderr);
  const create = run.stdout.split("\n").find((line) => line.includes("compute instances create"));
  assert.ok(create, "no instances create command");
  for (const { attribute, source } of BACKUP_FILES)
    assert.ok(create.includes(`${attribute}=${source}`), `${attribute} is not passed to the VM`);
  assert.match(
    create,
    /--metadata=CZAR_DOMAIN=d\.example,CZAR_BACKUP_BUCKET=czar-alpha-backups-p /,
  );
});

test("cloud-init fetches each backup file to the path the backup unit runs", () => {
  for (const { attribute, target } of BACKUP_FILES) {
    const escaped = target.replace(/[.\\/]/g, "\\$&");
    assert.match(
      cloudInit,
      new RegExp(`attributes/${attribute}",\\s*-o,\\s*${escaped},`),
      `${attribute} is not fetched to ${target}`,
    );
  }
  // The unit and the scripts agree on where they live: the script finds lib.sh beside itself.
  const service = cloudFile("backup/czar-backup.service");
  assert.match(service, /^ExecStart=\/opt\/czar\/ops\/backup\/pg-backup\.sh$/m);
  assert.match(service, /^EnvironmentFile=\/etc\/czar\/backup\.env$/m);
  assert.match(cloudInit, /install -d -m 0755 -o root -g root \/opt\/czar\/ops\/backup/);
  assert.match(
    cloudInit,
    /chmod 0755 \/opt\/czar\/ops\/backup\/pg-backup\.sh \/opt\/czar\/ops\/backup\/pg-restore-drill\.sh/,
  );
});

test("cloud-init writes only the bucket pointer to backup.env and enables the timer", () => {
  assert.match(cloudInit, /attributes\/CZAR_BACKUP_BUCKET",\s*-o,\s*\/run\/czar-backup-bucket,/);
  assert.match(
    cloudInit,
    /printf "CZAR_BACKUP_BUCKET=%s\\n" "\$\(cat \/run\/czar-backup-bucket\)" > \/etc\/czar\/backup\.env/,
  );
  assert.match(cloudInit, /rm -f \/run\/czar-backup-bucket/);
  assert.match(cloudInit, /chmod 0644 \/etc\/czar\/backup\.env/);
  // Enabled for the boot that follows; not started here, because the unit needs the credential
  // files czar-secrets.service writes once Zaryab has added the Secret Manager versions.
  assert.match(cloudInit, /^ {2}- systemctl enable czar-backup\.timer$/m);
  assert.doesNotMatch(
    cloudInit,
    /systemctl (enable )?--now czar-backup|systemctl start czar-backup/,
  );
});

test("cloud-init installs the PostgreSQL 16 client the backup script runs, from PGDG", () => {
  assert.match(
    cloudInit,
    /deb \[arch=amd64 signed-by=\/etc\/apt\/keyrings\/postgresql\.asc\] https:\/\/apt\.postgresql\.org\/pub\/repos\/apt bookworm-pgdg main/,
  );
  assert.match(cloudInit, /https:\/\/www\.postgresql\.org\/media\/keys\/ACCC4CF8\.asc/);
  assert.match(cloudInit, /postgresql-client-16=16\.15-1\.pgdg12\+2/);
});
