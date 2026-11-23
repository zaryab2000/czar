// HEALTHCHECK probe for the Czar cloud images that serve HTTP (PM-013).
//
// The base image is node-slim, which has no curl and no wget, so the probe is
// Node itself. It takes one argument, the loopback URL to check, and exits 0 only
// on a 2xx answer. Every cloud container binds 127.0.0.1 only (SCR-170 §1), so
// the probe never leaves the container's network namespace.
//
// Nothing about the response is printed. A health response can carry build and
// state detail, and the logging allowlist (cross-cutting §4) does not cover
// container healthcheck output, so this writes a fixed word and the status code.
import process from "node:process";

const url = process.argv[2];
if (url === undefined) {
  process.stderr.write("usage: http-health.mjs <url>\n");
  process.exit(2);
}

const timeoutMs = Number(process.env["CZAR_HEALTHCHECK_TIMEOUT_MS"] ?? "2000");
const signal = AbortSignal.timeout(timeoutMs);

try {
  const response = await fetch(url, { signal, redirect: "manual" });
  if (response.ok) {
    process.stdout.write(`healthy ${response.status}\n`);
    process.exit(0);
  }
  process.stderr.write(`unhealthy ${response.status}\n`);
  process.exit(1);
} catch {
  // The reason is deliberately not echoed: a fetch error message can contain the
  // full URL with its query string, which must never be logged.
  process.stderr.write("unhealthy unreachable\n");
  process.exit(1);
}
