import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = new URL("../docs/lane-tracker/", import.meta.url);
const STATUSES = new Set([
  "todo",
  "in_progress",
  "blocked",
  "implemented",
  "verified",
  "deferred",
  "unreviewed",
]);
const PRIORITIES = new Set(["P1", "P2", "P3"]);
const MAX_BODY_BYTES = 1_048_576;
const ASSETS = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/style.css", ["style.css", "text/css"]],
]);

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

function validateTask(task, ids) {
  if (!task || typeof task !== "object") throw failure(400, "Each task must be an object.");
  if (!Number.isInteger(task.lane) || task.lane < 1 || task.lane > 5)
    throw failure(400, "Task lane must be 1 through 5.");
  for (const key of [
    "id",
    "title",
    "taskIds",
    "owner",
    "details",
    "acceptance",
    "evidence",
    "blocker",
  ]) {
    if (typeof task[key] !== "string") throw failure(400, `Task field ${key} must be text.`);
  }
  if (!task.id.trim() || ids.has(task.id))
    throw failure(400, "Task IDs must be nonempty and unique.");
  if (!task.title.trim()) throw failure(400, "A task needs a title.");
  if (!STATUSES.has(task.status) || !PRIORITIES.has(task.priority))
    throw failure(400, "Unknown task status or priority.");
  if (task.status === "verified" && (!task.evidence.trim() || !task.acceptance.trim()))
    throw failure(400, "Verified tasks need acceptance criteria and supporting evidence.");
  ids.add(task.id);
}

/** Validate tracker structure and evidence requirements.
 *
 * Args:
 *   data: Parsed tracker document.
 *
 * Throws:
 *   Error: A field is invalid or a verified task lacks evidence.
 */
export function validateTracker(data) {
  if (!data || data.schemaVersion !== 1) throw failure(400, "Expected tracker schemaVersion 1.");
  if (!Array.isArray(data.lanes) || data.lanes.length !== 5)
    throw failure(400, "The tracker must contain all five lanes.");
  const laneIds = new Set();
  for (const lane of data.lanes) {
    if (!Number.isInteger(lane.id) || lane.id < 1 || lane.id > 5 || laneIds.has(lane.id))
      throw failure(400, "Lane IDs must be unique numbers from 1 through 5.");
    for (const key of ["name", "audit", "summary"]) {
      if (typeof lane[key] !== "string") throw failure(400, `Lane field ${key} must be text.`);
    }
    laneIds.add(lane.id);
  }
  if (!Array.isArray(data.tasks)) throw failure(400, "Expected a tasks array.");
  const ids = new Set();
  for (const task of data.tasks) validateTask(task, ids);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw failure(413, "Tracker exceeds the 1 MiB request limit.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw failure(400, "Invalid JSON. Reload the tracker and retry.");
  }
}

function version(bytes) {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(body);
}

/** Create the local tracker server without starting a listener.
 *
 * Args:
 *   options: Optional fixed dataPath for an isolated tracker file.
 *
 * Returns:
 *   HTTP server; callers must bind it to 127.0.0.1.
 */
export function createTrackerServer({ dataPath = new URL("tasks.json", ROOT) } = {}) {
  let writes = Promise.resolve();
  async function save(data, expected) {
    const current = await readFile(dataPath);
    if (expected !== version(current))
      throw failure(409, "The tracker changed elsewhere. Reload before saving your edits.");
    validateTracker(data);
    data.updatedAt = new Date().toISOString();
    const bytes = `${JSON.stringify(data, null, 2)}\n`;
    const temporary = `${dataPath instanceof URL ? fileURLToPath(dataPath) : dataPath}.${process.pid}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, dataPath);
    return { bytes, etag: version(bytes) };
  }
  async function handle(request, response) {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.headers.host !== new URL(origin).host) throw failure(403, "Invalid tracker host.");
    if (request.method === "PUT") {
      if (request.url !== "/api/tasks") throw failure(404, "Unknown tracker route.");
      if (request.headers.origin !== origin)
        throw failure(403, "Save from the tracker's own page.");
      if (request.headers["content-type"] !== "application/json")
        throw failure(415, "Use application/json to save tasks.");
      const data = await readBody(request);
      const result = writes.then(() => save(data, request.headers["if-match"]));
      writes = result.catch(() => {}); // Preserve queue availability; request error is handled below.
      const saved = await result;
      return send(response, 200, saved.bytes, { ETag: saved.etag });
    }
    if (request.method !== "GET") throw failure(405, "Only GET and PUT are supported.");
    if (request.url === "/api/tasks") {
      const bytes = await readFile(dataPath);
      return send(response, 200, bytes, { ETag: version(bytes) });
    }
    const asset = ASSETS.get(request.url);
    if (!asset) throw failure(404, "Unknown tracker route.");
    return send(response, 200, await readFile(new URL(asset[0], ROOT)), {
      "Content-Type": `${asset[1]}; charset=utf-8`,
      "Content-Security-Policy": "default-src 'self'; object-src 'none'; frame-ancestors 'none'",
    });
  }
  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (!error.status) process.stderr.write(`Tracker request failed: ${error.message}\n`);
      send(
        response,
        error.status ?? 500,
        JSON.stringify({
          error: error.status
            ? error.message
            : "Could not access tracker files. Check server output and file permissions.",
        }),
      );
    });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createTrackerServer();
  server.on("error", (error) => {
    process.stderr.write(`Cannot start lane tracker: ${error.message}. Check port 4319.\n`);
    process.exitCode = 1;
  });
  server.listen(4319, "127.0.0.1", () => {
    process.stdout.write(
      "Lane tracker: http://127.0.0.1:4319\nSaves: docs/lane-tracker/tasks.json\n",
    );
  });
  process.once("SIGINT", () => server.close());
  process.once("SIGTERM", () => server.close());
}
