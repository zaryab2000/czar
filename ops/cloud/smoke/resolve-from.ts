// Imports a dependency the way one app resolves it (PM-014 smoke run). Test code only.
//
// ops/ is not a workspace package, and pnpm links each dependency only into the node_modules of the
// package that declares it, so a bare `import "viem"` from this folder does not resolve. The smoke
// entries load what they need through the app they drive, so they use exactly that app's version.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export async function importFrom<T>(app: "server" | "signer", specifier: string): Promise<T> {
  const anchor = new URL(`../../../apps/${app}/package.json`, import.meta.url);
  const resolved = createRequire(anchor).resolve(specifier);
  const module = (await import(pathToFileURL(resolved).href)) as T & { default?: T };
  return module.default ?? module;
}
