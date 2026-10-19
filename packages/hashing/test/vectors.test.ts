// T-007 acceptance: reproduce every entry of specs/02-data-and-protocol/vectors/eip712-vectors.json byte for byte.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  burnIntentDigest,
  derivedNonce,
  DOMAINS,
  domainSeparator,
  jobKey,
  KIND_TAGS,
  autonomyRaiseDigest,
  briefRequestDigest,
  ownerActionDigest,
  receiptAttestationDigest,
  receiptStructHash,
  slReceiptDigest,
  transferSpecBytes,
  transferSpecHash,
  TYPE_STRINGS,
  typeHash,
  usdcTransferWithAuthorizationDigest,
} from "@czar/hashing";

const fixture = fileURLToPath(new URL("../fixtures/eip712-vectors.json", import.meta.url));
const spec = fileURLToPath(
  new URL("../../../specs/02-data-and-protocol/vectors/eip712-vectors.json", import.meta.url),
);
const v = JSON.parse(readFileSync(fixture, "utf8"));
const VAULT = "0x00000000000000000000000000000000000c2a21";
const big = (x: string) => BigInt(x);

describe("eip712-vectors.json", () => {
  it("the package fixture is a byte copy of the spec file (T-023 consumes it)", () => {
    expect(readFileSync(fixture, "utf8")).toBe(readFileSync(spec, "utf8"));
  });

  it("type strings and type hashes", () => {
    for (const [name, entry] of Object.entries(
      v.typeHashes as Record<string, { typeString: string; typeHash: string }>,
    )) {
      expect(TYPE_STRINGS[name as keyof typeof TYPE_STRINGS], name).toBe(entry.typeString);
      expect(typeHash(entry.typeString), name).toBe(entry.typeHash);
    }
    expect(Object.keys(TYPE_STRINGS).toSorted()).toEqual(Object.keys(v.typeHashes).toSorted());
  });

  it("domain separators", () => {
    for (const chainId of [5042, 5042002]) {
      expect(domainSeparator(DOMAINS.usdc(chainId))).toBe(v.domains[`USDC_${chainId}`]);
      expect(domainSeparator(DOMAINS.czarVault(chainId, VAULT))).toBe(
        v.domains[`CzarVault_${chainId}_exampleVault`],
      );
      expect(domainSeparator(DOMAINS.czarJobBrief(chainId))).toBe(
        v.domains[`CzarJobBrief_${chainId}`],
      );
      expect(domainSeparator(DOMAINS.selectionLayer(chainId))).toBe(
        v.domains[`SelectionLayer_${chainId}`],
      );
    }
    expect(domainSeparator(DOMAINS.gatewayWallet())).toBe(v.domains.GatewayWallet_nameVersionOnly);
    expect(Object.keys(v.domains)).toHaveLength(9);
  });

  it("USDC TransferWithAuthorization digest", () => {
    const { message: m, digest } = v.vectors.usdcTransferWithAuthorization_5042002;
    expect(
      usdcTransferWithAuthorizationDigest(5042002, {
        from: m.from,
        to: m.to,
        value: big(m.value),
        validAfter: big(m.validAfter),
        validBefore: big(m.validBefore),
        nonce: m.nonce,
      }),
    ).toBe(digest);
  });

  it("Gateway BurnIntent digest, TransferSpec bytes and transferSpecHash", () => {
    const g = v.vectors.gatewayBurnIntent_sameChain;
    const s = g.message.spec;
    const spec2 = { ...s, value: big(s.value) };
    expect(
      burnIntentDigest({
        maxBlockHeight: big(g.message.maxBlockHeight),
        maxFee: big(g.message.maxFee),
        spec: spec2,
      }),
    ).toBe(g.digest);
    expect((transferSpecBytes(spec2).length - 2) / 2).toBe(g.transferSpecBytesLength);
    expect(transferSpecHash(spec2)).toBe(g.transferSpecHash);
  });

  it("SL Receipt struct hash and digest (SL_RECEIPT v2)", () => {
    const r = v.vectors.slReceipt_5042002;
    const m = r.message;
    const receipt = {
      ...m,
      tRequest: big(m.tRequest),
      tPaymentSigned: big(m.tPaymentSigned),
      tComplete: big(m.tComplete),
      createdAt: big(m.createdAt),
    };
    expect(receiptStructHash(receipt)).toBe(r.structHash);
    expect(slReceiptDigest(5042002, receipt)).toBe(r.digest);
  });

  it("ReceiptAttestation digest bound to one vault", () => {
    const r = v.vectors.receiptAttestation_5042002;
    expect(receiptAttestationDigest(5042002, r.vault, r.message.receiptStructHash)).toBe(r.digest);
    expect(
      receiptAttestationDigest(
        5042002,
        "0x00000000000000000000000000000000000c2a22",
        r.message.receiptStructHash,
      ),
    ).not.toBe(r.digest);
  });

  it("AutonomyRaise, OwnerAction and BriefRequest digests", () => {
    const a = v.vectors.autonomyRaise_5042002;
    expect(
      autonomyRaiseDigest(5042002, VAULT, {
        category: a.message.category,
        newLimit: big(a.message.newLimit),
        periodId: big(a.message.periodId),
        nonce: big(a.message.nonce),
        deadline: big(a.message.deadline),
      }),
    ).toBe(a.digest);
    const o = v.vectors.ownerAction_5042002;
    expect(
      ownerActionDigest(5042002, VAULT, {
        action: o.message.action,
        payloadHash: o.message.payloadHash,
        nonce: big(o.message.nonce),
        deadline: big(o.message.deadline),
      }),
    ).toBe(o.digest);
    const b = v.vectors.briefRequest_5042002;
    expect(jobKey("0x0747EEf0706327138c69792bF28Cd525089e4583", 42n)).toBe(b.message.jobKey);
    expect(
      briefRequestDigest(5042002, { jobKey: b.message.jobKey, issuedAt: big(b.message.issuedAt) }),
    ).toBe(b.digest);
  });

  it("derived nonce (czar-nonce-v1)", () => {
    const n = v.vectors.derivedNonce_example;
    expect(KIND_TAGS.NONCE_TAG).toBe(n.nonceTag);
    expect(derivedNonce(n.vault, big(n.reservationId), n.index)).toBe(n.nonce);
  });

  it("kind tags", () => {
    expect({
      USDC_3009: KIND_TAGS.USDC_3009,
      GATEWAY_BURN: KIND_TAGS.GATEWAY_BURN,
      SL_RECEIPT: KIND_TAGS.SL_RECEIPT,
      SL_RECEIPT_v1_retired: KIND_TAGS.SL_RECEIPT_V1_RETIRED,
      PAYEE_LEAF: KIND_TAGS.PAYEE_LEAF,
      EVIDENCE_LEAF: KIND_TAGS.EVIDENCE_LEAF,
    }).toEqual(v.vectors.kindTags);
  });

  it("covers every vector in the file", () => {
    expect(Object.keys(v.vectors).toSorted()).toEqual(
      [
        "autonomyRaise_5042002",
        "briefRequest_5042002",
        "derivedNonce_example",
        "gatewayBurnIntent_sameChain",
        "kindTags",
        "ownerAction_5042002",
        "receiptAttestation_5042002",
        "slReceipt_5042002",
        "usdcTransferWithAuthorization_5042002",
      ].toSorted(),
    );
  });
});
