// PM-014c: the database options every cloud service builds its pool from (SCR-170 §4).
//
// node-postgres drops a password function when the options carry a `connectionString`: parsing a
// URL with no password writes `password: null` over it, and the server then fails SCRAM with
// "client password must be a string". So the options hold discrete fields, never a URL.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cloudPoolOptions } from "@czar/config";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) await rm(directories.pop() ?? "", { recursive: true });
});

async function passwordFile(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "czar-pool-options-"));
  directories.push(directory);
  const path = join(directory, "db-password");
  await writeFile(path, content, { mode: 0o600 });
  return path;
}

describe("cloudPoolOptions", () => {
  it("splits the URL into discrete fields and carries no connection string", async () => {
    const options = cloudPoolOptions(
      new URL("postgres://czar_api@127.0.0.1:5433/czar"),
      await passwordFile("x"),
    );
    expect(options).toMatchObject({
      host: "127.0.0.1",
      port: 5433,
      database: "czar",
      user: "czar_api",
    });
    expect("connectionString" in options).toBe(false);
  });

  it("leaves the port to node-postgres when the URL names none", async () => {
    const options = cloudPoolOptions(
      new URL("postgres://czar_api@127.0.0.1/czar"),
      await passwordFile("x"),
    );
    expect("port" in options).toBe(false);
  });

  it("reads the password from the file at each connection, without its trailing newline", async () => {
    const path = await passwordFile("from-the-file\n");
    const options = cloudPoolOptions(new URL("postgres://czar_api@127.0.0.1/czar"), path);
    await expect(options.password()).resolves.toBe("from-the-file");
    await writeFile(path, "rotated\n");
    await expect(options.password()).resolves.toBe("rotated");
  });

  it("fails with the file's own error when the password file is missing", async () => {
    const options = cloudPoolOptions(
      new URL("postgres://czar_api@127.0.0.1/czar"),
      "/nonexistent/db-password",
    );
    await expect(options.password()).rejects.toThrow(/ENOENT/);
  });
});
