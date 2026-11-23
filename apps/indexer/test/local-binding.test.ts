import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("local indexer API binding", () => {
  it("binds the internal settlement query to loopback", () => {
    const packageFile = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: { "start:local": string } };
    expect(packageFile.scripts["start:local"]).toContain("--hostname 127.0.0.1");
  });
});
