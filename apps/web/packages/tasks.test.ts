// UX-02, UX-03 / SCR-181 §2, §6: the New task form's checks, which mirror the server's limits, and the plain
// labels the progress view shows for each objective state.
import { describe, expect, it } from "vitest";
import { PARAMETERS } from "@czar/config/registry";
import {
  buildTaskRequest,
  isTaskFinished,
  parseUsdBudget,
  TASK_POLL_MS,
  TASK_PRIVACY_NOTICE,
  TASK_SOURCE_MAX_CHARS,
  taskStateLabel,
  type TaskForm,
} from "#src/tasks";

const SOURCE = "contract Vault { function withdraw() public {} }";
const ADDRESS = "0x00000000000000000000000000000000000000c0";
const form = (overrides: Partial<TaskForm> = {}): TaskForm => ({
  title: "Vault audit",
  description: "Check the withdraw path.",
  mode: "source",
  source: SOURCE,
  address: "",
  maxBudget: "",
  ...overrides,
});
const registryDefault = (key: string) => PARAMETERS.find((spec) => spec.key === key)?.default;

describe("New task limits come from the registry", () => {
  it("uses app.objectiveMaxSourceChars and app.objectivePollSeconds", () => {
    expect(TASK_SOURCE_MAX_CHARS).toBe(registryDefault("app.objectiveMaxSourceChars"));
    expect(TASK_POLL_MS).toBe(Number(registryDefault("app.objectivePollSeconds")) * 1000);
  });

  it("states the privacy line exactly as SCR-181 §4 words it", () => {
    expect(TASK_PRIVACY_NOTICE).toBe(
      "What you paste is sent to Czar and to the merchant you approve. Do not paste secrets or private keys.",
    );
  });
});

describe("buildTaskRequest", () => {
  it("builds a source task", () => {
    expect(buildTaskRequest(form())).toEqual({
      ok: true,
      request: {
        kind: "smart-contract-audit",
        title: "Vault audit",
        description: "Check the withdraw path.",
        contractSource: SOURCE,
      },
    });
  });

  it("builds an address task with a budget, and never sends the unused source", () => {
    expect(
      buildTaskRequest(
        form({ mode: "address", address: ADDRESS, source: SOURCE, maxBudget: "1.5" }),
      ),
    ).toEqual({
      ok: true,
      request: {
        kind: "smart-contract-audit",
        title: "Vault audit",
        description: "Check the withdraw path.",
        contractAddress: ADDRESS,
        maxTotal: "1500000",
      },
    });
  });

  it.each([
    ["an empty title", form({ title: "  " }), "Give the task a short title."],
    [
      "a title over 120 characters",
      form({ title: "t".repeat(121) }),
      "Keep the title under 120 characters.",
    ],
    [
      "a description over 1000 characters",
      form({ description: "d".repeat(1001) }),
      "Keep the description under 1,000 characters.",
    ],
    ["an empty source", form({ source: "" }), "Paste the contract source."],
    [
      "a source over the limit",
      form({ source: "s".repeat(2001) }),
      "The source is over 2,000 characters. Use the contract address instead.",
    ],
    [
      "a malformed address",
      form({ mode: "address", address: "0x12" }),
      "Enter a 0x contract address (40 hex characters).",
    ],
    [
      "a malformed budget",
      form({ maxBudget: "1.2345678" }),
      "Enter the budget in USDC, for example 1.50.",
    ],
  ])("refuses %s with a plain message", (_name, input, error) => {
    expect(buildTaskRequest(input)).toEqual({ ok: false, error });
  });
});

describe("parseUsdBudget", () => {
  it.each([
    ["", undefined],
    ["1", "1000000"],
    ["0.5", "500000"],
    ["2.000001", "2000001"],
  ])("reads %j as %j atomic USDC", (text, atomic) => {
    expect(parseUsdBudget(text)).toEqual({ ok: true, atomic });
  });

  it.each(["0", "-1", "1e3", "abc", "0.0000001"])("refuses %j", (text) => {
    expect(parseUsdBudget(text).ok).toBe(false);
  });
});

describe("taskStateLabel", () => {
  it.each([
    ["received", "Finding the best merchant…"],
    ["planning", "Finding the best merchant…"],
    ["replanning", "Finding the best merchant…"],
    ["no-supplier", "No merchant found yet"],
    ["awaiting-approval", "Waiting for your approval"],
    ["opening", "Paying and running…"],
    ["executing", "Paying and running…"],
    ["delivered", "Delivered"],
    ["failed", "Something went wrong"],
    ["expired", "Closed"],
    ["dismissed", "Closed"],
  ] as const)("labels %s as %j", (state, label) => {
    expect(taskStateLabel(state)).toBe(label);
  });
});

describe("isTaskFinished", () => {
  // The server's state machine gives these states no way out (apps/server/src/objectives/state.ts).
  it.each(["delivered", "failed", "expired", "dismissed", "no-supplier"] as const)(
    "stops polling at %s",
    (state) => {
      expect(isTaskFinished(state)).toBe(true);
    },
  );

  it.each([
    "received",
    "planning",
    "replanning",
    "awaiting-approval",
    "opening",
    "executing",
  ] as const)("keeps polling at %s", (state) => {
    expect(isTaskFinished(state)).toBe(false);
  });
});
