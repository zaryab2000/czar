import { describe, expect, it } from "vitest";
import { serviceVersionId } from "@czar/hashing";

const payTo = `0x${"1".repeat(40)}`;
const resource = { url: "https://a.example/x", method: "GET" as const };

describe("SCR-163 service version identity", () => {
  it("matches an independent raw UTF-8 Keccak vector with a null schema hash", () => {
    expect(serviceVersionId({ payTo, resource, schema: null })).toBe(
      "ver_d1d9f3b22884ebc71d12472f12f79b20",
    );
  });

  it("canonicalizes nested Bazaar schema null and object key order", () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string", default: null } },
    };
    expect(serviceVersionId({ payTo, resource, schema })).toBe(
      "ver_64e727299f0a78358c30eaf899186a72",
    );
    expect(
      serviceVersionId({
        payTo: payTo.toUpperCase().replace("0X", "0x"),
        resource: { method: "GET", url: "https://a.example/x" },
        schema: {
          properties: { answer: { default: null, type: "string" } },
          type: "object",
        },
      }),
    ).toBe(serviceVersionId({ payTo, resource, schema }));
  });

  it("changes with payee, resource, or schema", () => {
    const base = serviceVersionId({ payTo, resource, schema: null });
    expect(serviceVersionId({ payTo: `0x${"2".repeat(40)}`, resource, schema: null })).not.toBe(
      base,
    );
    expect(
      serviceVersionId({
        payTo,
        resource: { ...resource, url: "https://a.example/y" },
        schema: null,
      }),
    ).not.toBe(base);
    expect(serviceVersionId({ payTo, resource, schema: { type: "object" } })).not.toBe(base);
  });

  it("uses Czar JCS address normalization inside a Bazaar schema", () => {
    const address = `0x${"ab".repeat(20)}`;
    const lower = { type: "string", default: address };
    const upper = { type: "string", default: address.toUpperCase().replace("0X", "0x") };
    expect(serviceVersionId({ payTo, resource, schema: upper })).toBe(
      serviceVersionId({ payTo, resource, schema: lower }),
    );
  });
});
