import { describe, expect, it } from "vitest";
import { runInRestrictedContext } from "#src/acceptance/context";

describe("acceptance VM context", () => {
  it.each(["fetch", "require", "process", "setTimeout"])(
    "rejects executor code that calls %s",
    (name) => {
      const source = "globalThis.runAcceptanceChecks = () => " + name + "('http://invalid.test');";
      expect(() => runInRestrictedContext(source, {})).toThrow();
    },
  );
});
