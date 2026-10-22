import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileObjectStore } from "#src/object-store";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("filesystem object store", () => {
  it("writes, reads and deletes content by a safe opaque reference", async () => {
    directory = await mkdtemp(join(tmpdir(), "czar-job-objects-"));
    const store = createFileObjectStore(directory);
    const body = new TextEncoder().encode("local deliverable");
    const ref = await store.put(body);
    expect(await store.get(ref)).toEqual(body);
    await store.delete(ref);
    await expect(store.get(ref)).rejects.toThrow();
  });

  it("rejects path traversal references", async () => {
    directory = await mkdtemp(join(tmpdir(), "czar-job-objects-"));
    await expect(createFileObjectStore(directory).get("../outside")).rejects.toThrow(
      "Object reference is invalid.",
    );
  });
});
