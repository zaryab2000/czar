import { describe, expect, it } from "vitest";
import { apiContracts, validateRecordedExchange } from "#src/index";

const objectiveId = `obj_${"0".repeat(26)}`;
const ratingId = `rtg_${"0".repeat(26)}`;
const request = { objectiveId, stepIndex: 0, value: "good" };
const accepted = {
  ratingId,
  objectiveId,
  stepIndex: 0,
  value: "good",
  receipts: 1,
  windowClosesAt: "2026-11-13T00:00:00Z",
};
const supplier = {
  stepIndex: 0,
  merchantLabel: "merchant.example",
  merchantIsCzar: false,
  receipts: 1,
  effectiveRating: "none",
  canRate: true,
  canCorrect: false,
};
const prompt = {
  objectiveId,
  deliveredAt: "2026-10-30T00:00:00Z",
  windowClosesAt: "2026-11-13T00:00:00Z",
  steps: [supplier],
};

describe("Flow 4A rating API contracts", () => {
  it.each(["submitRating", "submitAppRating"])("validates %s request and response", (id) => {
    expect(apiContracts.get(id)?.request?.(request)).toBe(true);
    expect(apiContracts.get(id)?.request?.({ ...request, value: "neutral" })).toBe(false);
    expect(
      validateRecordedExchange(id, {
        requestBody: request,
        responseStatus: 202,
        responseBody: accepted,
      }).valid,
    ).toBe(true);
    expect(
      validateRecordedExchange(id, {
        requestBody: request,
        responseStatus: 202,
        responseBody: { ...accepted, receipts: 0 },
      }).valid,
    ).toBe(false);
  });

  it("validates the daemon rating prompt", () => {
    expect(
      validateRecordedExchange("getRatingPrompt", {
        responseStatus: 200,
        responseBody: prompt,
      }).valid,
    ).toBe(true);
    expect(
      validateRecordedExchange("getRatingPrompt", {
        responseStatus: 200,
        responseBody: { ...prompt, steps: [{ ...supplier, receipts: -1 }] },
      }).valid,
    ).toBe(false);
  });

  it("validates app result cards", () => {
    const card = {
      objectiveId,
      deliveredAt: prompt.deliveredAt,
      kind: "table-fill",
      stepCount: 1,
      suppliers: [supplier],
      windowClosesAt: prompt.windowClosesAt,
    };
    expect(
      validateRecordedExchange("listAppResults", {
        responseStatus: 200,
        responseBody: { items: [card], nextCursor: null },
      }).valid,
    ).toBe(true);
    expect(
      validateRecordedExchange("listAppResults", {
        responseStatus: 200,
        responseBody: { items: [{ ...card, stepCount: -1 }], nextCursor: null },
      }).valid,
    ).toBe(false);
  });
});
