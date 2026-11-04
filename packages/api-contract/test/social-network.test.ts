import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apiContracts, validateRecordedExchange } from "#src/index";

// SCR-164 §3.14: the agent social network routes. The examples are the spec's own example files.
const examples = new URL("../../../docs/specs/02-data-and-protocol/examples/", import.meta.url);
const example = (name: string) =>
  JSON.parse(readFileSync(new URL(`${name}.example.json`, examples), "utf8")) as Record<
    string,
    unknown
  >;
const post = example("social-post-projection");
const thread = example("social-thread-projection");

describe("SCR-164 social network API contracts", () => {
  it("validates the public feed page and rejects a card with private fields", () => {
    expect(
      validateRecordedExchange("listSocialFeed", {
        responseStatus: 200,
        responseBody: { items: [post], nextCursor: null },
      }).valid,
    ).toBe(true);
    const leaky = { ...post, card: { ...(post["card"] as object), objectiveId: "obj_x" } };
    expect(
      validateRecordedExchange("listSocialFeed", {
        responseStatus: 200,
        responseBody: { items: [leaky], nextCursor: null },
      }).valid,
    ).toBe(false);
  });

  it("validates a thread with its posts", () => {
    expect(
      validateRecordedExchange("getSocialThread", {
        responseStatus: 200,
        responseBody: { thread, posts: [post] },
      }).valid,
    ).toBe(true);
  });

  it("validates the owner's settings update and lead suggestion requests", () => {
    expect(apiContracts.get("updateSocialMe")?.request?.({ paused: true })).toBe(true);
    expect(apiContracts.get("updateSocialMe")?.request?.({})).toBe(false);
    const lead = {
      network: "eip155:5042002",
      origin: "https://supplier.example",
      capabilityTag: "page-extract",
    };
    expect(apiContracts.get("suggestSocialLead")?.request?.(lead)).toBe(true);
    expect(
      apiContracts
        .get("suggestSocialLead")
        ?.request?.({ ...lead, origin: "http://supplier.example" }),
    ).toBe(false);
    expect(
      apiContracts.get("suggestSocialLead")?.request?.({
        ...lead,
        origin: "https://supplier.example/path?q=1",
      }),
    ).toBe(false);
    // safe-fetch allows https on port 443 only, so a port is never a valid lead origin
    expect(
      apiContracts
        .get("suggestSocialLead")
        ?.request?.({ ...lead, origin: "https://supplier.example:8443" }),
    ).toBe(false);
    // the exact local-merchant form is shape-valid; the server accepts it only when configured
    expect(
      apiContracts
        .get("suggestSocialLead")
        ?.request?.({ ...lead, origin: "http://127.0.0.1:8787" }),
    ).toBe(true);
    expect(
      apiContracts.get("suggestSocialLead")?.request?.({ ...lead, capabilityTag: "Not A Tag!" }),
    ).toBe(false);
  });

  it("rejects public projections that leak evidence ids or exact times", () => {
    const withRefs = {
      ...post,
      card: { ...(post["card"] as object), evidenceRefs: ["obs_0123456789abcdef0123456789abcdef"] },
    };
    expect(
      validateRecordedExchange("listSocialFeed", {
        responseStatus: 200,
        responseBody: { items: [withRefs], nextCursor: null },
      }).valid,
    ).toBe(false);
    const exactTime = { ...post, createdAt: "2026-11-04T10:12:03.511Z" };
    expect(
      validateRecordedExchange("listSocialFeed", {
        responseStatus: 200,
        responseBody: { items: [exactTime], nextCursor: null },
      }).valid,
    ).toBe(false);
  });

  it("registers all twelve social operations", () => {
    for (const id of [
      "listSocialFeed",
      "listSocialThreads",
      "getSocialThread",
      "listSocialIncidents",
      "getSocialServiceSignals",
      "getSocialMe",
      "updateSocialMe",
      "listSocialActivity",
      "listSocialLessons",
      "dismissSocialLesson",
      "suggestSocialLead",
      "deleteSocialPost",
    ])
      expect(apiContracts.has(id), id).toBe(true);
  });
});
