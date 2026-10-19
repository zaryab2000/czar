// Name rules: the CZAR_<SECTION>_<KEY> overlay and the secret-name denylist (cross-cutting §3.2, D78).

export const ENV_PREFIX = "CZAR_";

/** A key or CZAR_* variable whose name contains one of these refuses to load (D78, RV-028). */
export const SECRET_NAME_FRAGMENTS = [
  "passphrase",
  "secret",
  "private",
  "mnemonic",
  "seed",
] as const;

export function hasSecretLikeName(name: string): boolean {
  const lower = name.toLowerCase();
  return SECRET_NAME_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/**
 * `daemon.hookPort` → `CZAR_DAEMON_HOOK_PORT`; `signer.gas.K3.minAtomic` → `CZAR_SIGNER_GAS_K3_MIN_ATOMIC`;
 * `models.soul-compiler.timeoutMs` → `CZAR_MODELS_SOUL_COMPILER_TIMEOUT_MS`.
 */
export function envVarName(key: string): string {
  const words = key
    .split(/[.-]/)
    .flatMap((segment) => segment.replace(/([a-z0-9])([A-Z])/g, "$1_$2").split("_"))
    .filter((word) => word.length > 0);
  return ENV_PREFIX + words.join("_").toUpperCase();
}
