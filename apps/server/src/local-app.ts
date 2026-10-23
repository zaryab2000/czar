import { createApp, type AppDependencies } from "#src/app";
import { createPublicClient, http } from "viem";
import { createFileObjectStore } from "#src/object-store";

type LocalAppOptions = Omit<AppDependencies, "jobDelivery"> & {
  readonly rpcUrl: string;
  readonly objectStorePath: string;
};

/** Construct the local application with authenticated job delivery and persistent storage.
 *
 * Args:
 *   options: App dependencies, local RPC URL and object-store directory.
 *
 * Returns:
 *   Application with job brief and deliverable routes configured.
 */
export function createLocalApp(options: LocalAppOptions) {
  const { rpcUrl, objectStorePath, ...dependencies } = options;
  return createApp({
    ...dependencies,
    jobDelivery: {
      pool: dependencies.pool,
      config: dependencies.config,
      now: dependencies.clock.now,
      publicClient: createPublicClient({ transport: http(rpcUrl) }),
      objectStore: createFileObjectStore(objectStorePath),
    },
  });
}
