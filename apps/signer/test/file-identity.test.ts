// PM-017: signer socket tokens read from files (SCR-170 §4), for the cloud stage where there is no
// keychain. Token values here are throwaway strings generated per run; none is a real credential.
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileSignerIdentity } from "../src/file-identity.ts";
import { SOCKET_SERVICES } from "../src/socket.ts";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

async function credentialFilesDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "czar-signer-tokens-"));
  directories.push(dir);
  return dir;
}

const freshToken = () => randomBytes(24).toString("hex");

/** The signer's own copies: `<credentialFilesDir>/signer/client-tokens/<service>`, mode 0400. */
async function writeSignerTokens(dir: string): Promise<Record<string, string>> {
  const clientTokens = join(dir, "signer", "client-tokens");
  await mkdir(clientTokens, { recursive: true, mode: 0o700 });
  const tokens: Record<string, string> = {};
  for (const service of SOCKET_SERVICES) {
    tokens[service] = freshToken();
    const path = join(clientTokens, service);
    await writeFile(path, `${tokens[service]}\n`, { mode: 0o400 });
    await chmod(path, 0o400);
  }
  return tokens;
}

describe("fileSignerIdentity (SCR-170 §4)", () => {
  it("loads every service token from <dir>/<service> and trims it", async () => {
    const dir = await credentialFilesDir();
    const tokens = await writeSignerTokens(dir);
    const identity = fileSignerIdentity(join(dir, "signer", "client-tokens"));
    await identity.load?.();
    for (const service of SOCKET_SERVICES)
      expect(await identity.tokenFor(service)).toBe(tokens[service]);
    expect(await identity.tokenFor("unknown-service")).toBeUndefined();
  });

  it("reads a client's own token at <dir>/<service>/signer-token", async () => {
    const dir = await credentialFilesDir();
    await mkdir(join(dir, "server"), { recursive: true, mode: 0o700 });
    const token = freshToken();
    const path = join(dir, "server", "signer-token");
    await writeFile(path, token, { mode: 0o400 });
    await chmod(path, 0o400);
    const identity = fileSignerIdentity(dir, { services: ["server"], fileName: "signer-token" });
    await identity.load?.();
    expect(await identity.tokenFor("server")).toBe(token);
    // A client sees only its own folder, so it never claims another service's token.
    expect(await identity.tokenFor("merchants")).toBeUndefined();
  });

  it("refuses a missing token, a short token, a group-readable token and a symlink", async () => {
    const dir = await credentialFilesDir();
    const clientTokens = join(dir, "signer", "client-tokens");
    await mkdir(clientTokens, { recursive: true, mode: 0o700 });
    const identity = fileSignerIdentity(clientTokens);
    await expect(identity.load?.()).rejects.toThrow(/unavailable/);

    await writeFile(join(clientTokens, "server"), "too-short", { mode: 0o400 });
    await expect(identity.tokenFor("server")).rejects.toThrow(/too short/);

    const groupReadable = join(clientTokens, "merchants");
    await writeFile(groupReadable, freshToken(), { mode: 0o440 });
    await chmod(groupReadable, 0o440);
    await expect(identity.tokenFor("merchants")).rejects.toThrow(/group- or world-accessible/);

    const target = join(dir, "elsewhere");
    await writeFile(target, freshToken(), { mode: 0o400 });
    await symlink(target, join(clientTokens, "relayer-jobs"));
    await expect(identity.tokenFor("relayer-jobs")).rejects.toThrow(/not a plain file/);
  });

  it("never puts a token in an error message", async () => {
    const dir = await credentialFilesDir();
    const clientTokens = join(dir, "signer", "client-tokens");
    await mkdir(clientTokens, { recursive: true, mode: 0o700 });
    const token = freshToken();
    const path = join(clientTokens, "server");
    await writeFile(path, token, { mode: 0o440 });
    await chmod(path, 0o440);
    const identity = fileSignerIdentity(clientTokens);
    await expect(identity.tokenFor("server")).rejects.toThrow(
      expect.not.stringContaining(token) as unknown as string,
    );
  });

  it("caches a token after the first read", async () => {
    const dir = await credentialFilesDir();
    const tokens = await writeSignerTokens(dir);
    const clientTokens = join(dir, "signer", "client-tokens");
    const identity = fileSignerIdentity(clientTokens);
    expect(await identity.tokenFor("server")).toBe(tokens["server"]);
    await rm(join(clientTokens, "server"));
    expect(await identity.tokenFor("server")).toBe(tokens["server"]);
  });
});
