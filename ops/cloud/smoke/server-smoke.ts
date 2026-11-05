// Smoke-run wrapper for the server's cloud entry (PM-014). Test code only.
//
// It calls the real `startCloudServer` with the real cloud parameter file, the real database pool
// (URL pointer without a password, password from the credential file) and the real HTTP server.
// The one difference from production is the chain client: the cloud guard requires every RPC URL to
// be https://rpc.testnet.arc.io, and the smoke run must not contact Arc testnet, so the pointer
// stays the testnet URL (the guard runs unchanged) while the injected viem clients talk to a local
// arc-anvil at CZAR_SMOKE_ANVIL_URL. This is the same injection PM-059's tests use; nothing in
// apps/ or packages/ knows about it.
import { installLoopbackTripwire } from "./tripwire.ts";
import { importFrom } from "./resolve-from.ts";

installLoopbackTripwire();

const anvilUrl = process.env["CZAR_SMOKE_ANVIL_URL"];
if (anvilUrl === undefined || new URL(anvilUrl).hostname !== "127.0.0.1")
  throw new Error("CZAR_SMOKE_ANVIL_URL must be the loopback arc-anvil");

type Viem = typeof import("viem");
const viem = await importFrom<Viem>("server", "viem");
const { startCloudServer } = await import("../../../apps/server/src/cloud-main.ts");

const running = await startCloudServer({
  publicClient: viem.createPublicClient({ transport: viem.http(anvilUrl) }),
  walletClient: viem.createWalletClient({ transport: viem.http(anvilUrl) }),
});
process.stderr.write(`server-smoke: listening, chain ${running.chainId}\n`);
const stop = () => void running.stop();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
