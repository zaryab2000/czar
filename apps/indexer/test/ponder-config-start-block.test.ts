import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function loadConfiguredStartBlock(value?: string): Promise<ReturnType<typeof spawnSync>> {
  const directory = await mkdtemp(join(tmpdir(), "czar-indexer-config-"));
  temporaryDirectories.push(directory);
  const deploymentPath = join(directory, "deployment.json");
  await writeFile(
    deploymentPath,
    JSON.stringify({
      CzarVaultFactory: "0x0000000000000000000000000000000000000001",
      OpenEvidenceLog: "0x0000000000000000000000000000000000000002",
    }),
  );

  const configUrl = pathToFileURL(resolve(import.meta.dirname, "../ponder.config.ts")).href;
  const script =
    `import config from ${JSON.stringify(configUrl)};` +
    "process.stdout.write(String(config.contracts.CzarVaultFactory.startBlock));";
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"],
    HOME: process.env["HOME"],
    CZAR_LOCAL_CONFIG: resolve(import.meta.dirname, "../../../env/local.toml"),
    CZAR_INDEXER_DEPLOYMENT_PATH: deploymentPath,
  };
  if (value !== undefined) env["CZAR_INDEXER_START_BLOCK"] = value;

  return spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      script,
    ],
    { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", env },
  );
}

describe("CZAR_INDEXER_START_BLOCK config", () => {
  it("defaults to block zero when unset", async () => {
    const result = await loadConfiguredStartBlock();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0");
  });

  it.each(["abc", "-1", "1.5"])("rejects malformed value %s", async (value) => {
    const result = await loadConfiguredStartBlock(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CZAR_INDEXER_START_BLOCK");
  });

  it("rejects values outside the safe integer range", async () => {
    const result = await loadConfiguredStartBlock("9007199254740992");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CZAR_INDEXER_START_BLOCK");
    expect(result.stderr).toContain("safe integer");
  });
});
