import { mkdtemp, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSignerClient, startSignerSocket, type SignerSocketIdentity } from "../src/socket.ts";
import { memoryAudit, type Signer } from "../src/service.ts";
import { harness, VAULT, PAYEE } from "./helpers.ts";

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

describe("signer Unix socket", () => {
  it("authenticates a service and round-trips a signer request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "czar-signer-"));
    const socketPath = join(dir, "signer.sock");
    const tokens = { server: "server-secret-token" };
    const identity: SignerSocketIdentity = {
      tokenFor: async (service) => tokens[service as keyof typeof tokens],
    };
    const fixture = await harness();
    const signer = fixture.signer as Signer;
    const audit = memoryAudit();
    const stop = await startSignerSocket({
      socketPath,
      signer,
      audit,
      identity,
      allowedCallers: { server: ["cz-15"] },
    });
    try {
      const client = await createSignerClient({
        socketPath,
        service: "server",
        identity,
      });
      const expected = await fixture.signer.sign("cz-15", signRequest);
      const result = await client.sign("cz-15", signRequest);
      expect(result).toEqual(expected);
      expect("signature" in result && result.digest).toMatch(/^0x[0-9a-f]{64}$/);
      expect(await client.createPocketKey("cz-15")).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect((await lstat(socketPath)).mode & 0o777).toBe(0o600);
    } finally {
      await stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("denies an unknown token and records only a redacted audit row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "czar-signer-"));
    const socketPath = join(dir, "signer.sock");
    const audit = memoryAudit();
    const identity: SignerSocketIdentity = { tokenFor: async () => "expected-token" };
    const signer: Pick<Signer, "sign" | "createPocketKey"> = {
      async sign() {
        throw new Error("must not reach signer");
      },
      async createPocketKey() {
        throw new Error("must not reach signer");
      },
    };
    const stop = await startSignerSocket({
      socketPath,
      signer,
      audit,
      identity,
      allowedCallers: { server: ["cz-15"] },
    });
    try {
      const client = await createSignerClient({
        socketPath,
        service: "server",
        identity: { tokenFor: async () => "wrong-token" },
      });
      await expect(client.sign("cz-15", signRequest)).rejects.toThrow("kms_denied");
      expect(audit.rows.map((row) => [row.outcome, row.rule])).toEqual([
        ["kms_denied", "service-token"],
      ]);
      expect(JSON.stringify(audit.rows)).not.toContain("wrong-token");
    } finally {
      await stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
