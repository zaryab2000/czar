// PM-017 acceptance: every existing signer decision gives the same outcome through the `gcp-kms`
// backend. This file re-runs the whole of `service.test.ts` and `policy.test.ts` — every accepted
// request, every denial rule, every audit row — with the Cloud KMS backend in place of the local
// keystore, against a fake Cloud KMS on loopback. Nothing here mocks the policy, the service or the
// audit sink, so a difference in any outcome (`signed`, `kms_denied` with its rule, `backend-error`)
// fails those tests exactly as it would locally.
//
// Each harness gets its own pair of key rings in the one fake, so a backend's restart scan only ever
// sees its own pocket keys.
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
import { metadataAccessToken } from "../src/gcp-auth.ts";
import { openGcpKmsBackend } from "../src/gcp-kms-backend.ts";
import { harness, setHarnessBackendFactory, VAULT, PAYEE } from "./helpers.ts";
import { startFakeKms, startFakeMetadata } from "./kms-fake.ts";

const kms = await startFakeKms();
const metadata = await startFakeMetadata();
let ring = 0;

const openKmsBackend = async () => {
  ring += 1;
  const config = loadConfig({
    envFile: {
      "signer.backend": "gcp-kms",
      "signer.kms.apiBaseUrl": kms.baseUrl,
      "signer.kms.projectId": kms.projectId,
      "signer.kms.location": kms.location,
      "signer.kms.keyRing": `harness-keys-${ring}`,
      "signer.kms.pocketKeyRing": `harness-pockets-${ring}`,
      "signer.kms.keyVersions": {},
    },
  });
  return openGcpKmsBackend({
    config,
    token: metadataAccessToken({ metadataTokenUrl: metadata.tokenUrl, timeoutMs: 2000 }),
    sleep: async () => undefined,
  });
};

setHarnessBackendFactory(openKmsBackend);

afterAll(async () => {
  setHarnessBackendFactory(undefined);
  await kms.close();
  await metadata.close();
});

describe("signer service on the gcp-kms backend", () => {
  it("uses the Cloud KMS backend for every harness in this file", async () => {
    const t = await harness();
    expect(t.backend.name).toBe("gcp-kms");
    expect(t.backend.keyRefs()).toEqual(
      [
        "K10:czar-search",
        "K3",
        "K5",
        "K6",
        "K7",
        "K8",
        "K20",
        `K4:${t.pocket}`,
        "relayer",
      ].toSorted(),
    );
  });

  it("holds the K21a and K21b test-provider keys in Cloud KMS when the harness asks for them (PM-058)", async () => {
    const t = await harness({ providerKeys: true });
    expect(t.backend.name).toBe("gcp-kms");
    expect(t.backend.keyRefs()).toEqual(expect.arrayContaining(["K21a", "K21b"]));
    expect(kms.created().map((key) => key.cryptoKeyId)).toEqual(
      expect.arrayContaining(["K21a", "K21b"]),
    );
  });

  it("signs, denies and reports a backend error exactly as the local keystore does", async () => {
    const t = await harness();
    const usdc = {
      vault: VAULT,
      reservationId: "12",
      index: "0",
      to: PAYEE,
      value: "100000",
      validBefore: "1760800600",
    };
    const signed = await t.signer.sign("cz-15", { keyId: "K3", kind: "usdc-3009", payload: usdc });
    // `usdc-3009` wraps the 65-byte signature in the transfer calldata, as it does locally.
    expect("signature" in signed && signed.signature).toMatch(/^0x[0-9a-f]+$/);
    expect(t.audit.rows.at(-1)).toMatchObject({ outcome: "signed", keyRef: "K3" });

    await expect(
      t.signer.sign("cz-17", { keyId: "K3", kind: "usdc-3009", payload: usdc }),
    ).rejects.toMatchObject({ rule: "caller-not-owner" });
    expect(t.audit.rows.at(-1)).toMatchObject({ outcome: "kms_denied", rule: "caller-not-owner" });

    // A Cloud KMS fault is not a policy denial: `service.ts` records `backend-error` and returns nothing.
    kms.faults.signStatus = 503;
    try {
      await expect(
        t.signer.sign("cz-15", {
          keyId: "K3",
          kind: "usdc-3009",
          payload: { ...usdc, index: "1" },
        }),
      ).rejects.toThrow(/cloud kms/i);
    } finally {
      delete kms.faults.signStatus;
    }
    expect(t.audit.rows.at(-1)).toMatchObject({ outcome: "backend-error", rule: "backend" });
  });
});

// The existing suites, re-collected in this file so they run against the backend set above.
await import("./service.test.ts");
await import("./policy.test.ts");
await import("./provider-call.test.ts");
