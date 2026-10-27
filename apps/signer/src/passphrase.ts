// Keystore passphrase sources (D78): the macOS keychain item read by this process, or an interactive
// prompt on the controlling terminal. Never argv, environment variables or files; the signer refuses to
// start when either carries something that looks like one (`signer_passphraseFromArgvOrEnv_rejected`).
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { SECRET_NAME_FRAGMENTS } from "@czar/config";

export interface PassphraseSource {
  readonly kind: "keychain" | "prompt";
  read(): Promise<string>;
}

export class PassphraseError extends Error {
  readonly rule: string;
  constructor(rule: string, message: string) {
    super(message);
    this.rule = rule;
    this.name = "PassphraseError";
  }
}

const ARGV_WORDS = [...SECRET_NAME_FRAGMENTS, "password", "passwd", "keystore-pass"];

/** Throws when argv or the environment could be carrying a secret. Names only are reported, never values. */
export function assertNoSecretInProcess(
  argv: readonly string[] = process.argv,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  for (const arg of argv.slice(2)) {
    const lower = arg.toLowerCase();
    if (ARGV_WORDS.some((word) => lower.includes(word)))
      throw new PassphraseError(
        "secret-in-argv",
        "refusing to start: a command-line argument looks like a secret (D78)",
      );
  }
  for (const name of Object.keys(env)) {
    const lower = name.toLowerCase();
    const czar = lower.startsWith("czar_") && SECRET_NAME_FRAGMENTS.some((f) => lower.includes(f));
    if (czar || lower.includes("passphrase") || lower.includes("mnemonic"))
      throw new PassphraseError(
        "secret-in-env",
        `refusing to start: environment variable ${name} looks like a secret (D78)`,
      );
  }
}

/** Account name of the keychain item under `signer.keychainService`. */
export const KEYCHAIN_ACCOUNT = "keystore";

export interface KeychainEntry {
  getPassword(): string | null | undefined;
  setPassword(password: string): void;
}
export type KeychainOpen = (
  service: string,
  account: string,
) => KeychainEntry | Promise<KeychainEntry>;

const napiKeychain: KeychainOpen = async (service, account) => {
  const { Entry } = await import("@napi-rs/keyring");
  return new Entry(service, account);
};

export function keychainPassphrase(
  service: string,
  open: KeychainOpen = napiKeychain,
): PassphraseSource {
  return {
    kind: "keychain",
    async read() {
      let value: string | null | undefined;
      try {
        value = (await open(service, KEYCHAIN_ACCOUNT)).getPassword();
      } catch {
        throw new PassphraseError(
          "keychain-denied",
          "the keychain refused to release the keystore passphrase",
        );
      }
      if (value === null || value === undefined || value === "")
        throw new PassphraseError("keychain-missing", `no keychain item ${service}`);
      return value;
    },
  };
}

/** Reads a passphrase from the terminal with echo off. Refuses when stdin is not a TTY (no piping). */
export function promptPassphrase(
  question = "Keystore passphrase: ",
  io: { input: NodeJS.ReadStream; output: NodeJS.WriteStream } = {
    input: process.stdin,
    output: process.stderr,
  },
): PassphraseSource {
  return {
    kind: "prompt",
    read() {
      if (io.input.isTTY !== true)
        return Promise.reject(
          new PassphraseError("no-tty", "the passphrase prompt needs a terminal"),
        );
      io.output.write(question);
      const muted = new Writable({ write: (_chunk, _encoding, next) => next() });
      const rl = createInterface({ input: io.input, output: muted, terminal: true });
      return new Promise((done) => {
        rl.question("", (answer) => {
          rl.close();
          io.output.write("\n");
          done(answer);
        });
      });
    },
  };
}
