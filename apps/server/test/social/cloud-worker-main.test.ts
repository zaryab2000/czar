import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { startCloudSocialWorker } from "#src/social/cloud-worker-main";

const cloudExample = fileURLToPath(new URL("../../../../env/cloud.example.toml", import.meta.url));

it("refuses to start without the cloud config file", async () => {
  await expect(
    startCloudSocialWorker({
      CZAR_CLOUD_CONFIG: "/nonexistent/czar-social-cloud.toml",
      CZAR_DATABASE_URL: "postgres://czar_api@127.0.0.1:5432/czar",
      CZAR_ARC_RPC_URL: "https://rpc.testnet.arc.io",
    }),
  ).rejects.toThrow();
});

it("refuses to start without its database password file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "czar-social-cloud-test-"));
  try {
    const configPath = join(dir, "cloud.toml");
    const example = await readFile(cloudExample, "utf8");
    await writeFile(configPath, example.replace('"/run/czar/secrets"', JSON.stringify(dir)));
    await expect(
      startCloudSocialWorker({
        CZAR_CLOUD_CONFIG: configPath,
        CZAR_DATABASE_URL: "postgres://czar_api@127.0.0.1:5432/czar",
        CZAR_ARC_RPC_URL: "https://rpc.testnet.arc.io",
      }),
    ).rejects.toThrow(/db-password/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
