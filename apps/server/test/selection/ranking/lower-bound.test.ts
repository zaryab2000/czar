import { describe, expect, it } from "vitest";
import { wilsonLower } from "#src/selection/ranking/lower-bound";

describe("Wilson lower bound", () => {
  it.each([
    [1, 1, 0.2065],
    [2, 2, 0.3424],
    [5, 5, 0.5655],
    [9, 10, 0.5958],
    [8, 10, 0.4902],
    [3, 6, 0.1876],
    [0, 1, 0],
    [46, 50, 0.8116],
    [10, 10, 0.7225],
    [4, 5, 0.3755],
  ])("matches SCR-160 for %i good of %i ratings", (good, total, expected) => {
    expect(wilsonLower(good, total, 1.959964)).toBeCloseTo(expected, 4);
  });
});
