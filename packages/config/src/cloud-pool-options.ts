import { readFile } from "node:fs/promises";

/** The discrete fields a cloud service hands to its node-postgres pool. */
export interface CloudPoolOptions {
  readonly host: string;
  readonly port?: number;
  readonly database: string;
  readonly user: string;
  readonly password: () => Promise<string>;
}

/**
 * The pool options for a cloud database URL that carries no password (SCR-170 §4). The password is
 * read from its credential file at each connection, so a rotated secret takes effect on the next
 * one and the password is never a URL, a parameter or a variable.
 *
 * The URL is split into fields, and the pool is never given a `connectionString`: node-postgres
 * parses that string over the options, and a URL with no password writes `password: null` over the
 * password function. The server then refuses the login with "client password must be a string".
 */
export function cloudPoolOptions(url: URL, passwordFile: string): CloudPoolOptions {
  return {
    host: url.hostname,
    ...(url.port === "" ? {} : { port: Number(url.port) }),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: async () => (await readFile(passwordFile, "utf8")).trim(),
  };
}
