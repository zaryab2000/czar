import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface ObjectStore {
  put(bytes: Uint8Array): Promise<string>;
  get(ref: string): Promise<Uint8Array>;
  delete(ref: string): Promise<void>;
}

export function createFileObjectStore(directory: string): ObjectStore {
  const root = resolve(directory);
  return {
    async put(bytes) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const ref = createHash("sha256").update(bytes).digest("hex");
      const path = objectPath(root, ref);
      try {
        await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      return ref;
    },
    async get(ref) {
      return new Uint8Array(await readFile(objectPath(root, ref)));
    },
    async delete(ref) {
      await rm(objectPath(root, ref), { force: true });
    },
  };
}

function objectPath(root: string, ref: string): string {
  if (!/^[0-9a-f]{64}$/.test(ref)) throw new TypeError("Object reference is invalid.");
  return join(root, ref);
}
