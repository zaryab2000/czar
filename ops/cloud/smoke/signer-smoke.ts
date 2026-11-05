// Smoke-run wrapper for the signer's cloud entry (PM-014). Test code only.
//
// It calls the real `startCloudSigner`: the gcp-kms backend, the real database pool as czar_signer,
// the file-based socket identity and the real socket with signer.socketGroupGid. Cloud KMS and the
// metadata server are the loopback fake (ops/cloud/smoke/kms-fake.ts), reached through the config
// keys signer.kms.apiBaseUrl and deploy.metadataTokenUrl. As in server-smoke.ts, the RPC pointer
// stays https://rpc.testnet.arc.io for the guard and the injected chain client talks to arc-anvil.
import { installLoopbackTripwire } from "./tripwire.ts";
import { importFrom } from "./resolve-from.ts";

installLoopbackTripwire();

const anvilUrl = process.env["CZAR_SMOKE_ANVIL_URL"];
if (anvilUrl === undefined || new URL(anvilUrl).hostname !== "127.0.0.1")
  throw new Error("CZAR_SMOKE_ANVIL_URL must be the loopback arc-anvil");

type Viem = typeof import("viem");
const viem = await importFrom<Viem>("signer", "viem");
const { startCloudSigner } = await import("../../../apps/signer/src/cloud-main.ts");

const running = await startCloudSigner({
  chain: viem.createPublicClient({ transport: viem.http(anvilUrl) }),
});
process.stderr.write(
  `signer-smoke: socket up, chain ${running.chainId}, ${running.keyRefs.length} key(s)\n`,
);
const stop = () => void running.stop();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
