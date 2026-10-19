// Startup errors raised by the config loader. Messages name keys only, never values.

export class ConfigError extends Error {
  readonly code:
    | "unknown-key"
    | "secret-like-name"
    | "read-only"
    | "invalid-value"
    | "missing-value";
  readonly key: string;

  constructor(code: ConfigError["code"], key: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.key = key;
  }
}
