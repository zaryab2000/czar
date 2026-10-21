import vm from "node:vm";

export function runInRestrictedContext(executorSource: string, input: unknown): unknown {
  const inputJson = JSON.stringify(input);
  if (inputJson === undefined) throw new TypeError("Sandbox input must be JSON data.");
  const context = vm.createContext(
    { inputJson },
    { codeGeneration: { strings: false, wasm: false } },
  );
  new vm.Script(executorSource, { filename: "checks.js" }).runInContext(context);
  const output = new vm.Script(
    "JSON.stringify(globalThis.runAcceptanceChecks(JSON.parse(inputJson)))",
  ).runInContext(context);
  if (typeof output !== "string")
    throw new TypeError("Sandbox executor returned a non-JSON result.");
  return JSON.parse(output);
}
