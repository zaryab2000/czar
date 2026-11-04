// PM-017: the signer socket's group option (SCR-170 §4). With `signer.socketGroupGid` unset the folder
// and socket modes are exactly today's (0700 / 0600); with it set they are 0750 / 0660 and the socket is
// group-owned, while the owner checks still require the signer's own UID. Clients still authenticate
// with a per-service token, so file access alone grants nothing.
import { chmod, mkdir, mkdtemp, lstat, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSignerClient, startSignerSocket } from "../src/socket.ts";
import { fileSignerIdentity } from "../src/file-identity.ts";
import { memoryAudit, type Signer } from "../src/service.ts";
import { harness, PAYEE, VAULT } from "./helpers.ts";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

const signRequest = {
  keyId: "K3",
  kind: "usdc-3009",
  payload: {
    vault: VAULT,
    reservationId: "12",
    index: "0",
    to: PAYEE,
    value: "100000",
    validBefore: "1760800600",
  },
};

async function tokenDirectory(): Promise<{ dir: string; tokens: Record<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), "czar-signer-group-"));
  directories.push(dir);
  const clientTokens = join(dir, "signer", "client-tokens");
  await mkdir(clientTokens, { recursive: true, mode: 0o700 });
  const tokens: Record<string, string> = {};
  for (const service of ["server", "merchants", "relayer-jobs"]) {
    tokens[service] = randomBytes(24).toString("hex");
    const path = join(clientTokens, service);
    await writeFile(path, tokens[service] as string, { mode: 0o400 });
    await chmod(path, 0o400);
  }
  // Each client's own copy, as SCR-170 §4 lays them out.
  for (const service of ["server", "merchants"]) {
    await mkdir(join(dir, service), { recursive: true, mode: 0o700 });
    const path = join(dir, service, "signer-token");
    await writeFile(path, tokens[service] as string, { mode: 0o400 });
    await chmod(path, 0o400);
  }
  return { dir, tokens };
}

describe("signer socket group option", () => {
  it("keeps the folder 0700 and the socket 0600 when signer.socketGroupGid is unset", async () => {
    const { dir } = await tokenDirectory();
    const socketDir = join(dir, "run");
    const socketPath = join(socketDir, "signer.sock");
    const fixture = await harness();
    const stop = await startSignerSocket({
      socketPath,
      signer: fixture.signer as Signer,
      audit: memoryAudit(),
      identity: fileSignerIdentity(join(dir, "signer", "client-tokens")),
      allowedCallers: { server: ["cz-15"] },
    });
    try {
      expect((await lstat(socketDir)).mode & 0o777).toBe(0o700);
      expect((await lstat(socketPath)).mode & 0o777).toBe(0o600);
      const client = await createSignerClient({
        socketPath,
        service: "server",
        identity: fileSignerIdentity(dir, { services: ["server"], fileName: "signer-token" }),
      });
      expect("signature" in (await client.sign("cz-15", signRequest))).toBe(true);
    } finally {
      await stop();
    }
  });

  it("makes the folder 0750 and the socket 0660 group-owned when it is set", async () => {
    const { dir } = await tokenDirectory();
    const socketDir = join(dir, "run");
    const socketPath = join(socketDir, "signer.sock");
    const gid = process.getgid?.() ?? 0;
    const fixture = await harness();
    const audit = memoryAudit();
    const stop = await startSignerSocket({
      socketPath,
      signer: fixture.signer as Signer,
      audit,
      identity: fileSignerIdentity(join(dir, "signer", "client-tokens")),
      allowedCallers: { server: ["cz-15"] },
      socketGroupGid: gid,
    });
    try {
      const directory = await lstat(socketDir);
      const socket = await lstat(socketPath);
      expect(directory.mode & 0o777).toBe(0o750);
      expect(directory.gid).toBe(gid);
      expect(socket.mode & 0o777).toBe(0o660);
      expect(socket.gid).toBe(gid);
      expect(socket.uid).toBe(process.getuid?.());

      const client = await createSignerClient({
        socketPath,
        service: "server",
        identity: fileSignerIdentity(dir, { services: ["server"], fileName: "signer-token" }),
        socketGroupGid: gid,
      });
      const result = await client.sign("cz-15", signRequest);
      expect("signature" in result).toBe(true);

      // A wrong token is refused even though the socket is reachable through its group.
      const wrong = await createSignerClient({
        socketPath,
        service: "server",
        identity: { tokenFor: async () => randomBytes(24).toString("hex") },
        socketGroupGid: gid,
      });
      await expect(wrong.sign("cz-15", signRequest)).rejects.toMatchObject({
        rule: "service-token",
      });
      expect(audit.rows.map((row) => [row.outcome, row.rule])).toEqual([
        ["kms_denied", "service-token"],
      ]);
    } finally {
      await stop();
    }
  });

  it("refuses a client that expects a group socket when the socket is owner-only", async () => {
    const { dir } = await tokenDirectory();
    const socketPath = join(dir, "run", "signer.sock");
    const fixture = await harness();
    const stop = await startSignerSocket({
      socketPath,
      signer: fixture.signer as Signer,
      audit: memoryAudit(),
      identity: fileSignerIdentity(join(dir, "signer", "client-tokens")),
      allowedCallers: { server: ["cz-15"] },
    });
    try {
      const client = await createSignerClient({
        socketPath,
        service: "server",
        identity: fileSignerIdentity(dir, { services: ["server"], fileName: "signer-token" }),
        socketGroupGid: (process.getgid?.() ?? 0) + 1,
      });
      await expect(client.sign("cz-15", signRequest)).rejects.toThrow(/0660/);
    } finally {
      await stop();
    }
  });
});
