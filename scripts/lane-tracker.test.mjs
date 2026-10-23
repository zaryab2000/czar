import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { createTrackerServer } = await import(new URL("lane-tracker.mjs", import.meta.url));
const seed = JSON.parse(
  await readFile(new URL("../docs/lane-tracker/tasks.json", import.meta.url)),
);

async function withTracker(run) {
  const directory = await mkdtemp(join(tmpdir(), "czar-tracker-test-"));
  const dataPath = join(directory, "tasks.json");
  await writeFile(dataPath, JSON.stringify(seed));
  const server = createTrackerServer({ dataPath });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ origin, dataPath });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

async function state(origin) {
  const response = await fetch(`${origin}/api/tasks`);
  return { data: await response.json(), etag: response.headers.get("etag") };
}

async function requestWithHost(origin, host) {
  return new Promise((resolve, reject) => {
    const outgoing = request(origin, { headers: { Host: host } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function save(origin, current, overrides = {}) {
  return fetch(`${origin}/api/tasks`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "If-Match": current.etag,
      ...overrides,
    },
    body: JSON.stringify(current.data),
  });
}

test("adds and edits tasks with file persistence", async () =>
  withTracker(async ({ origin, dataPath }) => {
    const current = await state(origin);
    current.data.tasks.push({
      ...current.data.tasks[0],
      id: "new-task",
      title: "New acceptance task",
    });
    const saved = await save(origin, current);
    assert.equal(saved.status, 200);
    assert.notEqual(saved.headers.get("etag"), current.etag);
    const persisted = JSON.parse(await readFile(dataPath, "utf8"));
    assert.equal(persisted.tasks.at(-1).title, "New acceptance task");
    const next = await state(origin);
    next.data.tasks.at(-1).status = "in_progress";
    assert.equal((await save(origin, next)).status, 200);
    assert.equal((await state(origin)).data.tasks.at(-1).status, "in_progress");
  }));

test("rejects stale and simultaneous writes without losing the first edit", async () => {
  await withTracker(async ({ origin }) => {
    const first = await state(origin);
    const second = structuredClone(first);
    first.data.tasks[0].title = "First edit";
    second.data.tasks[0].title = "Second edit";
    const responses = await Promise.all([save(origin, first), save(origin, second)]);
    assert.deepEqual(responses.map((response) => response.status).toSorted(), [200, 409]);
    const title = (await state(origin)).data.tasks[0].title;
    assert.ok(["First edit", "Second edit"].includes(title));
    assert.equal((await save(origin, first)).status, 409);
  });
});

test("detects file edits made outside the browser", async () =>
  withTracker(async ({ origin, dataPath }) => {
    const current = await state(origin);
    await writeFile(dataPath, JSON.stringify({ ...seed, updatedAt: "external edit" }));
    assert.equal((await save(origin, current)).status, 409);
  }));

test("rejects invalid tasks and unsupported verification claims", async () => {
  await withTracker(async ({ origin }) => {
    for (const patch of [
      { lane: 6 },
      { title: " " },
      { status: "done" },
      { status: "verified", evidence: "" },
    ]) {
      const current = await state(origin);
      Object.assign(current.data.tasks[0], patch);
      assert.equal((await save(origin, current)).status, 400);
    }
    const duplicate = await state(origin);
    duplicate.data.tasks.push(duplicate.data.tasks[0]);
    assert.equal((await save(origin, duplicate)).status, 400);
  });
});

test("rejects cross-origin writes, unsafe hosts and invalid JSON", async () => {
  await withTracker(async ({ origin }) => {
    const current = await state(origin);
    assert.equal(
      (await save(origin, current, { Origin: "https://untrusted.example" })).status,
      403,
    );
    assert.equal((await save(origin, current, { "Content-Type": "text/plain" })).status, 415);
    assert.equal(await requestWithHost(origin, "untrusted.example"), 403);
    const invalid = await fetch(`${origin}/api/tasks`, {
      method: "PUT",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: "{broken",
    });
    assert.equal(invalid.status, 400);
    assert.equal((await fetch(`${origin}/.git/config`)).status, 404);
    assert.equal((await fetch(`${origin}/api/tasks`, { method: "DELETE" })).status, 405);
  });
});

test("serves the UI and rejects oversized updates", async () =>
  withTracker(async ({ origin }) => {
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(await page.text(), /Add task/);
    assert.equal((await fetch(`${origin}/app.js`)).status, 200);
    assert.equal((await fetch(`${origin}/style.css`)).status, 200);
    const response = await fetch(`${origin}/api/tasks`, {
      method: "PUT",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(1_048_576) }),
    });
    assert.equal(response.status, 413);
  }));
