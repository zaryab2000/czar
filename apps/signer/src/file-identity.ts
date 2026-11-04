// Signer socket tokens as files (SCR-170 §4). In the cloud there is no keychain: each client reads its
// token from `<deploy.credentialFilesDir>/<service>/signer-token` and the signer reads the expected
// tokens from `<deploy.credentialFilesDir>/signer/client-tokens/<service>`. The files are mode 0400 and
// owned by the process that reads them; a token is never a configuration value, a command-line argument
// or an environment variable (D70, D78). The keychain identity stays the local default.
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SOCKET_SERVICES, type SignerSocketIdentity } from "./socket.ts";

/** The shortest token the signer accepts, as for the keychain tokens (`socket.ts`). */
const MIN_TOKEN_LENGTH = 32;

export interface FileSignerIdentityOptions {
  /**
   * The services whose tokens `load()` reads. The signer reads all of them; a client passes its own
   * service only, because it can see no other service's folder.
   */
  readonly services?: readonly string[];
  /**
   * A file name inside `<dir>/<service>/` instead of the file `<dir>/<service>`. A client passes
   * `signer-token`, so one function serves both SCR-170 §4 paths.
   */
  readonly fileName?: string;
}

/**
 * Reads signer socket tokens from `<dir>/<service>` (or `<dir>/<service>/<fileName>`). Refuses a token
 * that is not a plain file, is readable by the group or others, or is shorter than 32 characters.
 */
export function fileSignerIdentity(
  dir: string,
  options: FileSignerIdentityOptions = {},
): SignerSocketIdentity {
  const services = options.services ?? SOCKET_SERVICES;
  const tokens = new Map<string, string>();
  const pathFor = (service: string) =>
    options.fileName === undefined ? join(dir, service) : join(dir, service, options.fileName);

  const read = async (service: string): Promise<string> => {
    const path = pathFor(service);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(path);
    } catch {
      throw new Error(`signer token file unavailable for ${service}`);
    }
    if (!stat.isFile()) throw new Error(`signer token for ${service} is not a plain file`);
    // Mode 0400 (SCR-170 §4): anything the group or others can reach is refused.
    if ((stat.mode & 0o077) !== 0)
      throw new Error(`signer token for ${service} is group- or world-accessible`);
    const token = (await readFile(path, "utf8")).trim();
    if (token.length < MIN_TOKEN_LENGTH)
      throw new Error(`signer token missing or too short for ${service}`);
    return token;
  };

  return {
    async load() {
      await Promise.all(
        services.map(async (service) => {
          tokens.set(service, await read(service));
        }),
      );
    },
    async tokenFor(service) {
      if (!services.includes(service)) return undefined;
      const cached = tokens.get(service);
      if (cached !== undefined) return cached;
      const token = await read(service);
      tokens.set(service, token);
      return token;
    },
  };
}
