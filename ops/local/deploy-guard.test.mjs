import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("local deploy refuses an RPC without anvil_nodeInfo before accessing the manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "czar-local-deploy-guard-"));
  const bin = join(root, "bin");
  const script = join(root, "ops/local/deploy.sh");
  const calls = join(root, "calls.txt");
  const forgeCalls = join(root, "forge-calls.txt");
  await mkdir(join(root, "ops/local"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await copyFile(resolve(import.meta.dirname, "deploy.sh"), script);
  await writeFile(
    join(bin, "arc-cast"),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$CALLS"
if [ "$1" = chain-id ]; then printf '5042002'; exit 0; fi
exit 1
`,
  );
  await writeFile(
    join(bin, "arc-forge"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FORGE_CALLS"
`,
  );
  await Promise.all([chmod(join(bin, "arc-cast"), 0o755), chmod(join(bin, "arc-forge"), 0o755)]);

  try {
    const result = spawnSync("bash", [script], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        CALLS: calls,
        FORGE_CALLS: forgeCalls,
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not answer anvil_nodeInfo/);
    assert.match(
      await readFile(calls, "utf8"),
      /rpc anvil_nodeInfo --rpc-url http:\/\/127\.0\.0\.1:8545/,
    );
    await assert.rejects(readFile(forgeCalls, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, "deployments/local-keys.json"), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
