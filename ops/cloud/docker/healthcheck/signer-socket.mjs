// HEALTHCHECK probe for the Czar signer image (PM-013).
//
// The signer serves no HTTP port: its only interface is a unix socket
// (`signer.socketPath`, "local IPC, no TCP port"). So the probe is the same check
// the local stack's readiness probe makes — the socket exists and is a socket —
// with the path read from the cloud config rather than hard-coded, because the
// registry default is a macOS path and the cloud VM's is not.
//
// The config file is found through the CZAR_CLOUD_CONFIG pointer, which is how
// every cloud entry point finds it (SCR-170 §3). A pointer may come from the
// environment; a secret never may (SCR-170 §4), and this reads no secret.
//
// The path itself is never printed: file paths are not in the logging allowlist
// (cross-cutting §4).
import { statSync } from "node:fs";
import process from "node:process";
import { loadConfigFile, parameterEnvironment } from "@czar/config";

const pointer = process.env["CZAR_CLOUD_CONFIG"];
if (pointer === undefined || pointer === "") {
  process.stderr.write("unhealthy no-config-pointer\n");
  process.exit(1);
}

try {
  const config = await loadConfigFile(pointer, { env: parameterEnvironment(process.env) });
  const socketPath = config.get("signer.socketPath");
  if (typeof socketPath !== "string" || socketPath === "") {
    process.stderr.write("unhealthy no-socket-path\n");
    process.exit(1);
  }
  if (!statSync(socketPath).isSocket()) {
    process.stderr.write("unhealthy not-a-socket\n");
    process.exit(1);
  }
  process.stdout.write("healthy socket\n");
  process.exit(0);
} catch {
  // Not echoed: the message would carry the config file path or the socket path.
  process.stderr.write("unhealthy unreachable\n");
  process.exit(1);
}
