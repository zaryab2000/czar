import { PassThrough } from "node:stream";
import type { ReadStream } from "node:tty";
import { describe, expect, it } from "vitest";
import { readRatingKey } from "#src/results/rating-key";

function terminal() {
  const input = new PassThrough() as PassThrough & ReadStream;
  const rawModes: boolean[] = [];
  input.isRaw = false;
  input.setRawMode = (mode) => {
    rawModes.push(mode);
    input.isRaw = mode;
    return input;
  };
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk: Buffer) => { printed += chunk.toString(); });
  return { input, output, rawModes, printed: () => printed };
}

describe("single-key rating input", () => {
  it("resolves after one key without Enter and restores the prior terminal mode", async () => {
    const tty = terminal();
    const answer = readRatingKey(tty.input, tty.output, "Rate? [g] good");
    tty.input.write("g");
    expect(await answer).toBe("g");
    expect(tty.rawModes).toEqual([true, false]);
    expect(tty.input.isRaw).toBe(false);
    expect(tty.printed()).toContain("Rate? [g] good\n");
  });

  it("keeps a pre-existing raw terminal raw", async () => {
    const tty = terminal();
    tty.input.isRaw = true;
    const answer = readRatingKey(tty.input, tty.output, "Rate?");
    tty.input.write("b");
    expect(await answer).toBe("b");
    expect(tty.rawModes).toEqual([]);
    expect(tty.input.isRaw).toBe(true);
  });

  it("restores terminal mode when input fails", async () => {
    const tty = terminal();
    const answer = readRatingKey(tty.input, tty.output, "Rate?");
    tty.input.destroy(new Error("input lost"));
    await expect(answer).rejects.toThrow("input lost");
    expect(tty.rawModes).toEqual([true, false]);
  });
});
